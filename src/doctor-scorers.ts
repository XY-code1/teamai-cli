import { formatScorerDiagnostic } from './scorers/definition.js';
import { scoringUnavailable } from './scorers/home.js';
import type { LocalConfig } from './types.js';
import { isSilent, setSilent } from './utils/logger.js';
import { formatUnknownScorer, syncWorkflowDefinitions } from './workflow/cache.js';

/**
 * What a pull says about scorers, for members whose pull ran silently from a hook: each invalid file in `scorers/`, and
 * each scorer a workflow step lists that has no valid file. Also why this install cannot score, when the team has
 * scorers. Dry-run, so no cache changes.
 */
export async function scorerNotes(localConfig: LocalConfig): Promise<string[]> {
  const wasSilent = isSilent();
  setSilent(true);
  try {
    const result = await syncWorkflowDefinitions(localConfig, { dryRun: true });
    const unavailable = result.scorers.cached.length > 0 ? scoringUnavailable(localConfig) : undefined;
    return [
      ...(unavailable ? [unavailable] : []),
      ...result.scorers.invalid.map((diagnostic) => `Invalid scorer: ${formatScorerDiagnostic(diagnostic)}`),
      ...result.unknownScorers.map((unknown) => `Unknown scorer: ${formatUnknownScorer(unknown)}`),
    ];
  } catch (error) {
    return [`Scorers could not be checked: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setSilent(wasSilent);
  }
}
