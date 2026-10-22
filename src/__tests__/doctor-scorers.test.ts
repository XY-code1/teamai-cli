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

  it('says nothing when every scorer is valid and known', async () => {
    expect(await scorerNotes(teamRepo({}))).toEqual([]);
  });
});
