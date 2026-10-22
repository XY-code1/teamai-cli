/**
 * Real CLI: an external JSON driver runs a scored workflow to its end with workflow next and report, then takes the
 * judge work with score --next and settles it with score --lease --submit, answering for a fake judge.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const EnvelopeSchema = z.object({ data: z.record(z.unknown()).optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
const JudgeLeaseSchema = z.object({ ref: z.string(), evidence: z.string(), prompt: z.string(), submit: z.string() }).passthrough();

function runCLI(args: string[], cwd: string, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

function envelope(stdout: string): z.infer<typeof EnvelopeSchema> {
  const line = stdout.trim().split('\n').filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`no JSON envelope in stdout:\n${stdout}`);
  return EnvelopeSchema.parse(JSON.parse(line));
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: process.env, stdio: 'pipe' });
}

const SCORER = `---
labels:
  - { value: thorough, score: 1, description: Reads the diff and names real defects }
  - { value: shallow, score: 0, description: Misses real defects }
passingScore: 0.5
samplingRate: 100
---
Judge the review against the diff.
`;

const WORKFLOW = `schemaVersion: v1alpha1
name: review
description: A reviewed change.
steps:
  - id: plan
    command: node -e "process.exit(0)"
  - id: review
    needs: [plan]
    prompt: Review the change.
    scorers: [review-quality]
`;

describe('teamai score with an external driver', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-score-e2e-'));
    fs.writeFileSync(path.join(repo, 'README.md'), '# app\n');
    git(['init', '-q', '-b', 'main'], repo);
    git(['add', 'README.md'], repo);
    git(['commit', '-q', '-m', 'app'], repo);
    git(['remote', 'add', 'origin', 'http://127.0.0.1:9/team/score.git'], repo);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it('settles the run first, then leases, refuses a bad label, and records the label', async () => {
    expect((await runCLI(['init', '--self', '--agent', 'claude', '--force'], repo)).code).toBe(0);
    fs.mkdirSync(path.join(repo, '.teamai', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.teamai', 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.teamai', 'workflows', 'review.yaml'), WORKFLOW);
    fs.writeFileSync(path.join(repo, '.teamai', 'scorers', 'review-quality.md'), SCORER);
    const pulled = await runCLI(['pull'], repo);
    expect(pulled.code, `${pulled.stdout}\n${pulled.stderr}`).toBe(0);

    const started = envelope((await runCLI(['workflow', 'start', 'review'], repo)).stdout);
    const runId = String(started.data?.run);
    const driver = { kind: 'ext', machine: 'e2e', workspace: repo };

    let done: unknown;
    for (let turn = 0; turn < 10 && done === undefined; turn += 1) {
      const next = envelope((await runCLI(['workflow', 'next', runId, '--json', JSON.stringify({ driver })], repo)).stdout);
      expect(next.data, JSON.stringify(next)).toBeDefined();
      expect(JSON.stringify(next)).not.toContain('judge');
      done = next.data?.done;
      const lease = z.object({ attempt: z.string(), revision: z.number() }).optional().parse(next.data?.lease);
      if (!lease) continue;
      const reported = envelope((await runCLI(['workflow', 'report', runId, '--json', JSON.stringify({ attempt: lease.attempt, revision: lease.revision, outcome: 'success', driver })], repo)).stdout);
      expect(reported.data, JSON.stringify(reported)).toMatchObject({ accepted: true });
    }
    expect(done).toMatchObject({ outcome: 'succeeded' });

    const judge = { driver: { ...driver, can: { judge: { isolation: 'verified', tools: ['claude'] } } }, running: [] };
    const next = await runCLI(['score', '--next', '--json', JSON.stringify(judge)], repo);
    const lease = JudgeLeaseSchema.parse(envelope(next.stdout).data?.lease);
    expect(lease, next.stdout + next.stderr).toMatchObject({ subject: { runId, step: 'review', pass: 1 }, submit: `teamai score --lease ${lease.ref} --submit --stdin` });
    expect(fs.readFileSync(lease.prompt, 'utf8')).toContain('Judge the review against the diff.');

    const reportedJudge = await runCLI(['workflow', 'report', lease.ref, '--json', '{}'], repo);
    expect(reportedJudge.code).toBe(1);
    expect(envelope(reportedJudge.stdout).error?.code).toBe('judge_lease');

    const answer = (label: string) => JSON.stringify({ driver, outcome: 'success', answer: { label, reasoning: 'The reviewer named the off-by-one.' }, judge: { tool: 'claude' } });
    const bad = await runCLI(['score', '--lease', lease.ref, '--submit', '--stdin'], repo, answer('great'));
    expect(bad.code).toBe(1);
    expect(envelope(bad.stdout).error?.code).toBe('label_invalid');

    const good = await runCLI(['score', '--lease', lease.ref, '--submit', '--stdin'], repo, answer('thorough'));
    expect(good.code, good.stdout + good.stderr).toBe(0);
    expect(envelope(good.stdout).data).toMatchObject({ label: { scorer: 'review-quality', label: 'thorough', score: 1, passed: true } });
    const dataHome = path.resolve(lease.evidence, '..', '..', '..');
    const labels = fs.readFileSync(path.join(dataHome, 'scores', 'labels.jsonl'), 'utf8').trim().split('\n');
    expect(labels).toHaveLength(1);
    expect(JSON.parse(labels[0] ?? '{}')).toMatchObject({ scorer: 'review-quality', label: 'thorough', source: 'workflow', subject: { runId, step: 'review', pass: 1 } });

    expect(envelope((await runCLI(['score', '--next', '--json', JSON.stringify(judge)], repo)).stdout).data).toEqual({ idle: { open: 0, leased: 0 } });
  });
});
