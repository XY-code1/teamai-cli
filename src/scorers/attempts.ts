/**
 * Judge attempts: `<dataHome>/scores/attempts/<entryId>/<attemptId>.json`, one file per lease, rewritten when it settles.
 * Attempts hold codes, numbers and the label chosen, never the judge's reasoning. One lock serializes every change to them.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DriverSchema } from '../driver-identity.js';
import { getDataHome, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { ACCESS_LEVELS, ISOLATIONS, JudgeUsageSchema, RunSubjectSchema } from './label.js';

const ENTRY_ID = /^s[0-9a-f]{13}$/;
const ATTEMPT_ID = /^a[0-9a-f]{8}$/;

/** Why a judge attempt closed without a label. */
export const JUDGE_FAILURES = ['judge_failed', 'lease_expired'] as const;
export type JudgeFailureCode = (typeof JUDGE_FAILURES)[number];

export type JudgeDriver = z.infer<typeof DriverSchema>;

/** The tools the driver declared, in its order; the label names the one that judged. */
const JudgeChoiceSchema = z.object({
  tools: z.array(z.string().min(1)).min(1),
  model: z.string().min(1).optional(),
  isolation: z.enum(ISOLATIONS),
  access: z.enum(ACCESS_LEVELS),
});

const AttemptBase = {
  attempt: z.string().regex(ATTEMPT_ID),
  entry: z.string().regex(ENTRY_ID),
  scorer: z.string().min(1),
  rubric: z.object({ sourceHash: z.string().min(1) }),
  subject: RunSubjectSchema,
  driver: DriverSchema,
  judge: JudgeChoiceSchema,
  leasedAt: z.string(),
  expiresAt: z.string(),
};
const Settled = { ...AttemptBase, settledAt: z.string(), usage: JudgeUsageSchema.optional() };

export const AttemptRecordSchema = z.discriminatedUnion('status', [
  z.object({ ...AttemptBase, status: z.literal('leased') }),
  z.object({
    ...Settled,
    status: z.literal('succeeded'),
    labelId: z.string().min(1),
    verdict: z.object({ label: z.string().min(1), score: z.number(), passed: z.boolean(), version: z.string().min(1) }),
  }),
  z.object({ ...Settled, status: z.literal('failed'), code: z.enum(JUDGE_FAILURES) }),
  z.object({ ...Settled, status: z.literal('released') }),
]);
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>;
export type LeasedAttempt = Extract<AttemptRecord, { status: 'leased' }>;
export type SucceededAttempt = Extract<AttemptRecord, { status: 'succeeded' }>;

export function newAttemptId(): string {
  return `a${randomBytes(4).toString('hex')}`;
}

export function scoresDir(config: LocalConfig): string {
  return path.join(getDataHome(config), 'scores');
}

function attemptsDir(config: LocalConfig): string {
  return path.join(scoresDir(config), 'attempts');
}

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

async function readAttempt(file: string): Promise<AttemptRecord | undefined> {
  const raw = await readFileSafe(file);
  if (raw === null) return undefined;
  try {
    const parsed = AttemptRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function listDir(dir: string): Promise<string[]> {
  return (await fs.readdir(dir).catch(() => [])).sort();
}

export const AttemptStore = {
  /** Every readable attempt, by entry. A file this teamai cannot read is left out. */
  async read(config: LocalConfig): Promise<Map<string, AttemptRecord[]>> {
    const byEntry = new Map<string, AttemptRecord[]>();
    for (const entry of (await listDir(attemptsDir(config))).filter((name) => ENTRY_ID.test(name))) {
      byEntry.set(entry, await AttemptStore.ofEntry(config, entry));
    }
    return byEntry;
  },

  async ofEntry(config: LocalConfig, entry: string): Promise<AttemptRecord[]> {
    const dir = path.join(attemptsDir(config), entry);
    const files = (await listDir(dir)).filter((name) => ATTEMPT_ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'));
    const records = await Promise.all(files.map((name) => readAttempt(path.join(dir, name))));
    return records.filter((record): record is AttemptRecord => record !== undefined && record.entry === entry);
  },

  async get(config: LocalConfig, entry: string, attempt: string): Promise<AttemptRecord | undefined> {
    if (!ENTRY_ID.test(entry) || !ATTEMPT_ID.test(attempt)) return undefined;
    const record = await readAttempt(path.join(attemptsDir(config), entry, `${attempt}.json`));
    return record?.entry === entry && record.attempt === attempt ? record : undefined;
  },

  async write(config: LocalConfig, record: AttemptRecord): Promise<void> {
    await writeJsonAtomic(path.join(attemptsDir(config), record.entry, `${record.attempt}.json`), record);
  },

  /** Runs `change` under `scores/attempts.lock`; `change` re-reads what it decides on. */
  async locked<T>(config: LocalConfig, change: () => Promise<T>): Promise<{ status: 'done'; value: T } | { status: 'busy' }> {
    const lock = path.join(scoresDir(config), 'attempts.lock');
    await fs.mkdir(scoresDir(config), { recursive: true });
    let held = false;
    for (let tries = 0; tries < LOCK_ATTEMPTS && !held; tries += 1) {
      held = await acquireLock(lock);
      if (!held) await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
    if (!held) return { status: 'busy' };
    try {
      return { status: 'done', value: await change() };
    } finally {
      await releaseLock(lock);
    }
  },
} as const;
