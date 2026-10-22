/**
 * Judging a finished agent session with team scorers (#1178), on the judge, evidence and label store `src/scorers/`
 * keeps for every subject. The session is read redacted and goes only to the local judge; only its labels are published.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { observedModel } from '../agent-observation.js';
import { loadTeamConfig } from '../config.js';
import { collectTeamSecrets } from '../env-resolution.js';
import { loadModelAliases } from '../models/aliases.js';
import { AttemptStore, newAttemptId, scoresDir } from '../scorers/attempts.js';
import { batchesScorers, verdictsOf } from '../scorers/batch.js';
import { cachedScorerNames, pinScorers } from '../scorers/cache.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import {
  answerSchema, evidenceDirOf, fencedEvidence, keepEnds, rubricPrompt, writeEvidence,
  EVIDENCE_MAX_CHARS, TOOL_CALL_MAX_CHARS, type EvidenceGap, type Rubrics,
} from '../scorers/evidence.js';
import { scoringUnavailable } from '../scorers/home.js';
import { requiredIsolation, scopeIsolation, scorerIsolationSource } from '../scorers/isolation.js';
import { installedJudgeTools, runLocalJudge, type JudgeTool } from '../scorers/judge.js';
import { chooseJudgeModel } from '../scorers/judge-model.js';
import type { ScoreLabel } from '../scorers/label.js';
import { LabelStore, reasoningPath, shareFailedLabelHint } from '../scorers/label-store.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import { typedIn } from '../skill-use.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import { collectEnvSecrets, redact } from '../utils/redact.js';
import type { WorkflowEnvelope } from '../workflow/types.js';
import { agentSessionFromEnv } from '../utils/session-id.js';
import { AgentSession } from './agent-session.js';
import { listAvailablePlatforms, listInstalledPlatforms } from './adapters/index.js';
import type { SubagentsRead } from './adapters/base.js';
import type { Session } from './ir.js';

function failure(code: string, message: string): WorkflowEnvelope {
  return { error: { code, message } };
}

function transcriptOf(session: Session, budget: number): string {
  const capped: Session = {
    ...session,
    messages: session.messages.map((message) => ({ ...message, content: message.content.map((block) =>
      block.type === 'tool_call' ? { ...block, arguments: { excerpt: keepEnds(JSON.stringify(block.arguments), TOOL_CALL_MAX_CHARS) } } : block) })),
  };
  return keepEnds(AgentSession.transcript(capped).map((entry) => `### ${entry.role}\n${entry.text}\n${entry.toolOutput}`).join('\n\n'), budget);
}

/** A read session's transcript followed by each of its subagents', each kept to its budget, and what of them could not be read. */
export function judgedTranscript(found: { session: Session; subagents?: SubagentsRead }, budget: { session: number; subagent: number }): { body: string; gaps: EvidenceGap[] } {
  const gaps: EvidenceGap[] = [];
  let body = transcriptOf(found.session, budget.session);
  if (found.subagents?.status !== 'read') gaps.push('subagents_unread');
  else for (const agent of found.subagents.agents) {
    if (agent.start === 'unknown') gaps.push('subagent_boundary_unknown');
    body += `\n\n## Subagent (depth ${agent.depth}${agent.finished === false ? ', not finished' : ''})\n\n${transcriptOf(agent.session, budget.subagent)}`;
  }
  return { body, gaps };
}

/** What `teamai score --session <id> [--source <platform>] --scorer <name>… [--batch]` asks for. */
export interface SessionDemand {
  session?: string;
  source?: string;
  scorers: readonly [string, ...string[]];
  batch?: boolean;
}

interface Asked {
  scorer: string;
  pin: PinnedScorer;
  definition: ScorerDefinition;
  /** The scorer's `model` when it is an alias, also when the tool default judges in its place. */
  alias?: string;
}

async function sessionOf(demand: SessionDemand): Promise<{ platform: string; sessionId: string } | Extract<WorkflowEnvelope, { error: unknown }>> {
  const env = await agentSessionFromEnv();
  const current = env.unambiguous && env.id ? { sessionId: env.id, platform: env.agent && AgentSession.platformForTool(env.agent) } : undefined;
  const sessionId = demand.session ?? current?.sessionId;
  if (sessionId === undefined) return { error: { code: 'session_required', message: 'Pass --session <id>; scoring never guesses the session.' } };
  const platform = demand.source ?? (current?.sessionId === sessionId ? current.platform : undefined);
  if (platform !== undefined) return { platform, sessionId };
  const holding: string[] = [];
  for (const candidate of listInstalledPlatforms()) {
    if ((await AgentSession.find({ platform: candidate, sessionId }, { scrub: false })).status === 'done') holding.push(candidate);
  }
  return { error: { code: 'source_required', message: holding.length > 0
    ? `Pass --source with --session ${sessionId}: the platform that holds it. Found in: ${holding.join(', ')}.`
    : `No installed tool holds session ${sessionId}. Pass --source <platform> to read it from one of: ${listAvailablePlatforms().join(', ')}.` } };
}

function firstPrompt(session: Session): string {
  const text = session.messages.flatMap((message) => message.content.map((block) => typedIn(message, block))).find((typed) => typed !== '') ?? '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** The config of the scope a session ran in, found from its directory as the hooks that captured it found it, else `config`. */
async function scopeOf(config: LocalConfig, platform: string, session: Session): Promise<LocalConfig> {
  if (!session.cwd) return config;
  const { resolveHookConfig } = await import('../dashboard-collector.js');
  return await resolveHookConfig({ cwd: session.cwd, session_id: session.sessionId }, AgentSession.toolForPlatform(platform)) ?? config;
}

/**
 * Judges one finished session with the named scorers, whatever their sampling says, and keeps one label per scorer on
 * this machine, in the scope the session ran in, whichever scope `from` is. Scorers that resolve to the same tool and
 * model share one judge call with `batch` or the team's `scoring.batch`.
 */
export async function scoreSession(from: LocalConfig, demand: SessionDemand, now = new Date().toISOString()): Promise<WorkflowEnvelope> {
  const named = await sessionOf(demand);
  if ('error' in named) return named;
  const { platform, sessionId } = named;
  const found = await AgentSession.find({ platform, sessionId }, { subagents: true });
  if (found.status !== 'done') return failure('session_not_found', found.failure.message);
  const { session } = found;
  if (session.sessionId !== sessionId) {
    const ids = (await AgentSession.list({ platforms: [platform], archived: true })).sessions.map((listed) => listed.sessionId).filter((id) => id.endsWith(sessionId)).sort();
    if (ids.length > 1) return failure('session_ambiguous', `--session ${sessionId} names more than one ${platform} session: ${ids.join(', ')}. Pass the whole id of one.`);
  }
  const config = await scopeOf(from, platform, session);
  const unavailable = scoringUnavailable(config);
  if (unavailable) return failure('scoring_unavailable', unavailable);
  const pins = await pinScorers(config, demand.scorers);
  const asked: Asked[] = [];
  for (const scorer of new Set(demand.scorers)) {
    const pin = pins[scorer];
    const definition = pin && pinnedDefinition(scorer, pin);
    if (!pin || !definition) {
      const known = await cachedScorerNames(config);
      return failure('scorer_not_found', `Scorer ${scorer} is not cached here. ${known.length > 0 ? `Scorers: ${known.join(', ')}.` : 'Run teamai pull to cache the team\'s scorers.'}`);
    }
    asked.push({ scorer, pin, definition });
  }
  log.info(`Scoring ${platform} session ${session.sessionId} in ${session.cwd || '(directory unknown)'}`);
  const envSecrets = { ...collectEnvSecrets(), ...await collectTeamSecrets(config) };
  const mask = (text: string): string => redact(text, { envSecrets });
  const prompt = mask(firstPrompt(session));
  log.info(`First prompt: ${prompt || '(none)'}`);

  const tools = installedJudgeTools([]);
  if (tools.length === 0) {
    return failure('judge_tool_unavailable', 'No installed tool can run a scorer judge with every tool turned off. Install a supported version of Claude Code, Codex or OpenCode.');
  }
  const aliases = await loadModelAliases(config);
  const team = await loadTeamConfig(config.repo.localPath);
  const batch = demand.batch || batchesScorers({ team: team?.scoring?.batch });
  const groups: Array<{ choice: { tool: JudgeTool; model?: { name: string; effort?: string } }; members: [Asked, ...Asked[]] }> = [];
  for (const member of asked) {
    const chosen = chooseJudgeModel(aliases, member.definition, tools);
    if (!chosen.ok) return failure('judge_model_unavailable', chosen.message);
    if (chosen.note) log.info(chosen.note);
    const judged = { ...member, ...(chosen.choice.alias !== undefined ? { alias: chosen.choice.alias } : {}) };
    const group = batch ? groups.find(({ choice }) => choice.tool === chosen.choice.tool && choice.model?.name === chosen.choice.model?.name && choice.model?.effort === chosen.choice.model?.effort) : undefined;
    if (group) group.members.push(judged);
    else groups.push({ choice: chosen.choice, members: [judged] });
  }
  const scope = await scopeIsolation(config);
  const judged = judgedTranscript(found, { session: Number.POSITIVE_INFINITY, subagent: Number.POSITIVE_INFINITY });
  const subject = { platform, sessionId: session.sessionId };
  const manifest = { subject, kind: 'session', gaps: judged.gaps };
  const framing = `## evidence.json\n\n${JSON.stringify(manifest)}\n\n## transcripts/session.md\n\n`.length;
  const body = keepEnds(mask(judged.body), EVIDENCE_MAX_CHARS - framing);
  const answers: Array<Record<string, unknown>> = [];
  for (const { choice, members } of groups) {
    const [head, ...tail] = members;
    const rubrics: Rubrics = [head.definition, ...tail.map((member) => member.definition)];
    const attempt = newAttemptId();
    const evidence = evidenceDirOf(scoresDir(config), attempt);
    try {
      await writeEvidence(evidence, async (tmp) => {
        await fs.mkdir(path.join(tmp, 'transcripts'));
        await fs.writeFile(path.join(tmp, 'transcripts', 'session.md'), body);
        await fs.writeFile(path.join(tmp, 'evidence.json'), JSON.stringify(manifest, null, 2));
        await fs.writeFile(path.join(tmp, 'prompt.md'), mask(rubricPrompt(rubrics)) + fencedEvidence([
          { title: 'evidence.json', body: JSON.stringify(manifest) },
          { title: 'transcripts/session.md', body },
        ], 'transcripts/session.md and evidence.json'));
      });
      const isolation = requiredIsolation([...scope, ...members.map(({ scorer, definition }) => ({ source: scorerIsolationSource(scorer), value: definition.isolation }))]).level;
      const result = await runLocalJudge({ tool: choice.tool, model: choice.model, evidence, schema: answerSchema(rubrics), isolation });
      const verdicts = result.ok ? verdictsOf(members, (member) => member.definition, result.answer) : undefined;
      if (!result.ok || !verdicts?.ok) {
        const raw = result.ok ? JSON.stringify(result.answer) : result.raw;
        let saved = '';
        if (raw !== undefined) {
          const file = path.join(scoresDir(config), 'raw', `${attempt}.txt`);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, raw, { mode: 0o600 });
          saved = ` Output saved to ${file}.`;
        }
        return result.ok
          ? failure('judge_answer_invalid', `The judge's answer names no label of the scorer: ${verdicts && !verdicts.ok ? verdicts.message : ''} No label was written.${saved}`)
          : failure(result.code, result.message + saved);
      }
      const labels = verdicts.verdicts.map(({ judged, label, passed, reasoning }) => {
        const model = observedModel({ ...result.judge.model, alias: judged.alias });
        return { reasoning, label: {
          scorer: judged.scorer,
          rubric: { sourceHash: judged.pin.sourceHash, ...(judged.pin.teamRevision ? { teamRevision: judged.pin.teamRevision } : {}) },
          label: label.value,
          score: label.score,
          passed,
          source: 'session',
          subject,
          judge: { kind: 'model', ...result.judge, ...(model ? { model } : {}), ...(members.length > 1 ? { batched: true as const } : {}) },
          scoredAt: now,
        } satisfies ScoreLabel };
      });
      const stored = await AttemptStore.locked(config, async () => {
        const kept: Array<{ label: ScoreLabel; id: string; version: string }> = [];
        for (const { label, reasoning } of labels) kept.push({ label, ...await LabelStore.append(config, label, reasoning, prompt) });
        return kept;
      });
      if (stored.status === 'busy') return failure('busy', 'Another teamai process holds the label store, so no label was written. Score the session again.');
      for (const { label, id, version } of stored.value) {
        const file = reasoningPath(config, version);
        log.info(`${label.scorer}: ${label.label} (score ${label.score}, ${label.passed ? 'passed' : 'did not pass'}). Reasoning: ${file}`);
        if (!label.passed) log.info(shareFailedLabelHint(file, session.sessionId));
        answers.push({ scorer: label.scorer, subject, label: label.label, score: label.score, passed: label.passed, labelId: id, reasoning: file });
      }
    } finally {
      await fs.rm(evidence, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  const [only, ...more] = answers;
  return { data: only && more.length === 0 ? { label: only } : { labels: answers } };
}
