import { autoDetectInit } from './config.js';
import { setStderrOnly } from './utils/logger.js';
import { nextJudgeLease, parseJudgeRequest, parseJudgeSubmission, submitJudgeLease } from './workflow/scoring.js';
import type { WorkflowEnvelope } from './workflow/types.js';

export interface ScoreOptions {
  next?: boolean;
  lease?: string;
  submit?: boolean;
  json?: string;
  stdin?: boolean;
}

function writeEnvelope(envelope: WorkflowEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  if ('error' in envelope) process.exitCode = 1;
}

function failure(code: string, message: string): WorkflowEnvelope {
  return { error: { code, message } };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function payloadOf(options: ScoreOptions): Promise<{ ok: true; value: unknown } | { ok: false; envelope: WorkflowEnvelope }> {
  if (options.json !== undefined && options.stdin) return { ok: false, envelope: failure('invalid_json', 'Pass the payload with --json or --stdin, not both') };
  const text = options.stdin ? await readStdin() : options.json;
  if (text === undefined || text.trim() === '') return { ok: false, envelope: failure('invalid_json', 'Pass the payload with --json <payload> or --stdin') };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, envelope: failure('invalid_json', 'Could not parse the payload as JSON') };
  }
}

async function score(options: ScoreOptions): Promise<WorkflowEnvelope> {
  if (options.next === (options.lease !== undefined)) {
    return failure('invalid_arguments', 'Pass --next to take judge work, or --lease <ref> --submit to settle it');
  }
  if (options.lease !== undefined && !options.submit) {
    return failure('local_judge_unavailable', 'This teamai cannot run a judge itself yet. Run your own judge on the lease prompt, then: teamai score --lease <ref> --submit --stdin');
  }
  const payload = await payloadOf(options);
  if (!payload.ok) return payload.envelope;
  let config;
  try {
    config = (await autoDetectInit()).localConfig;
  } catch (e) {
    return failure('not_initialized', e instanceof Error ? e.message : String(e));
  }
  if (options.next) {
    const request = parseJudgeRequest(payload.value);
    return typeof request === 'string' ? failure('invalid_json', request) : nextJudgeLease(config, request);
  }
  const submission = parseJudgeSubmission(payload.value);
  if (typeof submission === 'string') return failure('invalid_json', submission);
  return submitJudgeLease(config, options.lease ?? '', submission);
}

/** `teamai score`: judge work for any driver. Prints one JSON envelope. */
export async function scoreCommand(options: ScoreOptions): Promise<void> {
  setStderrOnly(true);
  writeEnvelope(await score(options));
}
