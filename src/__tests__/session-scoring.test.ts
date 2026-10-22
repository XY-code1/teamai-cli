import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocks.home, default: { ...actual, homedir: () => mocks.home } };
});

import type { LocalConfig } from '../types.js';
import { localAliasesPath } from '../models/aliases.js';
import { AttemptStore } from '../scorers/attempts.js';
import { parseScoreLabels } from '../scorers/label.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { encodeCwdClaude } from '../session-flow/fs.js';
import { AGENT_SESSION_ENV } from '../utils/session-id.js';
import { scoreSession } from '../session-flow/scoring.js';
import type { WorkflowEnvelope } from '../workflow/types.js';

const SCORER = `---
labels:
  - { value: good, score: 1, description: Did the work }
  - { value: bad, score: 0, description: Did not }
passingScore: 0.5
samplingRate: 0
---
Judge the session.
`;

const SESSION = '7c1e0000-0000-4000-8000-000000000001';

let root = '';
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-scoring-')));
  mocks.home = path.join(root, 'home');
  fs.mkdirSync(path.join(mocks.home, '.claude', 'projects'), { recursive: true });
  for (const name of AGENT_SESSION_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HOME', mocks.home);
  vi.stubEnv('USERPROFILE', mocks.home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function data(envelope: WorkflowEnvelope): Record<string, unknown> {
  if ('error' in envelope) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  return envelope.data;
}

async function fixture(scorers: Record<string, string> = { quality: SCORER }): Promise<LocalConfig> {
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
  for (const [name, text] of Object.entries(scorers)) fs.writeFileSync(path.join(knowledge, 'scorers', `${name}.md`), text);
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data'),
  };
  await syncScorerDefinitions(config);
  return config;
}

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

function plantClaudeSession(cwd: string, prompt: string): void {
  const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`),
    line({ type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: prompt } })
    + line({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Added the retries.' }] } }));
}

function plantSubagentEdit(cwd: string): void {
  const dir = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd), SESSION, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-a.meta.json'), JSON.stringify({ toolUseId: 'toolu_1', spawnDepth: 1 }));
  fs.writeFileSync(path.join(dir, 'agent-a.jsonl'),
    line({ type: 'user', uuid: 'a1', parentUuid: null, isSidechain: true, message: { role: 'user', content: 'Add the retry loop' } })
    + line({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', isSidechain: true,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Edit', input: { file_path: 'src/client.ts', new_string: 'retryWithBackoff()' } }] } }));
}

/**
 * A Claude judge on PATH that answers as model `m1`, with `{ label: answer }` or the batch answer it is given, keeps the
 * prompt file it was given in `<root>/judged.md` and the transcript file in `<root>/judged-transcript.md`, and counts
 * its calls in `<root>/calls`.
 */
function fakeClaude(answer: string | Record<string, unknown>): void {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
const at = process.argv.indexOf('--append-system-prompt-file');
fs.copyFileSync(process.argv[at + 1], ${JSON.stringify(path.join(root, 'judged.md'))});
fs.copyFileSync(require('node:path').join('transcripts', 'session.md'), ${JSON.stringify(path.join(root, 'judged-transcript.md'))});
fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, 'x');
process.stdin.resume(); process.stdin.on('end', () => {
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm1' }));
console.log(JSON.stringify({ type: 'result', structured_output: ${JSON.stringify(typeof answer === 'string' ? { label: answer, reasoning: 'the reasoning' } : answer)} }));
});\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`);
}

/**
 * A member scope in `~/.teamai` whose team repo is `kind` and holds the scorers, the session planted in `<root>/app`
 * under it, and the config of another scope, which has none of them.
 */
async function scopedElsewhere(kind: 'self' | 'http'): Promise<{ userHome: string; elsewhere: LocalConfig }> {
  const knowledge = (await fixture()).repo.localPath;
  const userHome = path.join(mocks.home, '.teamai');
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(path.join(userHome, 'config.yaml'), `repo:\n  localPath: ${knowledge}\n  remote: local\n  kind: ${kind}\nusername: tester\nscope: user\nadditionalRoles: []\n`);
  await syncScorerDefinitions({ repo: { localPath: knowledge, remote: 'local', kind }, username: 'tester', scope: 'user', additionalRoles: [] });
  plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
  fakeClaude('good');
  const elsewhere: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' }, username: 'tester', scope: 'project',
    projectRoot: path.join(root, 'elsewhere'), additionalRoles: [], dataHome: path.join(root, 'elsewhere-data'),
  };
  return { userHome, elsewhere };
}

describe('teamai score --session', () => {
  it('judges a Claude session and keeps one session label with the model the judge reported', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }))).toMatchObject({
      label: { scorer: 'quality', label: 'good', score: 1, passed: true },
    });
    const labels = parseScoreLabels(fs.readFileSync(path.join(root, 'data', 'scores', 'labels.jsonl'), 'utf8'));
    expect(labels).toEqual([expect.objectContaining({
      source: 'session', subject: { platform: 'claude-code', sessionId: SESSION }, judge: expect.objectContaining({ kind: 'model', tool: 'claude', model: { reported: 'm1' } }),
    })]);
    expect(fs.readdirSync(path.join(root, 'data', 'scores', 'reasoning'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'judged.md'), 'utf8')).toContain('Add retries to the client');
  });

  it('records the model the judge launched with, the one it reported, and the scorer\'s alias', async () => {
    const config = await fixture({ quality: SCORER.replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast') });
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    claude: haiku\n');
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    expect(parseScoreLabels(fs.readFileSync(path.join(root, 'data', 'scores', 'labels.jsonl'), 'utf8')).map((label) => label.judge))
      .toEqual([expect.objectContaining({ tool: 'claude', model: { requested: 'haiku', reported: 'm1', alias: 'fast' } })]);
  });

  it('says which judge tools the scorer\'s alias has no model for, and in which file', async () => {
    const config = await fixture({ quality: SCORER.replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast') });
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    codebuddy: cb-model\n');
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');
    vi.stubEnv('PATH', [path.join(root, 'bin'), '/usr/bin', '/bin'].join(path.delimiter));

    expect(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] })).toEqual({ error: {
      code: 'judge_model_unavailable',
      message: 'Scorer "quality" asks for model alias "fast", which has no model for claude in models/aliases.yaml. Add one, or remove model from the scorer.',
    } });
  });

  it('says why the tool default judges when the member\'s ~ entry turns the scorer\'s alias off', async () => {
    const config = await fixture({ quality: SCORER.replace('samplingRate: 0', 'samplingRate: 0\nmodel: fast') });
    fs.mkdirSync(path.join(config.repo.localPath, 'models'));
    fs.writeFileSync(path.join(config.repo.localPath, 'models', 'aliases.yaml'), 'aliases:\n  fast:\n    claude: haiku\n');
    fs.mkdirSync(path.dirname(localAliasesPath()), { recursive: true });
    fs.writeFileSync(localAliasesPath(), 'aliases:\n  fast:\n    claude: ~\n');
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    const notes = printed.mock.calls.map((call) => call.join(' ')).filter((text) => text.includes('ℹ') && text.includes('model alias'));
    expect(notes).toEqual([expect.stringContaining(`Scorer "quality" asks for model alias "fast", which ${localAliasesPath()} turns off for claude, so claude judges with its default model.`)]);
    expect(parseScoreLabels(fs.readFileSync(path.join(root, 'data', 'scores', 'labels.jsonl'), 'utf8')).map((label) => label.judge))
      .toEqual([expect.objectContaining({ model: { reported: 'm1', alias: 'fast' } })]);
  });

  it('names only the files a session evidence directory holds', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    const judged = fs.readFileSync(path.join(root, 'judged.md'), 'utf8');
    expect(judged).toContain('hold the same evidence: transcripts/session.md and evidence.json.');
    expect(judged).not.toContain('diff.patch');
  });

  it('never guesses the session: outside any session and without --session it fails before any judge runs', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(await scoreSession(config, { scorers: ['quality'] })).toEqual({
      error: { code: 'session_required', message: 'Pass --session <id>; scoring never guesses the session.' },
    });
    expect(fs.existsSync(path.join(root, 'judged.md'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'labels.jsonl'))).toBe(false);
  });

  it('scores the session whose agent variable is set, without --session or --source', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', SESSION);

    expect(data(await scoreSession(config, { scorers: ['quality'] }))).toMatchObject({
      label: { subject: { platform: 'claude-code', sessionId: SESSION }, label: 'good' },
    });
  });

  it('asks for --source when nothing names the platform of --session, and lists the platforms that hold it', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(await scoreSession(config, { session: SESSION, scorers: ['quality'] })).toEqual({
      error: { code: 'source_required', message: expect.stringMatching(/^Pass --source with --session .*Found in: claude-code\.$/) },
    });
    expect(fs.existsSync(path.join(root, 'judged.md'))).toBe(false);
  });

  it('gives the judge the tool calls of the subagents the session started', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    plantSubagentEdit(path.join(root, 'app'));
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    expect(fs.readFileSync(path.join(root, 'judged.md'), 'utf8')).toMatch(/## Subagent \(depth 1[^)]*\)[\s\S]*\[tool_call\] edit_file .*retryWithBackoff/);
  });

  it('fails without a label when no tool here can judge', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    const empty = path.join(root, 'empty-bin');
    fs.mkdirSync(empty);
    vi.stubEnv('PATH', empty);

    expect(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] })).toEqual({
      error: { code: 'judge_tool_unavailable', message: 'No installed tool can run a scorer judge with every tool turned off. Install a supported version of Claude Code, Codex or OpenCode.' },
    });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'labels.jsonl'))).toBe(false);
  });

  it('refuses a Codex id that is the end of two sessions\' ids, names both, and runs no judge', async () => {
    const config = await fixture();
    const ids = ['019a0000-0000-7000-8000-0000000000bb', '019b0000-0000-7000-9000-0000000000bb'];
    const day = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    for (const [index, id] of ids.entries()) {
      fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-0${index}-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, timestamp: '2026-10-20T10:00:00.000Z', cwd: path.join(root, `app-${index}`) } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Work on app ${index}` }] } },
      ].map(line).join(''));
    }
    fakeClaude('good');

    expect(await scoreSession(config, { session: '0000000000bb', source: 'codex', scorers: ['quality'] })).toEqual({
      error: { code: 'session_ambiguous', message: `--session 0000000000bb names more than one codex session: ${ids.join(', ')}. Pass the whole id of one.` },
    });
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
  });

  it('refuses a Codex id that is the end of an active and an archived session\'s ids, and runs no judge', async () => {
    const config = await fixture();
    const ids = ['019a0000-0000-7000-8000-0000000000bb', '019b0000-0000-7000-9000-0000000000bb'];
    for (const [index, id] of ids.entries()) {
      const dir = path.join(mocks.home, '.codex', index === 0 ? path.join('sessions', '2026', '10', '20') : 'archived_sessions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `rollout-2026-10-20T12-00-0${index}-${id}.jsonl`), [
        { type: 'session_meta', payload: { id, timestamp: '2026-10-20T10:00:00.000Z', cwd: path.join(root, `app-${index}`) } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Work on app ${index}` }] } },
      ].map(line).join(''));
    }
    fakeClaude('good');

    expect(await scoreSession(config, { session: '0000000000bb', source: 'codex', scorers: ['quality'] })).toEqual({
      error: { code: 'session_ambiguous', message: `--session 0000000000bb names more than one codex session: ${ids.join(', ')}. Pass the whole id of one.` },
    });
    expect(fs.existsSync(path.join(root, 'calls'))).toBe(false);
  });

  it('prints the first prompt of a Codex session after the AGENTS.md block Codex injects', async () => {
    const config = await fixture();
    const id = '019a0000-0000-7000-8000-0000000000aa';
    const cwd = path.join(root, 'app');
    const day = path.join(mocks.home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    const message = (role: string, text: string): unknown => ({ timestamp: '2026-10-20T10:00:02.000Z', type: 'response_item',
      payload: { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] } });
    fs.writeFileSync(path.join(day, `rollout-2026-10-20T12-00-00-${id}.jsonl`), [
      { timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: { id, timestamp: '2026-10-20T10:00:00.000Z', cwd, originator: 'codex_cli_rs', cli_version: '0.163.0' } },
      message('user', `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\n# Team rules\n\nAlways write tests.\n</INSTRUCTIONS>`),
      message('user', `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`),
      message('user', 'Add retries to the client'),
      message('assistant', 'Added the retries.'),
    ].map(line).join(''));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await scoreSession(config, { session: id, source: 'codex', scorers: ['quality'] }));
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('First prompt: Add retries to the client');
  });

  it('prints the session before judging, then the verdict, and the share line naming the session only when the label did not pass', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    const output = (): string => printed.mock.calls.map((call) => call.join(' ')).join('\n');

    fakeClaude('good');
    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    expect(output()).toContain(`in ${path.join(root, 'app')}`);
    expect(output()).toContain('First prompt: Add retries to the client');
    expect(output()).toMatch(/quality: good \(score 1, passed\)\. Reasoning: .*\.md/);
    expect(output()).not.toContain('To share what went wrong');

    printed.mockClear();
    fakeClaude('bad');
    const failed = data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    const { reasoning } = z.object({ label: z.object({ reasoning: z.string() }) }).parse(failed).label;
    expect(output()).toContain('quality: bad (score 0, did not pass)');
    expect(output()).toContain(`To share what went wrong, ask your agent to read ${reasoning} and share it with the team (teamai contribute --session-id ${SESSION}).`);
  });

  it('keeps the start and the end of a session longer than 200,000 characters and tells the judge how much was cut', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), `Start here. ${'Add the retry loop to the client. '.repeat(9_000)}`);
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    const judged = fs.readFileSync(path.join(root, 'judged.md'), 'utf8');
    expect(judged).toContain('Start here.');
    expect(judged).toContain('Added the retries.');
    expect(Number(/\[\.\.\. (\d+) characters of evidence were cut here/.exec(judged)?.[1])).toBeGreaterThan(100_000);
  });

  it('gives the judge a transcript file cut as the prompt\'s evidence is, with one note of how much was cut', async () => {
    const config = await fixture();
    const prose = 'Add the retry loop to the client. '.repeat(6_000);
    plantClaudeSession(path.join(root, 'app'), `Start here. ${prose}MIDDLE_OF_THE_SESSION ${prose}`);
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    const judged = fs.readFileSync(path.join(root, 'judged.md'), 'utf8');
    const transcript = fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8');
    expect(transcript.length).toBeLessThanOrEqual(200_000);
    expect(transcript).not.toContain('MIDDLE_OF_THE_SESSION');
    expect(judged).toContain(transcript);
    expect(judged.match(/characters of evidence were cut here/g)).toHaveLength(1);
  });

  it('writes no label when the answer names no label of the scorer, and keeps the raw answer', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('excellent');

    const answer = await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] });
    expect(answer).toEqual({ error: { code: 'judge_answer_invalid', message: expect.stringContaining('"excellent" is not a label of scorer quality') } });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'labels.jsonl'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'data', 'scores', 'raw'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(root, 'data', 'scores', 'evidence'))).toEqual([]);
  });

  it('names the cached scorers when asked for one that is not cached', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    expect(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['nope'] })).toEqual({
      error: { code: 'scorer_not_found', message: 'Scorer nope is not cached here. Scorers: quality.' },
    });
    expect(fs.existsSync(path.join(root, 'judged.md'))).toBe(false);
  });

  it('shares one judge call between scorers with --batch, and marks their labels batched', async () => {
    const config = await fixture({ quality: SCORER, tests: SCORER });
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude({ quality: { label: 'good', reasoning: 'r1' }, tests: { label: 'bad', reasoning: 'r2' } });

    expect(data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality', 'tests'], batch: true }))).toMatchObject({
      labels: [{ scorer: 'quality', label: 'good' }, { scorer: 'tests', label: 'bad' }],
    });
    expect(fs.readFileSync(path.join(root, 'calls'), 'utf8')).toBe('x');
    expect(parseScoreLabels(fs.readFileSync(path.join(root, 'data', 'scores', 'labels.jsonl'), 'utf8')).map((label) => label.judge))
      .toEqual([expect.objectContaining({ batched: true }), expect.objectContaining({ batched: true })]);
  });

  it('prints and heads the reasoning file with the member\'s own first prompt when it names a file and loads a skill', async () => {
    const config = await fixture();
    const cwd = path.join(root, 'app');
    const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
    fs.mkdirSync(project, { recursive: true });
    const asked = 'Call the Skill tool with skill "review-notes", then read .claude/skills/deploy-notes/SKILL.md.';
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), [
      { type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: asked } },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z',
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Skill', input: { skill: 'review-notes' } }] } },
      { type: 'user', uuid: 'u3', parentUuid: 'u2', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: review-notes' }] } },
      { type: 'user', uuid: 'u4', parentUuid: 'u3', isMeta: true, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${cwd}/.claude/skills/review-notes\n\nHow this team reviews a change.\n` }] } },
      { type: 'assistant', uuid: 'u5', parentUuid: 'u4', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:04.000Z',
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'done' }] } },
    ].map(line).join(''));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    const { reasoning } = z.object({ label: z.object({ reasoning: z.string() }) }).parse(data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }))).label;
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain(`First prompt: ${asked}`);
    expect(fs.readFileSync(reasoning, 'utf8')).toContain(`prompt: ${asked}`);
  });

  it('prints the /name args the member typed as the first prompt, not the skill body it loads', async () => {
    const config = await fixture();
    const cwd = path.join(root, 'app');
    const project = path.join(mocks.home, '.claude', 'projects', encodeCwdClaude(cwd));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), [
      { type: 'user', uuid: 'u1', parentUuid: null, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:00.000Z',
        message: { role: 'user', content: '<command-message>review-notes</command-message>\n<command-name>/review-notes</command-name>\n<command-args>check the README</command-args>' } },
      { type: 'user', uuid: 'u2', parentUuid: 'u1', isMeta: true, cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `Base directory for this skill: ${cwd}/.claude/skills/review-notes\n\nHow this team reviews a change.\n\n\nARGUMENTS: check the README` }] } },
      { type: 'assistant', uuid: 'u3', parentUuid: 'u2', cwd, sessionId: SESSION, timestamp: '2026-10-20T10:00:02.000Z',
        message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'REVIEWED' }] } },
    ].map(line).join(''));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('First prompt: /review-notes check the README');
  });

  it('prints the whole /name args the member typed when the args hold a less-than sign', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), '<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>check whether attempts < 3 in src/client.ts</command-args>');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    expect(printed.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('First prompt: /review check whether attempts < 3 in src/client.ts');
  });

  it('heads the reasoning file with the session\'s redacted first prompt', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries with key sk-ABCDEFGH1234567890abcdefghij');
    fakeClaude('good');

    const { reasoning } = z.object({ label: z.object({ reasoning: z.string() }) }).parse(data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }))).label;
    const header = fs.readFileSync(reasoning, 'utf8').split('\n\n')[0] ?? '';
    expect(header).toMatch(/^prompt: Add retries with key /m);
    expect(header).not.toContain('sk-ABCDEFGH1234567890abcdefghij');
  });

  it('masks the value of a secret the team declares, whatever its name, in the evidence and the first prompt', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const config = await fixture();
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: WAREHOUSE_DSN\n');
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    plantClaudeSession(path.join(root, 'app'), `Add retries against ${dsn}`);
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    fakeClaude('good');

    const { reasoning } = z.object({ label: z.object({ reasoning: z.string() }) }).parse(data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }))).label;

    expect(fs.readFileSync(path.join(root, 'judged.md'), 'utf8')).toContain('Add retries against');
    for (const text of [fs.readFileSync(path.join(root, 'judged.md'), 'utf8'), fs.readFileSync(path.join(root, 'judged-transcript.md'), 'utf8'), fs.readFileSync(reasoning, 'utf8'), printed.mock.calls.flat().join('\n')]) {
      expect(text).not.toContain(dsn);
    }
  });

  it('masks a secret the team declares in the scorer\'s prompt as well', async () => {
    const dsn = 'mysql-prod-7Hq2xVb9Lk';
    const config = await fixture({ quality: SCORER.replace('Judge the session.', `Judge the session. Never print ${dsn}.`) });
    fs.mkdirSync(path.join(config.repo.localPath, 'env'), { recursive: true });
    fs.writeFileSync(path.join(config.repo.localPath, 'env', 'secrets.yaml'), 'secrets:\n  - key: WAREHOUSE_DSN\n');
    vi.stubEnv('WAREHOUSE_DSN', dsn);
    plantClaudeSession(path.join(root, 'app'), 'Add retries');
    fakeClaude('good');

    data(await scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));

    const judged = fs.readFileSync(path.join(root, 'judged.md'), 'utf8');
    expect(judged).toContain('Judge the session. Never print');
    expect(judged).not.toContain(dsn);
  });

  it('keeps the label in the scope the session ran in, also when it is scored from another one', async () => {
    const { userHome, elsewhere } = await scopedElsewhere('self');

    data(await scoreSession(elsewhere, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));

    expect(parseScoreLabels(fs.readFileSync(path.join(userHome, 'scores', 'labels.jsonl'), 'utf8'))).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'elsewhere-data', 'scores'))).toBe(false);
  });

  it('publishes from the scope the session ran in with push, also when it is scored from another one', async () => {
    const { userHome, elsewhere } = await scopedElsewhere('http');

    expect(await scoreSession(elsewhere, { session: SESSION, source: 'claude-code', scorers: ['quality'], push: true })).toEqual({
      error: { code: 'unsupported_repo', message: 'Publishing score labels needs a team repo with a teamai-reports branch; an http team repo has none, so labels stay on this machine.' },
    });
    expect(fs.readdirSync(path.join(userHome, 'scores', 'pending'))).toHaveLength(1);
  });

  it('writes the label under the lock a push takes, so a push never drops it', async () => {
    const config = await fixture();
    plantClaudeSession(path.join(root, 'app'), 'Add retries to the client');
    fakeClaude('good');

    const held = await AttemptStore.locked(config, () => scoreSession(config, { session: SESSION, source: 'claude-code', scorers: ['quality'] }));
    expect(held).toMatchObject({ status: 'done', value: { error: { code: 'busy' } } });
    expect(fs.existsSync(path.join(root, 'data', 'scores', 'labels.jsonl'))).toBe(false);
  });
});
