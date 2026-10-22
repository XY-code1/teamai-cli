import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scorerNotes } from '../doctor-scorers.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function teamRepo(files: Record<string, string>): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-doctor-scorers-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(knowledge, file)), { recursive: true });
    fs.writeFileSync(path.join(knowledge, file), content);
  }
  return { repo: { localPath: knowledge, remote: 'local' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
}

const SCORER = '---\nlabels:\n  - { value: good, score: 1, description: Good }\n  - { value: bad, score: 0, description: Bad }\npassingScore: 0.5\n---\nJudge.\n';

describe('scorerNotes', () => {
  it('lists invalid scorer files and scorers a step lists that have no valid file, and writes no cache', async () => {
    const config = teamRepo({
      'scorers/eval.yaml': 'name: eval\n',
      'workflows/ship.yaml': 'schemaVersion: v1alpha1\nname: ship\ndescription: Ship it.\nsteps:\n  - id: plan\n    prompt: Plan it.\n    scorers: [nope]\n',
    });

    expect(await scorerNotes(config)).toEqual([
      'Invalid scorer: scorers/eval.yaml: not a scorer file; scorers/ holds <name>.md and <namespace>/<name>.md scorers and an optional README.md',
      'Unknown scorer: workflows/ship.yaml: step "plan" lists scorer "nope", which has no valid scorers/nope.md; the step runs without it',
    ]);
    expect(fs.existsSync(config.dataHome ?? '')).toBe(false);
  });

  it('says why scoring is off while the project keeps its data inside the repository', async () => {
    const config = teamRepo({ 'scorers/q.md': '---\nlabels:\n  - { value: good, score: 1, description: Good }\n  - { value: bad, score: 0, description: Bad }\npassingScore: 0.5\n---\nJudge.\n' });
    const inRepo = { ...config, dataHome: path.join(config.projectRoot ?? '', '.teamai') };

    expect(await scorerNotes(inRepo)).toEqual([expect.stringMatching(/^Scoring is off for this project: its teamai data is still in .*\.teamai, inside the repository.*Run teamai pull/)]);
    expect(await scorerNotes(config)).toEqual(['Scoring isolation: best-effort, the default.']);
  });

  it.each([
    ['scoring:\n  isolation: verified\n', {}, 'Scoring isolation: verified, set by teamai.yaml scoring.isolation.'],
    ['scoring:\n  isolation: best-effort\n', { scoring: { isolation: 'verified' } }, 'Scoring isolation: verified, set by config.yaml scoring.isolation.'],
    ['', { scoring: { isolation: 'strict' } },
      'Scoring isolation: verified, set by config.yaml scoring.isolation. config.yaml scoring.isolation is "strict", which is not verified or best-effort, so it counts as verified.'],
  ])('prints the isolation every judge needs and what sets it: %s %o', async (scoring, machine, line) => {
    const config = { ...teamRepo({ 'scorers/q.md': SCORER, 'teamai.yaml': `team: t\nrepo: https://example.test/t.git\n${scoring}` }), ...machine };

    expect(await scorerNotes(config)).toEqual([line]);
  });

  it('names each scorer file that asks for more isolation than the team and this machine', async () => {
    const verified = SCORER.replace('passingScore: 0.5', 'passingScore: 0.5\nisolation: verified');
    const config = teamRepo({ 'scorers/q.md': SCORER, 'scorers/ops/strict.md': verified, 'scorers/strict-too.md': verified });

    expect(await scorerNotes(config)).toEqual(['Scoring isolation: best-effort, the default. scorers/ops/strict.md and scorers/strict-too.md ask for verified for their own work.']);
  });

  it('says nothing when every scorer is valid and known', async () => {
    expect(await scorerNotes(teamRepo({}))).toEqual([]);
  });
});
