/**
 * The label store every scorer source writes to. On this machine: `<dataHome>/scores/labels.jsonl`, one label per line,
 * the judge's reasoning in `reasoning/<labelVersion>.md`, and an outbox `pending/<labelId>.json`. Published:
 * `scores/<member>/<YYYY-MM>.jsonl` on teamai-reports. Readers keep the newest `scoredAt` per key. Reasoning never leaves
 * this machine.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadTeamConfig } from '../config.js';
import { getReportsDir, isUsageReportEnabled, type LocalConfig } from '../types.js';
import { readFileSafe, writeFileAtomic, writeJsonAtomic } from '../utils/fs.js';
import { AttemptStore, scoresDir } from './attempts.js';
import { labelId, labelVersion, newestLabels, parseScoreLabel, parseScoreLabels, type JudgeUsage, type ScoreLabel } from './label.js';

function labelsFile(config: LocalConfig): string {
  return path.join(scoresDir(config), 'labels.jsonl');
}

function pendingDir(config: LocalConfig): string {
  return path.join(scoresDir(config), 'pending');
}

export function reasoningPath(config: LocalConfig, id: string): string {
  return path.join(scoresDir(config), 'reasoning', `${id}.md`);
}

/** Where a label is published: the member's file for the UTC month it was scored in. */
function publishedPath(username: string, label: ScoreLabel): string {
  return `scores/${username}/${label.scoredAt.slice(0, 7)}.jsonl`;
}

function reasoningText(label: ScoreLabel, reasoning: string): string {
  return [
    `scorer: ${label.scorer}`,
    `rubric.sourceHash: ${label.rubric.sourceHash}`,
    `subject: ${JSON.stringify(label.subject)}`,
    `label: ${label.label}`,
    `scoredAt: ${label.scoredAt}`,
    '',
    reasoning,
    '',
  ].join('\n');
}

async function readPending(config: LocalConfig): Promise<Array<{ id: string; label: ScoreLabel }>> {
  const files = (await fs.readdir(pendingDir(config)).catch(() => [])).filter((file) => file.endsWith('.json')).sort();
  const read = await Promise.all(files.map(async (file) => {
    try {
      const label = parseScoreLabel(JSON.parse(await readFileSafe(path.join(pendingDir(config), file)) ?? 'null'));
      return label ? [{ id: file.slice(0, -'.json'.length), label }] : [];
    } catch {
      return [];
    }
  }));
  return read.flat();
}

async function publishedLabels(config: LocalConfig): Promise<ScoreLabel[]> {
  const root = path.join(getReportsDir(config), 'scores');
  const members = await fs.readdir(root).catch(() => []);
  const files = (await Promise.all(members.map(async (member) => (await fs.readdir(path.join(root, member)).catch(() => []))
    .filter((file) => file.endsWith('.jsonl')).map((file) => path.join(root, member, file))))).flat();
  return (await Promise.all(files.map(async (file) => parseScoreLabels(await readFileSafe(file) ?? '')))).flat();
}

/** Whether a publish delivered every pending label, and when not, why they stay on this machine. */
export type LabelDelivery = { state: 'published' } | { state: 'pending'; reason: string };

/** What Workflow Runs shows of a label: never its reasoning, judge, or usage. */
export type PassScore = Pick<ScoreLabel, 'scorer' | 'label' | 'passed'>;

function addUsage(total: { inputTokens: number; outputTokens: number }, usage: JudgeUsage | undefined): void {
  total.inputTokens += usage?.inputTokens ?? 0;
  total.outputTokens += usage?.outputTokens ?? 0;
}

export const LabelStore = {
  /**
   * The outbox entry commits the label: a failure before it records no label, and one after it leaves a label that
   * `local` reads and `publish` still sends. Returns the label's `id` and the `version` that names its reasoning file.
   */
  async append(config: LocalConfig, label: ScoreLabel, reasoning: string): Promise<{ id: string; version: string }> {
    const id = labelId(label);
    const version = labelVersion(label);
    await writeFileAtomic(reasoningPath(config, version), reasoningText(label, reasoning));
    await writeJsonAtomic(path.join(pendingDir(config), `${id}.json`), label);
    await fs.appendFile(labelsFile(config), `${JSON.stringify(label)}\n`, 'utf8');
    return { id, version };
  },

  /** This machine's labels, appended or still pending, the newest per key. */
  async local(config: LocalConfig): Promise<ScoreLabel[]> {
    const pending = (await readPending(config)).map(({ label }) => label);
    return newestLabels([...parseScoreLabels(await readFileSafe(labelsFile(config)) ?? ''), ...pending]);
  },

  /**
   * Publishes every pending label to `scores/<member>/<YYYY-MM>.jsonl`, merged by key against what origin holds, so an
   * older label from another clone never replaces a newer one. A pending file is removed only while it still holds the
   * label that was sent, so a rescore written during the push stays pending. A label an interrupted `append` left out of
   * `labels.jsonl` is appended there first. Nothing is published with usage reporting off.
   */
  async publish(config: LocalConfig): Promise<LabelDelivery> {
    const pending = await readPending(config);
    if (pending.length === 0) return { state: 'published' };
    if (!isUsageReportEnabled(config, (await loadTeamConfig(config.repo.localPath)) ?? {})) {
      return { state: 'pending', reason: 'Usage reporting is off, so labels stay on this machine.' };
    }
    const username = config.username ?? 'unknown';
    const { updateReports, readReportsOriginFile } = await import('../utils/reports-branch.js');
    const outcome = await updateReports(config, async (worktree) => {
      const byFile = new Map<string, ScoreLabel[]>();
      for (const { label } of pending) byFile.set(publishedPath(username, label), [...byFile.get(publishedPath(username, label)) ?? [], label]);
      for (const [file, labels] of byFile) {
        const origin = parseScoreLabels(await readReportsOriginFile(worktree, file) ?? '');
        const merged = newestLabels([...origin, ...labels]);
        await fs.mkdir(path.join(worktree, path.dirname(file)), { recursive: true });
        await fs.writeFile(path.join(worktree, file), merged.map((label) => `${JSON.stringify(label)}\n`).join(''), 'utf8');
      }
      return { files: [...byFile.keys()], message: `[teamai] Publish ${pending.length} score label${pending.length === 1 ? '' : 's'}` };
    });
    switch (outcome.status) {
      case 'published':
      case 'already-present': {
        await AttemptStore.locked(config, async () => {
          const appended = new Set(parseScoreLabels(await readFileSafe(labelsFile(config)) ?? '').map(labelVersion));
          for (const { id, label } of pending) {
            const file = path.join(pendingDir(config), `${id}.json`);
            const current = parseScoreLabel(JSON.parse(await readFileSafe(file) ?? 'null'));
            if (current?.scoredAt !== label.scoredAt) continue;
            if (!appended.has(labelVersion(label))) await fs.appendFile(labelsFile(config), `${JSON.stringify(label)}\n`, 'utf8');
            await fs.rm(file, { force: true });
          }
        });
        return (await readPending(config)).length === 0
          ? { state: 'published' }
          : { state: 'pending', reason: 'a label was scored again while the others were published' };
      }
      case 'busy':
        return { state: 'pending', reason: 'another teamai process is writing teamai-reports' };
      case 'failed':
        return { state: 'pending', reason: outcome.reason };
      default: {
        const unhandled: never = outcome;
        return unhandled;
      }
    }
  },

  /**
   * The labels of workflow runs `runIds` by run and `${step}#${pass}`, from this machine and, with `published`, from the
   * reports checkout as it is. Per pass and scorer, a hand label beats a model label, and of those the newest across
   * rubric versions is shown.
   */
  async ofRuns(config: LocalConfig, runIds: readonly string[], options: { published: boolean }): Promise<Map<string, Map<string, PassScore[]>>> {
    const wanted = new Set(runIds);
    const labels = newestLabels([
      ...await LabelStore.local(config),
      ...options.published ? await publishedLabels(config) : [],
    ]);
    const outranks = (label: ScoreLabel, other: ScoreLabel): boolean => (label.judge.kind === other.judge.kind
      ? label.scoredAt > other.scoredAt
      : label.judge.kind === 'human');
    const byRun = new Map<string, Map<string, ScoreLabel[]>>();
    for (const label of labels) {
      if (label.source !== 'workflow' || !wanted.has(label.subject.runId)) continue;
      const passes = byRun.get(label.subject.runId) ?? new Map<string, ScoreLabel[]>();
      byRun.set(label.subject.runId, passes);
      const key = `${label.subject.step}#${label.subject.pass}`;
      const shown = passes.get(key) ?? [];
      const index = shown.findIndex((other) => other.scorer === label.scorer);
      const current = shown[index];
      if (!current) shown.push(label);
      else if (outranks(label, current)) shown[index] = label;
      passes.set(key, shown);
    }
    return new Map([...byRun].map(([run, passes]) => [run, new Map([...passes].map(([key, shown]) => [
      key, shown.map((label) => ({ scorer: label.scorer, label: label.label, passed: label.passed })),
    ]))]));
  },

  /** What judging run `runId` cost: every attempt on this machine, or, for a published run, its labels. */
  async scoringTotal(config: LocalConfig, runId: string, source: 'local' | 'published'): Promise<{ judged: number; inputTokens: number; outputTokens: number }> {
    const total = { judged: 0, inputTokens: 0, outputTokens: 0 };
    if (source === 'local') {
      for (const attempts of (await AttemptStore.read(config)).values()) {
        for (const attempt of attempts) {
          if (attempt.subject.runId !== runId) continue;
          total.judged += 1;
          addUsage(total, attempt.usage);
        }
      }
      return total;
    }
    for (const label of newestLabels(await publishedLabels(config))) {
      if (label.source !== 'workflow' || label.subject.runId !== runId || label.judge.kind !== 'model') continue;
      total.judged += 1;
      addUsage(total, label.judge.usage);
    }
    return total;
  },
} as const;
