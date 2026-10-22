/**
 * How isolated a judge must be. The team (`teamai.yaml` `scoring.isolation`), a scorer (`isolation`) and this machine
 * (`config.yaml` `scoring.isolation`) may each ask; the strictest wins, and nobody asking means `best-effort`.
 */
import { loadTeamConfig } from '../config.js';
import type { LocalConfig } from '../types.js';
import { ISOLATIONS, type Isolation } from './label.js';

const TEAM_ISOLATION = 'teamai.yaml scoring.isolation';
const MACHINE_ISOLATION = 'config.yaml scoring.isolation';

export function scorerIsolationSource(scorer: string, relativePath = `scorers/${scorer}.md`): string {
  return `${relativePath} isolation`;
}

/** One place that may ask for an isolation, such as `teamai.yaml scoring.isolation`, and what it says there. */
export interface IsolationSetting {
  source: string;
  value: string | undefined;
}

export interface RequiredIsolation {
  level: Isolation;
  /** The sources that ask for `level`; none when it is the default. */
  setBy: string[];
  /** Settings whose value is not an isolation teamai knows. Each counts as `verified`. */
  unknown: Array<{ source: string; value: string }>;
}

/** What the team and this scope's machine config ask of every judge. */
export async function scopeIsolation(config: LocalConfig): Promise<IsolationSetting[]> {
  const team = await loadTeamConfig(config.repo.localPath);
  return [{ source: TEAM_ISOLATION, value: team?.scoring?.isolation }, { source: MACHINE_ISOLATION, value: config.scoring?.isolation }];
}

function levelOf(value: string): Isolation {
  return ISOLATIONS.find((isolation) => isolation === value) ?? 'verified';
}

export function requiredIsolation(settings: readonly IsolationSetting[]): RequiredIsolation {
  const given = settings.flatMap(({ source, value }) => (value === undefined ? [] : [{ source, value, level: levelOf(value) }]));
  const level: Isolation = given.some((setting) => setting.level === 'verified') ? 'verified' : 'best-effort';
  return {
    level,
    setBy: given.filter((setting) => setting.level === level).map((setting) => setting.source),
    unknown: given.filter((setting) => !ISOLATIONS.some((isolation) => isolation === setting.value)).map(({ source, value }) => ({ source, value })),
  };
}

/** Why an unknown setting raised the level, for a warning or a doctor note. */
export function unknownIsolationText({ source, value }: { source: string; value: string }): string {
  return `${source} is "${value}", which is not verified or best-effort, so it counts as verified`;
}
