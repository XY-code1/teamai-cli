/**
 * Whether a step's scorers share one judge call: the step's `scorers.batch`, else its workflow's
 * `defaults.scorers.batch`, else the team's `scoring.batch` in teamai.yaml, else they do not.
 */
export function batchesScorers(layers: { step?: boolean; workflow?: boolean; team?: boolean }): boolean {
  return layers.step ?? layers.workflow ?? layers.team ?? false;
}
