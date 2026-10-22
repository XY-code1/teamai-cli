/**
 * The label store every scorer source writes to: `<dataHome>/scores/labels.jsonl`, one label per line, with the judge's
 * reasoning beside it in `reasoning/<labelVersion>.md`. Reasoning never leaves this machine.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalConfig } from '../types.js';
import { readFileSafe, writeFileAtomic } from '../utils/fs.js';
import { scoresDir } from './attempts.js';
import { labelId, labelVersion, newestLabels, parseScoreLabels, type ScoreLabel } from './label.js';

function labelsFile(config: LocalConfig): string {
  return path.join(scoresDir(config), 'labels.jsonl');
}

export function reasoningPath(config: LocalConfig, id: string): string {
  return path.join(scoresDir(config), 'reasoning', `${id}.md`);
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

export const LabelStore = {
  /** Writes the reasoning, then appends the label. Returns the label's `id` and the `version` that names its reasoning file. */
  async append(config: LocalConfig, label: ScoreLabel, reasoning: string): Promise<{ id: string; version: string }> {
    const id = labelId(label);
    const version = labelVersion(label);
    await writeFileAtomic(reasoningPath(config, version), reasoningText(label, reasoning));
    await fs.mkdir(scoresDir(config), { recursive: true });
    await fs.appendFile(labelsFile(config), `${JSON.stringify(label)}\n`, 'utf8');
    return { id, version };
  },

  /** This machine's labels, the newest per key. */
  async local(config: LocalConfig): Promise<ScoreLabel[]> {
    return newestLabels(parseScoreLabels(await readFileSafe(labelsFile(config)) ?? ''));
  },
} as const;
