import { isModelAlias, noModelCause, noModelReason, resolveModelValue, type ModelAliases, type ModelResolution, type NoModel } from '../models/aliases.js';
import { ALL_SUPPORTED_TOOLS } from '../resources/agent-format.js';
import type { LeasedAttempt } from './attempts.js';
import type { ScorerDefinition } from './definition.js';

const ON_NO_MODEL = {
  local: { by: 'tool_default', noModel: 'local' },
  switched: { by: 'tool_default', noModel: 'switched' },
  unmapped: undefined, unresolved: undefined,
} as const satisfies Record<NoModel, Pick<LeasedAttempt['judge'], 'by' | 'noModel'> | undefined>;

const NO_MODEL_FIX = { unmapped: 'Add one, or remove model from the scorer.', unresolved: 'Fix that, or remove model from the scorer.' } as const;

/** CodeBuddy's judge launch passes no effort, so its judges run without an alias's. */
const NO_EFFORT: ReadonlySet<string> = new Set(['codebuddy']);

export type JudgeModelChoice =
  /** `note` says why the tool default judges in place of the scorer's alias. */
  | { ok: true; choice: Pick<LeasedAttempt['judge'], 'tool' | 'model' | 'by' | 'noModel' | 'alias'>; note?: string }
  | { ok: false; code: 'judge_model_unavailable'; reason: keyof typeof NO_MODEL_FIX; message: string };

/**
 * The first of `tools` that gives the scorer's `model` a model, or that the member's `~` entry or a model switch sends
 * to its own default. An alias no tool maps, or that cannot be resolved, is unavailable.
 */
export function chooseJudgeModel(aliases: ModelAliases, scorer: Pick<ScorerDefinition, 'name' | 'model'>, tools: readonly string[]): JudgeModelChoice {
  const { model } = scorer;
  const isAlias = model !== undefined && isModelAlias(aliases, model);
  const asked = isAlias ? `model alias "${model}"` : `model "${model}"`;
  const alias = isAlias ? { alias: model } : {};
  const unmapped: string[] = [];
  let unmappedBy: ModelResolution = { ok: true, step: 'default' };
  for (const tool of tools) {
    if (model === undefined) return { ok: true, choice: { tool, by: 'tool_default' } };
    const supported = ALL_SUPPORTED_TOOLS.find((name) => name === tool);
    if (!supported) {
      unmapped.push(tool);
      continue;
    }
    const resolved = resolveModelValue(aliases, model, supported);
    if (resolved.ok && resolved.model !== undefined) {
      const effort = resolved.effort !== undefined && !NO_EFFORT.has(tool) ? { effort: resolved.effort } : {};
      return { ok: true, choice: { tool, by: 'scorer', model: { name: resolved.model, ...effort }, ...alias } };
    }
    const reason = noModelReason(resolved);
    const policy = ON_NO_MODEL[reason];
    if (policy) {
      return { ok: true, choice: { tool, ...policy, ...alias }, note: `Scorer "${scorer.name}" asks for ${asked}, which ${noModelCause(resolved, tool)}, so ${tool} judges with its default model.` };
    }
    if (reason === 'unresolved') {
      return { ok: false, code: 'judge_model_unavailable', reason, message: `Scorer "${scorer.name}" asks for ${asked}, which ${noModelCause(resolved, tool)}. ${NO_MODEL_FIX.unresolved}` };
    }
    unmapped.push(tool);
    unmappedBy = resolved;
  }
  return {
    ok: false, code: 'judge_model_unavailable', reason: 'unmapped',
    message: `Scorer "${scorer.name}" asks for ${asked}, which ${noModelCause(unmappedBy, unmapped.join(', ') || 'any judge tool')}. ${NO_MODEL_FIX.unmapped}`,
  };
}
