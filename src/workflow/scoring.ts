/**
 * Judge work for workflow passes (#1085). Nothing is queued: open work is computed from the run files, the scorers each
 * run pinned, the label store and the attempt store on every `teamai score --next`. The engine never calls this module,
 * and this module never writes a run file, so scoring cannot move a run's counts, tokens, failure or end time.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema } from '../driver-identity.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import {
  AttemptStore, newAttemptId, scoresDir, type AttemptRecord, type JudgeDriver, type LeasedAttempt, type SucceededAttempt,
} from '../scorers/attempts.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import {
  ENTRY_WINDOW_MS, LEASE_TTL_MS, entryIdOf, entryState, hasLapsed, leaseRefOf, parseLeaseRef, type EntryState,
} from '../scorers/entry.js';
import { observedEffort, observedModel } from '../agent-observation.js';
import { ACCESS_LEVELS, ISOLATIONS, JudgeUsageSchema, sumUsage, type Isolation, type JudgeAccess, type JudgeUsage, type RunSubject, type ScoreLabel } from '../scorers/label.js';
import { LabelStore, reasoningPath } from '../scorers/label-store.js';
import { isJudgeTool, runLocalJudge } from '../scorers/judge.js';
import { loadModelAliases } from '../models/aliases.js';
import { chooseJudgeModel } from '../scorers/judge-model.js';
import { isSampled } from '../scorers/sampling.js';
import { scoringUnavailable } from '../scorers/home.js';
import { answerSchema, evidenceDirOf, sweepEvidence } from '../scorers/evidence.js';
import { buildEvidence } from './scoring-evidence.js';
import { error, ok } from './engine.js';
import { firstSettled, passesWithin, runPasses, type RunPass } from './loop.js';
import { stepDefinitions } from './scope.js';
import { parseStepPath } from './step-path.js';
import { installOwner, isRunId, readRun, runsDir } from './store.js';
import type { RunState, WorkflowEnvelope, WorkflowStep } from './types.js';

/** A succeeded pass of a step that lists scorers this run pinned. */
interface ScorablePass {
  subject: RunSubject;
  scorers: string[];
}

/** Whether this install settled `pass`: its stamp, or, for a pass settled before stamps, a run no other install handed over. */
function settledHere(run: RunState, pass: RunPass, install: string): boolean {
  return pass.installId === undefined ? run.publication === undefined : pass.installId === install;
}

/**
 * The passes of `run` this install may judge: succeeded passes of prompt and workflow steps that list a scorer the run
 * pinned, and of a `for_each` step only its items. A prompt pass belongs to the install that settled it; a workflow pass
 * to the install that settled its first child that has a stamp. Sampling is left to the caller.
 */
export function scoredPasses(run: RunState, install: string): ScorablePass[] {
  const definitionOf = stepDefinitions(run);
  const all = runPasses(run);
  const pinned = run.scorers ?? {};
  return all.flatMap((pass) => {
    if (pass.outcome !== 'success') return [];
    const definition: WorkflowStep | undefined = definitionOf(pass.step);
    const scorers = (definition?.scorers?.names ?? []).filter((name) => Object.hasOwn(pinned, name));
    if (!definition || scorers.length === 0) return [];
    if (definition.forEach && parseStepPath(pass.step).at(-1)?.index === undefined) return [];
    const owner = definition.workflow === undefined ? pass
      : firstSettled(passesWithin(run, all, pass.step, pass.pass).filter((child) => child.installId !== undefined));
    if (!settledHere(run, owner ?? pass, install)) return [];
    return [{ subject: { runId: run.id, step: pass.step, pass: pass.pass }, scorers }];
  });
}

/** What a driver says when it asks for judge work. */
export interface JudgeRequest {
  driver: JudgeDriver;
  /** `access` is what the driver's judge can do beyond answering; a driver that does not say counts as `full`. */
  judge: { isolation: Isolation; access?: JudgeAccess; tools: [string, ...string[]] };
  /** The lease refs the driver is still running; each is renewed. A live lease of this driver it leaves out is handed back. */
  running: string[];
}

const NextPayloadSchema = z.object({
  driver: DriverSchema.extend({
    can: z.object({
      judge: z.object({ isolation: z.enum(ISOLATIONS), access: z.enum(ACCESS_LEVELS).optional(), tools: z.array(z.string().min(1)).nonempty() }, {
        required_error: 'driver.can.judge is required: {"isolation":"verified" or "best-effort","tools":["claude",…]}',
      }),
    }, { required_error: 'driver.can.judge is required: {"isolation":"verified" or "best-effort","tools":["claude",…]}' }),
  }),
  running: z.array(z.string()).default([]),
});

const SubmitPayloadSchema = z.object({
  driver: DriverSchema,
  outcome: z.enum(['success', 'failed', 'released']),
  answer: z.object({ label: z.string().min(1), reasoning: z.string() }).optional(),
  judge: z.object({ tool: z.string().min(1).optional(), model: z.string().min(1).optional(), usage: JudgeUsageSchema.optional(), isolation: z.enum(ISOLATIONS).optional() }).optional(),
});
type SubmitPayload = z.infer<typeof SubmitPayloadSchema>;
export type JudgeSubmission =
  | { driver: JudgeDriver; outcome: 'success'; answer: NonNullable<SubmitPayload['answer']>; judge?: SubmitPayload['judge'] }
  | { driver: JudgeDriver; outcome: 'released' | 'failed'; judge?: SubmitPayload['judge'] };

function issueText(issues: z.ZodIssue[]): string {
  const issue = issues[0];
  if (!issue) return 'is not valid';
  return `${issue.path.join('.') || 'payload'}: ${issue.message}`;
}

export function parseJudgeRequest(value: unknown): JudgeRequest | string {
  const parsed = NextPayloadSchema.safeParse(value);
  if (!parsed.success) return issueText(parsed.error.issues);
  const { can, ...driver } = parsed.data.driver;
  return { driver, judge: can.judge, running: parsed.data.running };
}

export function parseJudgeSubmission(value: unknown): JudgeSubmission | string {
  const parsed = SubmitPayloadSchema.safeParse(value);
  if (!parsed.success) return issueText(parsed.error.issues);
  const { outcome, answer, ...submission } = parsed.data;
  if (outcome !== 'success') return { ...submission, outcome };
  return answer ? { ...submission, outcome, answer } : 'answer: a success needs answer.label and answer.reasoning';
}

function sameDriver(left: JudgeDriver, right: JudgeDriver): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}

/** One sampled (scorer, pass) with its derived state. */
interface ScoreEntry {
  id: string;
  run: RunState;
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  subject: RunSubject;
  state: EntryState;
}

/** The runs a judge may still be asked about: running ones, those with a live lease, and those changed inside the entry window. */
async function recentRuns(config: LocalConfig, now: string, leased: ReadonlySet<string>): Promise<RunState[]> {
  const files = await fs.readdir(runsDir(config)).catch(() => []);
  const ids = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)).filter(isRunId);
  const runs = await Promise.all(ids.map((id) => readRun(config, id)));
  return runs
    .filter((run): run is RunState => typeof run === 'object')
    .filter((run) => run.status === 'running' || leased.has(run.id) || Date.parse(run.updatedAt) + ENTRY_WINDOW_MS > Date.parse(now))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function sameSubject(label: ScoreLabel, scorer: string, sourceHash: string, subject: RunSubject): boolean {
  return label.source === 'workflow' && label.scorer === scorer && label.rubric.sourceHash === sourceHash
    && label.subject.runId === subject.runId && label.subject.step === subject.step && label.subject.pass === subject.pass;
}

async function entries(config: LocalConfig, now: string): Promise<ScoreEntry[]> {
  const install = (await installOwner(config)).id;
  const [labels, attempts] = await Promise.all([LabelStore.local(config), AttemptStore.read(config)]);
  const leased = new Set([...attempts.values()].flat().filter((attempt) => attempt.status === 'leased' && !hasLapsed(attempt, now))
    .map((attempt) => attempt.subject.runId));
  const runs = await recentRuns(config, now, leased);
  return runs.flatMap((run) => scoredPasses(run, install).flatMap(({ subject, scorers }) => scorers.flatMap((scorer) => {
    const pin = run.scorers?.[scorer];
    const definition = pin && pinnedDefinition(scorer, pin);
    if (!pin || !definition || !isSampled(scorer, subject, definition.samplingRate)) return [];
    const id = entryIdOf(scorer, subject);
    const state = entryState({
      labels: labels.filter((label) => sameSubject(label, scorer, pin.sourceHash, subject)),
      attempts: attempts.get(id) ?? [],
      subjectChangedAt: run.updatedAt,
      now,
    });
    return [{ id, run, scorer, pin, definition, subject, state }];
  })));
}

/** Whether a judge at `offered` isolation may judge for a scorer that asks for `required`. */
function meets(offered: Isolation, required: Isolation): boolean {
  return ISOLATIONS.indexOf(offered) >= ISOLATIONS.indexOf(required);
}

/** Whether the driver still offers what `attempt` was leased with: its tool, at its isolation or stricter. */
function stillJudges(request: JudgeRequest, attempt: LeasedAttempt): boolean {
  return request.judge.tools.includes(attempt.judge.tool) && meets(request.judge.isolation, attempt.judge.isolation);
}

function evidenceDir(config: LocalConfig, attempt: string): string {
  return evidenceDirOf(scoresDir(config), attempt);
}

async function leaseAnswer(config: LocalConfig, entry: ScoreEntry, attempt: LeasedAttempt, handedBack: boolean) {
  const dir = evidenceDir(config, attempt.attempt);
  const prompt = path.join(dir, 'prompt.md');
  const ref = leaseRefOf(attempt);
  return {
    ref,
    scorer: entry.scorer,
    subject: attempt.subject,
    rubric: { sourceHash: entry.pin.sourceHash, ...(entry.pin.teamRevision ? { teamRevision: entry.pin.teamRevision } : {}) },
    judge: attempt.judge,
    evidence: dir,
    prompt,
    answer: { schema: answerSchema(entry.definition) },
    expiresAt: attempt.expiresAt,
    ...(entry.run.checkout ? { cwd: entry.run.checkout } : {}),
    submit: `teamai score --lease ${ref} --submit --stdin`,
    ...(handedBack ? { handedBack: true } : {}),
  };
}

function later(now: string, ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

interface ClosedEntry {
  ref: string;
  code: string;
}

/** Work none of this driver's tools can run the scorer's model for, left open for a driver whose tools can. */
interface SkippedEntry {
  scorer: string;
  subject: RunSubject;
  code: 'judge_model_unavailable';
  message: string;
}

type OneLease =
  | { kind: 'lease'; lease: Awaited<ReturnType<typeof leaseAnswer>>; skipped: SkippedEntry[] }
  | { kind: 'idle'; open: number; leased: number; skipped: SkippedEntry[] };

/** `busy`: another process holds the attempts lock. */
export type TakenLease = (OneLease & { closed: ClosedEntry[] }) | { kind: 'busy' };

/**
 * The one way to get judge work; `workflow next` never hands it out. Releases a live lease of this driver that it no
 * longer offers the tool or isolation for, renews the leases it lists in `running`, hands back one it left out, else
 * leases the first open entry, oldest run first, whose scorer's isolation the driver meets. Answers `idle` with counts
 * when there is none. An entry whose evidence is empty closes, and the next one is tried. An entry whose scorer's model
 * none of the driver's tools runs is skipped and stays open for another driver.
 */
export async function takeJudgeLease(config: LocalConfig, request: JudgeRequest, now: string): Promise<TakenLease> {
  const earlier: ClosedEntry[] = [];
  for (;;) {
    const taken = await takeOneLease(config, request, now);
    switch (taken.kind) {
      case 'evidence_empty':
        earlier.push(...taken.closed);
        break;
      case 'lease':
      case 'idle':
        return { ...taken, closed: earlier };
      case 'busy':
        return taken;
      default: {
        const unhandled: never = taken;
        return unhandled;
      }
    }
  }
}

async function takeOneLease(config: LocalConfig, request: JudgeRequest, now: string): Promise<OneLease | { kind: 'busy' } | { kind: 'evidence_empty'; closed: ClosedEntry[] }> {
  const unavailable = scoringUnavailable(config);
  if (unavailable) {
    log.warn(unavailable);
    return { kind: 'idle', open: 0, leased: 0, skipped: [] };
  }
  const found = await entries(config, now);
  const aliases = await loadModelAliases(config);
  const skipped: SkippedEntry[] = [];
  const released = new Set<string>();
  const isOpen = (entry: ScoreEntry) => entry.state.kind === 'open' || released.has(entry.id);
  const outcome = await AttemptStore.locked(config, async () => {
    const mine: Array<{ entry: ScoreEntry; attempt: LeasedAttempt }> = [];
    for (const entry of found) {
      const live = (await AttemptStore.ofEntry(config, entry.id))
        .find((attempt): attempt is LeasedAttempt => attempt.status === 'leased' && !hasLapsed(attempt, now));
      if (!live || !sameDriver(live.driver, request.driver)) continue;
      if (!stillJudges(request, live)) {
        await AttemptStore.write(config, { ...live, status: 'released', settledAt: now });
        released.add(entry.id);
      } else if (request.running.includes(leaseRefOf(live))) {
        await AttemptStore.write(config, { ...live, expiresAt: later(now, LEASE_TTL_MS) });
      } else {
        mine.push({ entry, attempt: live });
      }
    }
    const back = mine[0];
    if (back) return { entry: back.entry, attempt: back.attempt, handedBack: true };
    for (const entry of found) {
      if (!isOpen(entry) || !meets(request.judge.isolation, entry.definition.isolation ?? 'best-effort')) continue;
      // Re-read under the lock: another driver may have taken it since the unlocked read.
      const fresh = entryState({ labels: [], attempts: await AttemptStore.ofEntry(config, entry.id), subjectChangedAt: entry.run.updatedAt, now });
      if (fresh.kind !== 'open') continue;
      const chosen = chooseJudgeModel(aliases, entry.definition, request.judge.tools);
      if (!chosen.ok) {
        skipped.push({ scorer: entry.scorer, subject: entry.subject, code: chosen.code, message: chosen.message });
        continue;
      }
      const attempt: LeasedAttempt = {
        status: 'leased',
        attempt: newAttemptId(),
        entry: entry.id,
        scorer: entry.scorer,
        rubric: { sourceHash: entry.pin.sourceHash },
        subject: entry.subject,
        driver: request.driver,
        judge: {
          ...chosen.choice,
          isolation: request.judge.isolation,
          access: request.judge.access ?? 'full',
        },
        leasedAt: now,
        expiresAt: later(now, LEASE_TTL_MS),
      };
      await AttemptStore.write(config, attempt);
      return { entry, attempt, handedBack: false };
    }
    return undefined;
  });
  if (outcome.status === 'busy') return { kind: 'busy' };
  const leased = outcome.value;
  const attempts = await AttemptStore.read(config);
  await sweepEvidence(scoresDir(config), new Set([...attempts.values()].flat()
    .filter((attempt) => attempt.status !== 'leased' || hasLapsed(attempt, now)).map((attempt) => attempt.attempt)));
  if (leased) {
    const built = await buildEvidence(leased.entry.run, leased.entry.subject, leased.entry.definition, evidenceDir(config, leased.attempt.attempt));
    if (!built.ok) {
      const failed = await AttemptStore.locked(config, async () => {
        const current = await AttemptStore.get(config, leased.attempt.entry, leased.attempt.attempt);
        if (current?.status === 'leased') await AttemptStore.write(config, { ...current, status: 'failed', code: built.code, settledAt: now });
      });
      if (failed.status === 'busy') return { kind: 'busy' };
      await fs.rm(evidenceDir(config, leased.attempt.attempt), { recursive: true, force: true, maxRetries: 3 });
      return { kind: 'evidence_empty', closed: [{ ref: leaseRefOf(leased.attempt), code: built.code }] };
    }
    return { kind: 'lease', lease: await leaseAnswer(config, leased.entry, leased.attempt, leased.handedBack), skipped };
  }
  return {
    kind: 'idle',
    open: found.filter(isOpen).length,
    leased: found.filter((entry) => entry.state.kind === 'leased' && !released.has(entry.id)).length,
    skipped,
  };
}

/**
 * `teamai score --next`: the lease `takeJudgeLease` took, or `idle` with counts, the entries that closed meanwhile, and
 * why the driver's tools cannot judge the ones it skipped.
 */
export async function nextJudgeLease(config: LocalConfig, request: JudgeRequest, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  const taken = await takeJudgeLease(config, request, now);
  switch (taken.kind) {
    case 'lease':
      return ok({ lease: taken.lease, ...(taken.closed.length ? { closed: taken.closed } : {}), ...(taken.skipped.length ? { skipped: taken.skipped } : {}) });
    case 'idle':
      return ok({ idle: { open: taken.open, leased: taken.leased }, ...(taken.closed.length ? { closed: taken.closed } : {}), ...(taken.skipped.length ? { skipped: taken.skipped } : {}) });
    case 'busy':
      return error('busy', 'The judge attempts are locked by another process. Ask again.');
    default: {
      const unhandled: never = taken;
      return unhandled;
    }
  }
}

type Refusal = ReturnType<typeof error>;

type Labelled = { kind: 'labelled'; attempt: SucceededAttempt };

/** `published`: whether the label reached teamai-reports. */
export type SettledLease = (Labelled & { published: boolean }) | Refusal;

type Returned = { kind: 'returned'; status: 'released' | 'failed' };
type SubmittedLease = SettledLease | Returned;

function labelAnswer(config: LocalConfig, attempt: SucceededAttempt): Record<string, unknown> {
  const { label, score, passed, version } = attempt.verdict;
  return { label: { scorer: attempt.scorer, subject: attempt.subject, label, score, passed, labelId: attempt.labelId, reasoning: reasoningPath(config, version) } };
}

/** Settles an open lease through `settle`; a lease already labelled answers its own label again. */
async function settleJudgeLease<T extends { kind: string }>(
  config: LocalConfig, ref: string, driver: JudgeDriver, now: string, settle: (attempt: LeasedAttempt, pin: PinnedScorer, definition: ScorerDefinition) => Promise<T | Refusal>,
): Promise<T | Labelled | Refusal> {
  const parsedRef = parseLeaseRef(ref);
  if (!parsedRef) return error('lease_unknown', `${ref} is not a judge lease ref. A ref looks like s<13 hex>/a<8 hex>, as teamai score --next prints it.`);
  const known = await AttemptStore.get(config, parsedRef.entry, parsedRef.attempt);
  if (!known) return error('lease_unknown', `Judge lease ${ref} is not on this machine. Submit from the scope that leased it (the lease's cwd).`);
  const run = await readRun(config, known.subject.runId);
  const pin = typeof run === 'object' ? run.scorers?.[known.scorer] : undefined;
  const definition = pin && pinnedDefinition(known.scorer, pin);
  if (typeof run !== 'object' || !pin || !definition) return error('lease_unknown', `The scorer ${known.scorer} that judge lease ${ref} was for is no longer pinned by run ${known.subject.runId}.`);
  const outcome = await AttemptStore.locked(config, async (): Promise<T | Labelled | Refusal> => {
    const attempt = await AttemptStore.get(config, parsedRef.entry, parsedRef.attempt);
    if (!attempt) return error('lease_unknown', `Judge lease ${ref} is not on this machine.`);
    if (!sameDriver(attempt.driver, driver)) return error('wrong_driver', `Judge lease ${ref} belongs to a different driver.`);
    if (attempt.status === 'succeeded') return { kind: 'labelled', attempt };
    if (attempt.status !== 'leased') return error('lease_settled', `Judge lease ${ref} was already settled as ${attempt.status}.`);
    const state = entryState({ labels: [], attempts: await AttemptStore.ofEntry(config, attempt.entry), subjectChangedAt: run.updatedAt, now });
    switch (state.kind) {
      case 'open':
        break;
      case 'labelled':
        return error('lease_expired', `Judge lease ${ref} expired at ${attempt.expiresAt} and another judge has labelled this work since.`);
      case 'leased':
        if (state.attempt.attempt !== attempt.attempt) {
          return error('lease_expired', `Judge lease ${ref} expired at ${attempt.expiresAt} and another driver now holds this work.`);
        }
        break;
      case 'failed':
        return error('entry_closed', `The judge work of lease ${ref} closed as ${state.code}, so this answer is not recorded. Run teamai score --next for open work.`);
      case 'expired':
        return error('entry_closed', `The judge work of lease ${ref} expired 14 days after its run last changed, so this answer is not recorded. Run teamai score --next for open work.`);
      default: {
        const unhandled: never = state;
        return unhandled;
      }
    }
    return settle(attempt, pin, definition);
  });
  if (outcome.status === 'busy') return error('busy', 'The judge attempts are locked by another process. Submit again.');
  const settled = outcome.value;
  if ('error' in settled) return settled;
  await fs.rm(evidenceDir(config, parsedRef.attempt), { recursive: true, force: true, maxRetries: 3 });
  return settled;
}

async function publishLabels(config: LocalConfig, labelled: Labelled): Promise<SettledLease> {
  // Publishing is best effort: a label that does not reach teamai-reports now stays pending for the next pull.
  const delivery = await LabelStore.publish(config).catch((e: unknown) => ({ state: 'pending' as const, reason: e instanceof Error ? e.message : String(e) }));
  if (delivery.state === 'pending') log.debug(`[scores] Labels stay pending: ${delivery.reason}`);
  return { ...labelled, published: delivery.state === 'published' };
}

/** What the local judge that ran could do, the isolation it measured, and the model and effort it ran with. */
type LocalRun = Pick<Extract<ScoreLabel['judge'], { kind: 'model' }>, 'access' | 'isolation' | 'model' | 'effort'>;

/** The label's `model` and `effort`: what the judge ran with, by the local judge's account or the lease's, and the attempt's alias. */
function judgeIdentity(attempt: AttemptRecord, submission: JudgeSubmission, local: LocalRun | undefined): Pick<LocalRun, 'model' | 'effort'> {
  const ran = local ?? { model: { requested: attempt.judge.model?.name, reported: submission.judge?.model }, effort: { requested: attempt.judge.model?.effort } };
  const model = observedModel({ ...ran.model, alias: attempt.judge.alias });
  const effort = ran.effort && observedEffort(ran.effort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * A success must name a label of the scorer, else nothing is written and the lease stays open; TeamAI computes the
 * score and whether it passed. `local` is the local judge that ran, at the isolation it measured. A driver's own judge
 * has the access its lease declared, and ran the model and effort the lease named, as the driver reports it.
 */
async function labelJudgeLease(config: LocalConfig, ref: string, submission: Extract<JudgeSubmission, { outcome: 'success' }>, now: string, local?: LocalRun): Promise<SettledLease> {
  const result = await settleJudgeLease(config, ref, submission.driver, now, async (attempt, pin, definition): Promise<Labelled | Refusal> => {
    const answer = submission.answer;
    const chosen = definition.labels.find((label) => label.value === answer.label);
    if (!chosen) {
      return error('label_invalid', `"${answer.label}" is not a label of scorer ${attempt.scorer}. Use one of: ${definition.labels.map((label) => label.value).join(', ')}. The lease stays open.`);
    }
    const tool = submission.judge?.tool ?? attempt.judge.tool;
    if (tool !== attempt.judge.tool) {
      return error('invalid_json', `judge.tool must match the tool selected by the lease: ${attempt.judge.tool}.`);
    }
    const usage = sumUsage(attempt.usage, submission.judge?.usage);
    const settled = { settledAt: now, ...(usage ? { usage } : {}) };
    const label: ScoreLabel = {
      scorer: attempt.scorer,
      rubric: { sourceHash: pin.sourceHash, ...(pin.teamRevision ? { teamRevision: pin.teamRevision } : {}) },
      label: chosen.value,
      score: chosen.score,
      passed: chosen.score >= definition.passingScore,
      source: 'workflow',
      subject: attempt.subject,
      judge: {
        kind: 'model',
        tool,
        ...judgeIdentity(attempt, submission, local),
        ...(usage ? { usage } : {}),
        isolation: local?.isolation ?? (submission.judge?.isolation === 'best-effort' ? 'best-effort' : attempt.judge.isolation),
        access: local?.access ?? attempt.judge.access,
      },
      scoredAt: now,
    };
    const { id, version } = await LabelStore.append(config, label, answer.reasoning);
    const succeeded: SucceededAttempt = {
      ...attempt, ...settled, status: 'succeeded', labelId: id, verdict: { label: label.label, score: label.score, passed: label.passed, version },
    };
    await AttemptStore.write(config, succeeded);
    return { kind: 'labelled', attempt: succeeded };
  });
  return 'error' in result ? result : publishLabels(config, result);
}

async function returnJudgeLease(config: LocalConfig, ref: string, submission: Extract<JudgeSubmission, { outcome: 'released' | 'failed' }>, now: string): Promise<SubmittedLease> {
  const result = await settleJudgeLease(config, ref, submission.driver, now, async (attempt): Promise<Returned | Refusal> => {
    const usage = sumUsage(attempt.usage, submission.judge?.usage);
    const settled = { settledAt: now, ...(usage ? { usage } : {}) };
    const next: AttemptRecord = submission.outcome === 'released'
      ? { ...attempt, ...settled, status: 'released' }
      : { ...attempt, ...settled, status: 'failed', code: 'judge_failed' };
    await AttemptStore.write(config, next);
    return { kind: 'returned', status: submission.outcome };
  });
  if ('error' in result) return result;
  switch (result.kind) {
    case 'labelled':
      return publishLabels(config, result);
    case 'returned':
      return result;
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

function settledAnswer(config: LocalConfig, ref: string, settled: SubmittedLease): WorkflowEnvelope {
  if ('error' in settled) return settled;
  switch (settled.kind) {
    case 'labelled':
      return ok({ ...labelAnswer(config, settled.attempt), published: settled.published });
    case 'returned':
      return ok({ settled: { ref, status: settled.status } });
    default: {
      const unhandled: never = settled;
      return unhandled;
    }
  }
}

export async function submitJudgeLease(config: LocalConfig, ref: string, submission: JudgeSubmission, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  switch (submission.outcome) {
    case 'success':
      return settledAnswer(config, ref, await labelJudgeLease(config, ref, submission, now));
    case 'released':
    case 'failed':
      return settledAnswer(config, ref, await returnJudgeLease(config, ref, submission, now));
    default: {
      const unhandled: never = submission;
      return unhandled;
    }
  }
}

/** Adds what a failed local judge call spent to the lease it ran for, which stays open. */
async function recordSpend(config: LocalConfig, head: AttemptRecord, usage: JudgeUsage | undefined): Promise<void> {
  if (!usage) return;
  const recorded = await AttemptStore.locked(config, async () => {
    const current = await AttemptStore.get(config, head.entry, head.attempt);
    if (current?.status === 'leased') await AttemptStore.write(config, { ...current, usage: sumUsage(current.usage, usage) });
  });
  if (recorded.status === 'busy') log.warn(`[scores] The judge attempts are locked by another process, so the spend of this judge call is not counted: ${JSON.stringify(usage)}.`);
}

/** Runs the lease's judge with its local tool profile, then settles the lease through the same path as `--submit`. */
export async function judgeLease(config: LocalConfig, ref: string, driver: JudgeDriver): Promise<SettledLease> {
  const key = parseLeaseRef(ref);
  const attempt = key && await AttemptStore.get(config, key.entry, key.attempt);
  if (!attempt) return error('lease_unknown', `Judge lease ${ref} is not on this machine. Run score --next in this scope.`);
  if (!sameDriver(attempt.driver, driver)) return error('wrong_driver', `Judge lease ${ref} belongs to a different driver.`);
  if (attempt.status !== 'leased') return error('lease_settled', `Judge lease ${ref} was already settled. Run score --next for more work.`);
  if (!isJudgeTool(attempt.judge.tool)) return error('judge_tool_unavailable', `The local judge cannot launch ${attempt.judge.tool}. Run that tool through its driver and submit the answer.`);
  const run = await readRun(config, attempt.subject.runId);
  const pin = typeof run === 'object' ? run.scorers?.[attempt.scorer] : undefined;
  const definition = pin && pinnedDefinition(attempt.scorer, pin);
  if (typeof run !== 'object' || !definition) return error('lease_unknown', `The pinned scorer for ${ref} is no longer readable. Restore the run and scorer before retrying.`);
  const evidence = evidenceDir(config, attempt.attempt);
  const built = await buildEvidence(run, attempt.subject, definition, evidence);
  if (!built.ok) return error(built.code, 'No recorded evidence could be read for this pass. Restore its commits or session, then retry.');
  const result = await runLocalJudge({ tool: attempt.judge.tool, model: attempt.judge.model, evidence, schema: answerSchema(definition), isolation: definition.isolation });
  if (!result.ok || !definition.labels.some((label) => label.value === result.answer.label)) {
    await recordSpend(config, attempt, result.ok ? result.judge.usage : result.usage);
    const raw = result.ok ? JSON.stringify(result.answer) : result.raw;
    let saved = '';
    if (raw !== undefined) {
      const file = path.join(scoresDir(config), 'raw', `${attempt.attempt}.txt`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, raw, { mode: 0o600 });
      saved = ` Output saved to ${file}.`;
    }
    return result.ok
      ? error('judge_answer_invalid', `The judge returned a label outside scorer ${attempt.scorer}. The lease stays open. Retry or submit a valid label.${saved}`)
      : error(result.code, result.message + saved);
  }
  const { access, model, effort, ...judge } = result.judge;
  return labelJudgeLease(config, ref, { driver, outcome: 'success', answer: result.answer, judge }, new Date().toISOString(), { access, isolation: judge.isolation, model, effort });
}

export async function runJudgeLease(config: LocalConfig, ref: string, value: unknown): Promise<WorkflowEnvelope> {
  const parsed = z.object({ driver: DriverSchema }).safeParse(value);
  if (!parsed.success) return error('invalid_json', issueText(parsed.error.issues));
  return settledAnswer(config, ref, await judgeLease(config, ref, parsed.data.driver));
}
