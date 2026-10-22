import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LabelStore } from '../scorers/label-store.js';
import type { LocalConfig } from '../types.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../workflow/engine.js';
import { workflowRunDetail } from '../dashboard/workflow-runs.js';
import { buildEndRecord } from '../workflow/records.js';
import { projectRun } from '../workflow/snapshot.js';
import { nextJudgeLease, parseJudgeRequest, parseJudgeSubmission, scoredPasses, submitJudgeLease, type JudgeRequest } from '../workflow/scoring.js';
import { installOwner, readRun } from '../workflow/store.js';
import type { DriverIdentity, RunState, WorkflowEnvelope } from '../workflow/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const scorer = (samplingRate: number, isolation = '') => `---
labels:
  - { value: good, score: 1, description: Finds the real defects }
  - { value: missed, score: 0, description: Misses a real defect }
passingScore: 0.5
samplingRate: ${samplingRate}
${isolation}---
Judge the review.
`;

const WORKFLOW = `schemaVersion: v1alpha1
name: review
description: One reviewed step.
steps:
  - id: review
    prompt: Review the change.
    scorers: [quality, nope]
`;

function fixture(scorerText: string, overrides: Partial<LocalConfig> = {}): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-scoring-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  fs.writeFileSync(path.join(knowledge, 'workflows', 'review.yaml'), WORKFLOW);
  fs.writeFileSync(path.join(knowledge, 'scorers', 'quality.md'), scorerText);
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data'),
    ...overrides,
  };
}

const workDriver: DriverIdentity = { kind: 'external', machine: 'm1', workspace: '/w' };
const judgeDriver = { kind: 't3', machine: 'm1', workspace: '/w' };
const request = (overrides: Partial<JudgeRequest> = {}): JudgeRequest => ({
  driver: judgeDriver, judge: { isolation: 'verified', tools: ['claude'] }, running: [], ...overrides,
});

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

const LeaseSchema = z.object({ ref: z.string(), evidence: z.string(), prompt: z.string(), expiresAt: z.string() }).passthrough();

function leaseOf(envelope: WorkflowEnvelope): z.infer<typeof LeaseSchema> {
  return LeaseSchema.parse(data(envelope).lease);
}

async function runOf(config: LocalConfig, runId: string): Promise<RunState> {
  const run = await readRun(config, runId);
  if (typeof run !== 'object') throw new Error(`run ${runId} is ${run}`);
  return run;
}

/** Starts the review workflow and settles its one step through workflow next and report, as an external driver would. */
async function settledRun(config: LocalConfig): Promise<string> {
  await syncWorkflowDefinitions(config);
  const runId = String(data(await startRun(config, 'review')).run);
  const lease = z.object({ attempt: z.string(), revision: z.number() }).parse(data(await leaseNext(config, runId, workDriver)).lease);
  data(await reportAttempt(config, runId, { attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver: workDriver, outputs: { reviewed: true } }));
  expect(data(await leaseNext(config, runId, workDriver))).toMatchObject({ done: { outcome: 'succeeded' } });
  return runId;
}

describe('judge work', () => {
  it('pins the scorers a run lists at start, skipping one with no valid file', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const run = await runOf(config, runId);
    expect(Object.keys(run.scorers ?? {})).toEqual(['quality']);
    expect(run.steps[0]).toMatchObject({ installId: (await installOwner(config)).id });
  });

  it('records the access the driver declares for its judge, full when it declares none', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const undeclared = parseJudgeRequest({ driver: { ...judgeDriver, can: { judge: { isolation: 'verified', tools: ['claude'] } } } });
    if (typeof undeclared === 'string') throw new Error(undeclared);
    expect(leaseOf(await nextJudgeLease(config, undeclared))).toMatchObject({ judge: { access: 'full' } });

    const other = { ...judgeDriver, machine: 'm2' };
    const answering = parseJudgeRequest({ driver: { ...other, can: { judge: { isolation: 'verified', access: 'answer', tools: ['claude'] } } } });
    if (typeof answering === 'string') throw new Error(answering);
    const runId = await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, answering));
    expect(lease).toMatchObject({ subject: { runId }, judge: { access: 'answer' } });
    data(await submitJudgeLease(config, lease.ref, { driver: other, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }));
    const labels = fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(labels).toEqual([expect.objectContaining({ subject: expect.objectContaining({ runId }), judge: expect.objectContaining({ access: 'answer' }) })]);
    expect(parseJudgeRequest({ driver: { ...other, can: { judge: { isolation: 'verified', access: 'write', tools: ['claude'] } } } })).toContain('driver.can.judge.access');
  });

  it('leases a sampled pass of a settled run, refuses a label the scorer lacks, and records the right one', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const before = fs.readFileSync(path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`), 'utf8');

    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(lease).toMatchObject({
      scorer: 'quality',
      subject: { runId, step: 'review', pass: 1 },
      judge: { tools: ['claude'], isolation: 'verified', access: 'full' },
      answer: { schema: { properties: { label: { enum: ['good', 'missed'] } } } },
      submit: `teamai score --lease ${lease.ref} --submit --stdin`,
    });
    expect(JSON.parse(fs.readFileSync(path.join(lease.evidence, 'evidence.json'), 'utf8'))).toEqual({
      subject: { runId, step: 'review', pass: 1 }, kind: 'prompt', ranges: [], gaps: ['no_recorded_range', 'transcript_not_found'],
    });
    expect(fs.readFileSync(lease.prompt, 'utf8')).toContain('Judge the review.');

    const bad = await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'great', reasoning: 'r' } });
    expect(bad).toMatchObject({ error: { code: 'label_invalid' } });
    // The lease stays open: the same driver gets it back.
    expect(data(await nextJudgeLease(config, request())).lease).toMatchObject({ ref: lease.ref, handedBack: true });

    const good = data(await submitJudgeLease(config, lease.ref, {
      driver: judgeDriver, outcome: 'success', answer: { label: 'missed', reasoning: 'It skipped the race.' },
      judge: { tool: 'claude', model: 'm1', usage: { inputTokens: 10, outputTokens: 2 } },
    }));
    expect(good).toMatchObject({ label: { scorer: 'quality', label: 'missed', score: 0, passed: false } });
    const labels = fs.readFileSync(path.join(config.dataHome ?? '', 'scores', 'labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(labels).toEqual([expect.objectContaining({
      scorer: 'quality', label: 'missed', score: 0, passed: false, source: 'workflow', subject: { runId, step: 'review', pass: 1 },
      judge: { kind: 'model', tool: 'claude', model: { reported: 'm1' }, usage: { inputTokens: 10, outputTokens: 2 }, isolation: 'verified', access: 'full' },
    })]);
    expect(fs.existsSync(lease.evidence)).toBe(false);
    // A repeated submit answers the same label; nothing is left to judge.
    expect(data(await submitJudgeLease(config, lease.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'x' } }))).toEqual(good);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
    // Scoring never writes the run file.
    expect(fs.readFileSync(path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`), 'utf8')).toBe(before);
  });

  it('refuses a lapsed lease once a later lease of the same pass labelled it, and replays the later lease\'s own verdict', async () => {
    const config = fixture(scorer(100));
    const start = Date.parse((await runOf(config, await settledRun(config))).updatedAt);
    const minutes = (count: number) => new Date(start + count * 60 * 1000).toISOString();
    const second = { ...judgeDriver, machine: 'm2' };
    const first = leaseOf(await nextJudgeLease(config, request(), minutes(0)));
    const replaced = leaseOf(await nextJudgeLease(config, request({ driver: second }), minutes(31)));
    const answer = { driver: second, outcome: 'success' as const, answer: { label: 'good', reasoning: 'Found the race.' } };
    const settled = data(await submitJudgeLease(config, replaced.ref, answer, minutes(32)));
    expect(await submitJudgeLease(config, first.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'missed', reasoning: 'Missed it.' } }, minutes(33)))
      .toMatchObject({ error: { code: 'lease_expired' } });
    expect((await LabelStore.local(config)).map((label) => label.label)).toEqual(['good']);

    const replay = data(await submitJudgeLease(config, replaced.ref, answer, minutes(34)));
    expect(replay).toEqual(settled);
    const reasoning = z.object({ label: z.object({ reasoning: z.string() }) }).parse(replay).label.reasoning;
    expect(fs.readFileSync(reasoning, 'utf8')).toContain('Found the race.');
  });

  it('never hands judge work to workflow next, and workflow report refuses a judge ref', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request()));
    expect(data(await leaseNext(config, runId, workDriver))).toEqual(expect.objectContaining({ done: expect.anything() }));
    expect(await reportAttempt(config, runId, { attempt: lease.ref, revision: 1, outcome: 'success', driver: workDriver, outputs: { reviewed: true } }))
      .toMatchObject({ error: { code: 'judge_lease', message: expect.stringContaining(`teamai score --lease ${lease.ref} --submit`) } });
  });

  it('offers nothing at samplingRate 0', async () => {
    const config = fixture(scorer(0));
    await settledRun(config);
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
  });

  it('leases a verified scorer only to a verified judge', async () => {
    const config = fixture(scorer(100, 'isolation: verified\n'));
    await settledRun(config);
    expect(data(await nextJudgeLease(config, request({ judge: { isolation: 'best-effort', tools: ['codex'] } })))).toEqual({ idle: { open: 1, leased: 0 } });
    expect(data(await nextJudgeLease(config, request()))).toHaveProperty('lease');
  });

  it('releases a lease its driver can no longer judge as leased, on hand-back and on renewal', async () => {
    const config = fixture(scorer(100, 'isolation: verified\n'));
    await settledRun(config);
    const downgraded = request({ judge: { isolation: 'best-effort', tools: ['codex'] } });
    const handedBack = leaseOf(await nextJudgeLease(config, request()));
    expect(data(await nextJudgeLease(config, downgraded))).toEqual({ idle: { open: 1, leased: 0 } });
    expect(await submitJudgeLease(config, handedBack.ref, { driver: judgeDriver, outcome: 'success', answer: { label: 'good', reasoning: 'r' } }))
      .toMatchObject({ error: { code: 'lease_settled' } });

    const renewed = leaseOf(await nextJudgeLease(config, request()));
    expect(renewed.ref).not.toBe(handedBack.ref);
    expect(data(await nextJudgeLease(config, { ...downgraded, running: [renewed.ref] }))).toEqual({ idle: { open: 1, leased: 0 } });
    expect(leaseOf(await nextJudgeLease(config, request())).ref).not.toBe(renewed.ref);
  });

  it('renews a lease the driver lists in running and hands another driver nothing while it is live', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const lease = leaseOf(await nextJudgeLease(config, request(), '2026-10-22T12:00:00.000Z'));
    expect(lease.expiresAt).toBe('2026-10-22T12:30:00.000Z');
    expect(data(await nextJudgeLease(config, request({ running: [lease.ref] }), '2026-10-22T12:20:00.000Z'))).toEqual({ idle: { open: 0, leased: 1 } });
    const other = { kind: 't3', machine: 'm2', workspace: '/w' };
    expect(data(await nextJudgeLease(config, request({ driver: other }), '2026-10-22T12:45:00.000Z'))).toEqual({ idle: { open: 0, leased: 1 } });
    expect(data(await nextJudgeLease(config, request({ driver: other }), '2026-10-22T12:51:00.000Z')).lease).not.toMatchObject({ ref: lease.ref });
  });

  it('renews a lease taken just before its run leaves the entry window', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const closes = Date.parse(run.updatedAt) + 14 * 24 * 60 * 60 * 1000;
    const at = (ms: number) => new Date(closes + ms).toISOString();
    const lease = leaseOf(await nextJudgeLease(config, request(), at(-1000)));
    expect(data(await nextJudgeLease(config, request({ running: [lease.ref] }), at(1000)))).toEqual({ idle: { open: 0, leased: 1 } });
    expect(leaseOf(await nextJudgeLease(config, request(), at(30 * 60 * 1000)))).toMatchObject({ ref: lease.ref, expiresAt: at(1000 + 30 * 60 * 1000), handedBack: true });
  });

  it('refuses a submit once the work it was for has closed', async () => {
    const answer = { driver: judgeDriver, outcome: 'success' as const, answer: { label: 'good', reasoning: 'late' } };
    const labels = (config: LocalConfig) => path.join(config.dataHome ?? '', 'scores', 'labels.jsonl');
    const lapsed = fixture(scorer(100));
    const start = Date.parse((await runOf(lapsed, await settledRun(lapsed))).updatedAt);
    const minutes = (count: number) => new Date(start + count * 60 * 1000).toISOString();
    let lease = leaseOf(await nextJudgeLease(lapsed, request(), minutes(0)));
    for (const count of [31, 62, 93]) lease = leaseOf(await nextJudgeLease(lapsed, request(), minutes(count)));
    expect(data(await nextJudgeLease(lapsed, request(), minutes(124)))).toEqual({ idle: { open: 0, leased: 0 } });
    expect(await submitJudgeLease(lapsed, lease.ref, answer, minutes(125))).toMatchObject({ error: { code: 'entry_closed', message: expect.stringContaining('lease_expired') } });
    expect(fs.existsSync(labels(lapsed))).toBe(false);

    const old = fixture(scorer(100));
    const closes = Date.parse((await runOf(old, await settledRun(old))).updatedAt) + 14 * 24 * 60 * 60 * 1000;
    const kept = leaseOf(await nextJudgeLease(old, request(), new Date(closes - 1000).toISOString()));
    expect(await submitJudgeLease(old, kept.ref, answer, new Date(closes + 31 * 60 * 1000).toISOString())).toMatchObject({ error: { code: 'entry_closed' } });
    expect(fs.existsSync(labels(old))).toBe(false);
  });

  it('offers nothing while the project keeps its data inside the repository', async () => {
    const config = fixture(scorer(100));
    await settledRun(config);
    const inRepo = path.join(config.projectRoot ?? '', '.teamai');
    fs.renameSync(config.dataHome ?? '', inRepo);
    const legacy: LocalConfig = { ...config, repo: { ...config.repo, kind: 'git' }, dataHome: inRepo };
    expect(data(await nextJudgeLease(legacy, request()))).toEqual({ idle: { open: 0, leased: 0 } });
    // The same data in self mode, whose .teamai is team knowledge and not the data home rule, is offered.
    expect(data(await nextJudgeLease({ ...legacy, repo: config.repo }, request()))).toHaveProperty('lease');
  });

  it('refuses a submission whose usage is not a finite number', () => {
    const payload: unknown = JSON.parse('{"driver":{"kind":"t3","machine":"m1","workspace":"/w"},"outcome":"success","answer":{"label":"good","reasoning":"r"},"judge":{"usage":{"inputTokens":1e309}}}');
    expect(parseJudgeSubmission(payload)).toMatch(/^judge\.usage\.inputTokens: /);
  });
});

describe('scoring totals', () => {
  /** Settles a run at `samplingRate`, judges whatever is offered with a released then a labelled attempt, and returns its end record. */
  async function judgedRun(samplingRate: number) {
    const config = fixture(scorer(samplingRate));
    const runId = await settledRun(config);
    const usage = { inputTokens: 1000, outputTokens: 50 };
    for (const outcome of ['released', 'success'] as const) {
      const lease = LeaseSchema.optional().parse(data(await nextJudgeLease(config, request())).lease);
      if (!lease) break;
      data(await submitJudgeLease(config, lease.ref, outcome === 'success'
        ? { driver: judgeDriver, outcome, judge: { tool: 'claude', usage }, answer: { label: 'good', reasoning: 'Quokka-marmalade verdict.' } }
        : { driver: judgeDriver, outcome, judge: { tool: 'claude', usage } }));
    }
    const run = await runOf(config, runId);
    const { stepCounts, iterations, failure, steps } = buildEndRecord(run, workDriver, 'tester');
    return { config, runId, totals: { stepCounts, iterations, failure, tokens: steps?.map((step) => step.tokens) } };
  }

  it('leaves a run\'s counts, iterations, failure and work tokens as they are at samplingRate 0', async () => {
    const sampled = await judgedRun(100);
    const unsampled = await judgedRun(0);
    expect(sampled.totals).toEqual(unsampled.totals);

    const detail = await workflowRunDetail(sampled.config, 'local', sampled.runId);
    expect(detail?.steps).toEqual([expect.objectContaining({ step: 'review', pass: 1, scores: [{ scorer: 'quality', label: 'good', passed: true }] })]);
    expect(detail?.scoring).toEqual({ judged: 2, inputTokens: 2000, outputTokens: 100 });
    expect(JSON.stringify(detail)).not.toContain('Quokka-marmalade');
    expect((await workflowRunDetail(unsampled.config, 'local', unsampled.runId))?.scoring).toEqual({ judged: 0, inputTokens: 0, outputTokens: 0 });
  });
});

describe('scoredPasses', () => {
  it('keeps only the passes this install settled, and attributes archived children to the workflow pass that held them', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const install = (await installOwner(config)).id;
    expect(scoredPasses(run, install)).toEqual([{ subject: { runId: run.id, step: 'review', pass: 1 }, scorers: ['quality'] }]);
    expect(scoredPasses(run, 'another-install')).toEqual([]);
    const unstamped = structuredClone(run);
    for (const step of unstamped.steps) if ('installId' in step) delete step.installId;
    expect(scoredPasses(unstamped, install)).toEqual(scoredPasses(run, install));
    expect(scoredPasses({ ...unstamped, publication: { stateRevision: 1 } }, install)).toEqual([]);

    const nested: RunState = {
      ...run,
      definition: { ...run.definition, steps: [{ id: 'check', scorers: { names: ['quality'] }, workflow: { steps: [{ id: 'review', prompt: 'p' }] } }] },
      steps: [{ id: 'check', status: 'succeeded', outcome: 'success', settledAt: 3, pass: 2 }],
      archive: [{ step: 'check.review', pass: 1, outcome: 'success', installId: 'elsewhere', within: { step: 'check', pass: 1 } }],
    };
    expect(scoredPasses(nested, install)).toEqual([{ subject: { runId: run.id, step: 'check', pass: 2 }, scorers: ['quality'] }]);
    expect(scoredPasses({ ...nested, archive: [{ ...nested.archive?.[0], step: 'check.review', pass: 1, outcome: 'success', installId: install, within: { step: 'check', pass: 2 } }] }, 'elsewhere')).toEqual([]);
  });

  it('gives a workflow pass to the install that settled its first child pass, archived before a live one another install settled', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const looped: RunState = {
      ...run,
      definition: { ...run.definition, steps: [{ id: 'check', scorers: { names: ['quality'] }, workflow: { steps: [{ id: 'review', prompt: 'p' }] } }] },
      steps: [
        { id: 'check', status: 'succeeded', outcome: 'success', settledAt: 3 },
        { id: 'check.review', status: 'succeeded', outcome: 'success', settledAt: 2, pass: 2, installId: 'install-b' },
      ],
      archive: [{ step: 'check.review', pass: 1, outcome: 'success', installId: 'install-a', within: { step: 'check', pass: 1 } }],
      publication: { stateRevision: 1 },
    };

    expect(scoredPasses(looped, 'install-a')).toEqual([{ subject: { runId: run.id, step: 'check', pass: 1 }, scorers: ['quality'] }]);
    expect(scoredPasses(looped, 'install-b')).toEqual([]);
  });

  it('offers a handed-over workflow pass to the install that settled a prompt pass a nested loop archived', async () => {
    const config = fixture(scorer(100));
    const runId = await settledRun(config);
    const run = await runOf(config, runId);
    const install = (await installOwner(config)).id;
    const looped: RunState = {
      ...run,
      definition: { ...run.definition, steps: [{ id: 'check', scorers: { names: ['quality'] }, workflow: { steps: [{ id: 'inner', workflow: { steps: [{ id: 'review', prompt: 'p' }] } }] } }] },
      steps: [
        { id: 'check', status: 'succeeded', outcome: 'success', settledAt: 6 },
        { id: 'check.inner', status: 'succeeded', outcome: 'success', settledAt: 5, pass: 2, passes: [{ pass: 1, outcome: 'success' }] },
        { id: 'check.inner.review', status: 'skipped', settledAt: 4, pass: 2 },
      ],
      archive: [{ step: 'check.inner.review', pass: 1, outcome: 'success', installId: install, within: { step: 'check.inner', pass: 1 } }],
      publication: { stateRevision: 1 },
    };
    fs.writeFileSync(path.join(config.dataHome ?? '', 'workflows', 'runs', `${runId}.json`), JSON.stringify(looped));

    expect(scoredPasses(looped, install)).toEqual([{ subject: { runId, step: 'check', pass: 1 }, scorers: ['quality'] }]);
    expect(scoredPasses(looped, 'elsewhere')).toEqual([]);
    // Taken here, then closed: the hand-built pass recorded nothing to judge.
    expect(data(await nextJudgeLease(config, request()))).toEqual({ idle: { open: 0, leased: 0 } });
  });

  it('scores the items of a for_each step, never the step that fans them out', async () => {
    const config = fixture(scorer(100));
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'review.yaml'), WORKFLOW.replace('    scorers:', "    for_each: '[]'\n    scorers:"));
    await syncWorkflowDefinitions(config);
    const runId = String(data(await startRun(config, 'review')).run);
    expect(data(await leaseNext(config, runId, workDriver))).toMatchObject({ done: { outcome: 'succeeded' } });
    const install = (await installOwner(config)).id;
    const run = await runOf(config, runId);
    expect(scoredPasses(run, install)).toEqual([]);

    const items: RunState = {
      ...run,
      steps: [
        { id: 'review', status: 'succeeded', outcome: 'success', settledAt: 3 },
        { id: 'review[0]', status: 'succeeded', outcome: 'success', settledAt: 2, item: 'a', installId: install },
        { id: 'review[1]', status: 'succeeded', outcome: 'success', settledAt: 2, item: 'b', installId: install },
      ],
    };
    expect(scoredPasses(items, install).map(({ subject }) => subject.step)).toEqual(['review[0]', 'review[1]']);
  });
});

describe('run snapshot', () => {
  it('publishes the pinned scorers by hash only, and the install and within stamps as they are', async () => {
    const config = fixture(scorer(100));
    const run = await runOf(config, await settledRun(config));
    const projected = projectRun({ ...run, archive: [{ step: 'x.y', pass: 1, outcome: 'success', within: { step: 'x', pass: 1 } }] }, {});
    if (!projected.ok) throw new Error(projected.error.message);
    expect(projected.value.scorers).toEqual({ quality: { sourceHash: run.scorers?.quality?.sourceHash } });
    expect(JSON.stringify(projected.value)).not.toContain('Judge the review.');
    expect(projected.value.steps[0]).toMatchObject({ installId: (await installOwner(config)).id });
    expect(projected.value.archive[0]).toMatchObject({ within: { step: 'x', pass: 1 } });
  });
});
