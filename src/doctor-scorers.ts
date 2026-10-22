import { formatScorerDiagnostic } from './scorers/definition.js';
import { scoringUnavailable } from './scorers/home.js';
import { requiredIsolation, scopeIsolation, unknownIsolationText } from './scorers/isolation.js';
import type { LocalConfig } from './types.js';
import { isSilent, setSilent } from './utils/logger.js';
import { formatUnknownScorer, syncWorkflowDefinitions } from './workflow/cache.js';

async function isolationNote(localConfig: LocalConfig, verified: readonly string[]): Promise<string> {
  const required = requiredIsolation(await scopeIsolation(localConfig));
  const setBy = required.setBy.length > 0 ? `set by ${required.setBy.join(' and ')}` : 'the default';
  const [only, ...more] = verified;
  const raising = required.level === 'best-effort' && only
    ? [more.length === 0 ? `${only} asks for verified for its own work.` : `${verified.slice(0, -1).join(', ')} and ${verified.at(-1)} ask for verified for their own work.`]
    : [];
  return [`Scoring isolation: ${required.level}, ${setBy}.`, ...required.unknown.map((unknown) => `${unknownIsolationText(unknown)}.`), ...raising].join(' ');
}

/**
 * What a pull says about scorers, for members whose pull ran silently from a hook: each invalid file in `scorers/`, and
 * each scorer a workflow step lists that has no valid file. Also, when the team has scorers, why this install cannot
 * score, or else the isolation every judge needs, what sets it, and the scorers that ask for more. Dry-run, so no
 * cache changes.
 */
export async function scorerNotes(localConfig: LocalConfig): Promise<string[]> {
  const wasSilent = isSilent();
  setSilent(true);
  try {
    const result = await syncWorkflowDefinitions(localConfig, { dryRun: true });
    const scored = result.scorers.cached.length > 0;
    const unavailable = scored ? scoringUnavailable(localConfig) : undefined;
    return [
      ...(unavailable ? [unavailable] : scored ? [await isolationNote(localConfig, result.scorers.verified)] : []),
      ...result.scorers.invalid.map((diagnostic) => `Invalid scorer: ${formatScorerDiagnostic(diagnostic)}`),
      ...result.unknownScorers.map((unknown) => `Unknown scorer: ${formatUnknownScorer(unknown)}`),
    ];
  } catch (error) {
    return [`Scorers could not be checked: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setSilent(wasSilent);
  }
}
