import { describe, expect, it } from 'vitest';
import { batchesScorers } from '../scorers/batch.js';
import { TeamaiConfigSchema } from '../types.js';

describe('batchesScorers', () => {
  it.each([
    [{ step: true, workflow: false, team: false }, true],
    [{ step: false, workflow: true, team: true }, false],
    [{ workflow: true, team: false }, true],
    [{ workflow: false, team: true }, false],
    [{ team: true }, true],
    [{}, false],
  ])('step > workflow > team > off: %o gives %s', (layers, batched) => {
    expect(batchesScorers(layers)).toBe(batched);
  });
});

describe('team scoring.batch in teamai.yaml', () => {
  const team = { team: 't', repo: 'https://example.test/t.git' };

  it('reads scoring.batch', () => {
    expect(TeamaiConfigSchema.parse({ ...team, scoring: { batch: true } }).scoring).toEqual({ batch: true });
  });

  it.each([
    [{ batch: 'yes' }, {}],
    [3, undefined],
    [{ batch: true, isolation: 'strict' }, { batch: true }],
  ])('drops an unreadable scoring %o instead of rejecting the whole file', (scoring, read) => {
    const parsed = TeamaiConfigSchema.safeParse({ ...team, scoring });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.scoring).toEqual(read);
  });
});
