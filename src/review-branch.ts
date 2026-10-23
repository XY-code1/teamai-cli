/**
 * Read-only health checks for a branch `teamai push` created
 * (`teamai/push/<user>/<timestamp>`), surfaced as `teamai review --branch <name>`.
 *
 * Why this exists (#776): when the Git host cannot open a PR/MR (a plain
 * `ssh://` remote, for instance), `teamai push` still lands new resources on a
 * push branch, but nothing tells the human who merges by hand whether those
 * resources are usable. This command answers that, per branch, with three
 * levels: `fail` (must fix), `warn` (needs a human decision), `info` (context).
 *
 * It is strictly read-only: the branch tree is read out of git's object store
 * (`git ls-tree` / `git show`) into a temporary directory and never checked out
 * into the team repo, and nothing is written back.
 *
 * The checks reuse the code paths pull already trusts — the same resource
 * scanners (`scanTeamForPull`), the same manifest loaders, the same
 * `NAMESPACE_AXIS` mapping, the same agent parser and the same secret
 * scrubber — so a branch this command calls clean is one pull reads the same
 * way. Workflow and scorer files reuse `syncWorkflowDefinitions` with dry-run
 * and an empty data home, and that check does not update this machine's
 * caches. It deliberately does not re-implement any of that.
 */
import os from 'node:os';
import path from 'node:path';

import chalk from 'chalk';
import fse from 'fs-extra';

import { resolveConfigForDir } from './config.js';
import { caseFoldKey, isSafeNamespaceSegment, NAMESPACE_RULE } from './manifest-schema.js';
import { loadProjectsManifest, type ProjectResourceType, type ProjectsManifest } from './projects.js';
import { NAMESPACE_AXIS, type PlaceableType } from './push-namespaces.js';
import { loadFailure } from './doctor-agent-models.js';
import { isModelAlias, loadTeamModelAliases, noModelCause, resolveAgentModel, resolveModelValue, TEAM_ALIASES_FILE, type ModelAliases } from './models/aliases.js';
import { ALL_SUPPORTED_TOOLS, parseAgentYaml, type AgentSpec, type ToolName } from './resources/agent-format.js';
import { AgentsHandler } from './resources/agents.js';
import { RulesHandler } from './resources/rules.js';
import { SkillsHandler } from './resources/skills.js';
import { resolveResourceNamespaces } from './resource-namespaces.js';
import { loadRolesManifestIfPresent, type RolesManifest } from './roles.js';
import { LocalConfigSchema, type GlobalOptions, type LocalConfig, type ResourceItem, type TeamaiConfig } from './types.js';
import { splitFrontmatter } from './utils/frontmatter.js';
import { listFilesRecursive, pathExists, readFileIfExists, writeFile, ensureDir } from './utils/fs.js';
import { getFileContentAtRev, getHeadCommit, listTreeAtRev } from './utils/git.js';
import { isSilent, log, setSilent } from './utils/logger.js';
import { redact } from './utils/redact.js';
import { formatUnknownScorer, syncWorkflowDefinitions } from './workflow/cache.js';
import { formatDiagnostic, parseWorkflow } from './workflow/parse.js';
import { stepModelUnavailableText } from './workflow/step-model.js';
import type { WorkflowStep } from './workflow/types.js';
import { formatScorerDiagnostic, parseScorer } from './scorers/definition.js';
import { scorerModelUnavailableText } from './scorers/judge-model.js';

// ─── Findings ────────────────────────────────────────────────────────────────

/** How bad a finding is: `fail` blocks a merge, `warn` needs a human, `info` is context. */
export type FindingLevel = 'fail' | 'warn' | 'info';

/** Which group of checks produced a finding. */
export type FindingCheck = 'structure' | 'naming' | 'duplicates' | 'format' | 'leaks' | 'workflows' | 'scorers' | 'models';

/** One thing worth reporting about the branch. */
export interface Finding {
  level: FindingLevel;
  check: FindingCheck;
  /** One English sentence naming what is wrong and, where useful, how to fix it. */
  message: string;
  /** Repo-relative path of the resource the finding is about. */
  path?: string;
}

/** The whole result for one branch, as `--json` prints it. */
export interface BranchReview {
  branch: string;
  /** False when any `fail` finding exists. */
  ok: boolean;
  counts: Record<FindingLevel, number>;
  findings: Finding[];
}

const AXES: readonly ProjectResourceType[] = ['knowledge', 'skills', 'learnings', 'agents'];

// ─── Resource model ──────────────────────────────────────────────────────────

/** A resource on the branch, with its name/namespace read from its repo path. */
interface ReviewResource {
  type: PlaceableType;
  name: string;
  namespace?: string;
  /** Repo-relative path of the resource (a directory for skills, a file otherwise). */
  relativePath: string;
  /** Absolute path in the materialized tree: the skill directory, or the file. */
  absolutePath: string;
}

/** Strip a resource file extension from the last path segment. */
function stripExtension(segment: string): string {
  return segment.replace(/\.(md|markdown|yaml|yml|toml|json)$/i, '');
}

/**
 * Name and namespace from a repo-relative resource path, the same way pull reads
 * them (`<root>/<ns>/<name>` is namespaced, `<root>/<name>` is shared). The
 * handlers' own `name` is not used: for rules it carries the namespace segment.
 */
function parseRelativePath(relativePath: string): { name: string; namespace?: string } {
  const rest = relativePath.split('/').slice(1);
  if (rest.length <= 1) {
    return { name: stripExtension(rest[0] ?? '') };
  }
  return {
    name: stripExtension(rest[rest.length - 1] ?? ''),
    namespace: rest[0],
  };
}

/** Enumerate the resources on the branch through the same scanners pull uses. */
async function scanResources(repoDir: string): Promise<ReviewResource[]> {
  // `scanTeamForPull` reads only `repo.localPath` for skills, rules and agents;
  // the rest of the configs are placeholders, as in the handlers' own tests.
  const localConfig = { repo: { localPath: repoDir } } as LocalConfig;
  const teamConfig = {} as TeamaiConfig;
  const items: Array<{ type: PlaceableType; item: ResourceItem }> = [
    ...(await new SkillsHandler().scanTeamForPull(teamConfig, localConfig)).map((item) => ({ type: 'skills' as const, item })),
    ...(await new RulesHandler().scanTeamForPull(teamConfig, localConfig)).map((item) => ({ type: 'rules' as const, item })),
    ...(await new AgentsHandler().scanTeamForPull(teamConfig, localConfig)).map((item) => ({ type: 'agents' as const, item })),
  ];
  return items.map(({ type, item }) => {
    const { name, namespace } = parseRelativePath(item.relativePath);
    return { type, name, namespace, relativePath: item.relativePath, absolutePath: item.sourcePath };
  });
}

// ─── Manifest index ──────────────────────────────────────────────────────────

/** The namespace lists a branch's roles and projects declare, per axis. */
interface ManifestIndex {
  /** True when any role or project declares `namespace` on `axis`. */
  declares(axis: ProjectResourceType, namespace: string): boolean;
  /** True when any single role or project declares both namespaces on `axis`. */
  coActive(axis: ProjectResourceType, a: string, b: string): boolean;
  /** True when any role or project declares any namespace on `axis`. */
  anyOn(axis: ProjectResourceType): boolean;
}

function buildManifestIndex(roles: RolesManifest | null, projects: ProjectsManifest | null): ManifestIndex {
  const listsByAxis = new Map<ProjectResourceType, string[][]>();
  for (const axis of AXES) listsByAxis.set(axis, []);

  const collect = (resources: Partial<Record<ProjectResourceType, string[]>>): void => {
    for (const axis of AXES) {
      const list = resources[axis];
      if (list && list.length > 0) listsByAxis.get(axis)!.push(list);
    }
  };
  for (const role of roles?.roles ?? []) collect(role.resources);
  for (const project of projects?.projects ?? []) collect(project.resources);

  const fold = (list: string[]): Set<string> => new Set(list.map(caseFoldKey));
  return {
    declares: (axis, namespace) => {
      const key = caseFoldKey(namespace);
      return listsByAxis.get(axis)!.some((list) => fold(list).has(key));
    },
    coActive: (axis, a, b) => {
      const ka = caseFoldKey(a);
      const kb = caseFoldKey(b);
      return listsByAxis.get(axis)!.some((list) => {
        const folded = fold(list);
        return folded.has(ka) && folded.has(kb);
      });
    },
    anyOn: (axis) => listsByAxis.get(axis)!.length > 0,
  };
}

// ─── Leak patterns ───────────────────────────────────────────────────────────

/**
 * Addresses that should not ride along in a shared resource: RFC 1918 ranges
 * and internal-only TLDs. `redact` covers credential *shapes*; this covers the
 * other half of the reporter's `leaks` check.
 */
const INTERNAL_ADDRESS =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:internal|corp|lan)\b/gi;

/** The labels `redact` writes for the secret shapes it found. */
function redactedLabels(redactedText: string): string[] {
  return [...new Set([...redactedText.matchAll(/<REDACTED:([a-z_]+)>/g)].map((match) => match[1]!))];
}

// ─── The checks ──────────────────────────────────────────────────────────────

/** Read a text file once, memoized; null when absent or unreadable. */
function makeTextReader(): (absolutePath: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (absolutePath) => {
    let hit = cache.get(absolutePath);
    if (!hit) {
      hit = readFileIfExists(absolutePath).catch(() => null);
      cache.set(absolutePath, hit);
    }
    return hit;
  };
}

async function structureFindings(resources: ReviewResource[], index: ManifestIndex): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const resource of resources) {
    if (resource.type === 'skills' && !await pathExists(path.join(resource.absolutePath, 'SKILL.md'))) {
      findings.push({
        level: 'fail',
        check: 'structure',
        path: resource.relativePath,
        message: `${resource.relativePath}/ has no SKILL.md directly inside it; a skill must be skills/<namespace>/<name>/SKILL.md.`,
      });
    }
    if (resource.namespace) {
      const axis = NAMESPACE_AXIS[resource.type];
      if (!index.declares(axis, resource.namespace)) {
        findings.push({
          level: 'fail',
          check: 'structure',
          path: resource.relativePath,
          message: `${resource.relativePath} sits in namespace "${resource.namespace}", which no role or project declares `
            + `under resources.${axis}, so it reaches nobody. Add the namespace to manifest/roles.yaml or manifest/projects.yaml, `
            + 'or move the resource.',
        });
      }
    } else if (index.anyOn(NAMESPACE_AXIS[resource.type])) {
      findings.push({
        level: 'info',
        check: 'structure',
        path: resource.relativePath,
        message: `${resource.relativePath} sits at the shared root, so it is delivered to every member.`,
      });
    }
  }
  return findings;
}

async function namingFindings(resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const resource of resources) {
    if (resource.namespace && !isSafeNamespaceSegment(resource.namespace)) {
      findings.push({
        level: 'fail',
        check: 'naming',
        path: resource.relativePath,
        message: `Namespace "${resource.namespace}" in ${resource.relativePath} is not a usable path segment: ${NAMESPACE_RULE}.`,
      });
    }
    if (!isSafeNamespaceSegment(resource.name)) {
      findings.push({
        level: 'fail',
        check: 'naming',
        path: resource.relativePath,
        message: `Resource name "${resource.name}" in ${resource.relativePath} is not a usable path segment: ${NAMESPACE_RULE}.`,
      });
    }
    const declaredName = await frontmatterName(resource, readText);
    if (declaredName !== null && declaredName !== resource.name) {
      findings.push({
        level: 'fail',
        check: 'naming',
        path: resource.relativePath,
        message: `${resource.relativePath} declares the name "${declaredName}" but its directory/file is "${resource.name}"; make them match.`,
      });
    }
  }
  return findings;
}

/** The `name` a resource declares in its frontmatter/YAML, or null when it declares none. */
async function frontmatterName(resource: ReviewResource, readText: (p: string) => Promise<string | null>): Promise<string | null> {
  if (resource.type === 'skills') {
    const content = await readText(path.join(resource.absolutePath, 'SKILL.md'));
    if (content === null) return null;
    const name = splitFrontmatter(content).data['name'];
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  }
  if (resource.type === 'agents') {
    const content = await readText(resource.absolutePath);
    if (content === null) return null;
    if (/\.(yaml|yml)$/i.test(resource.absolutePath)) {
      const parsed = parseAgentYaml(content, path.basename(resource.relativePath));
      return parsed.ok ? parsed.spec.name : null;
    }
    const name = splitFrontmatter(content).data['name'];
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  }
  return null;
}

async function formatFindings(resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const resource of resources) {
    if (resource.type === 'skills') {
      const content = await readText(path.join(resource.absolutePath, 'SKILL.md'));
      if (content === null) continue;
      const { data, valid, raw } = splitFrontmatter(content);
      if (raw === '') {
        findings.push({
          level: 'fail',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has no YAML frontmatter; pull relies on it for the skill's name and description.`,
        });
        continue;
      }
      if (!valid) {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has a frontmatter block that does not parse as a YAML mapping.`,
        });
      }
      const description = data['description'];
      if (typeof description !== 'string' || description.trim() === '') {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has no frontmatter "description"; say when the skill should be used.`,
        });
      } else if (description.trim().length < 15) {
        findings.push({
          level: 'warn',
          check: 'format',
          path: resource.relativePath,
          message: `${resource.relativePath}/SKILL.md has a "description" too short to explain when to use the skill.`,
        });
      }
    }
    if (resource.type === 'agents' && /\.(yaml|yml)$/i.test(resource.absolutePath)) {
      const content = await readText(resource.absolutePath);
      if (content === null) continue;
      const parsed = parseAgentYaml(content, path.basename(resource.relativePath));
      if (!parsed.ok) {
        findings.push({ level: 'fail', check: 'format', path: resource.relativePath, message: parsed.reason });
      }
    }
  }
  return findings;
}

function duplicateFindings(resources: ReviewResource[], index: ManifestIndex): Finding[] {
  const byTypeAndName = new Map<string, ReviewResource[]>();
  for (const resource of resources) {
    if (!resource.namespace) continue;
    const key = `${resource.type}\0${caseFoldKey(resource.name)}`;
    byKey(byTypeAndName, key).push(resource);
  }

  const findings: Finding[] = [];
  for (const group of byTypeAndName.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (a.namespace === b.namespace) continue;
        const axis = NAMESPACE_AXIS[a.type];
        if (!index.coActive(axis, a.namespace!, b.namespace!)) continue;
        findings.push({
          level: 'fail',
          check: 'duplicates',
          path: b.relativePath,
          message: `"${a.name}" is defined in both ${a.relativePath} and ${b.relativePath}, and their namespaces can be active `
            + 'together, so pull cannot decide which one a member receives. Rename or remove one of them.',
        });
      }
    }
  }
  return findings;
}

function byKey<K, V>(map: Map<K, V[]>, key: K): V[] {
  const existing = map.get(key);
  if (existing) return existing;
  const created: V[] = [];
  map.set(key, created);
  return created;
}

const MAX_SCANNED_FILE_BYTES = 512 * 1024;

async function filesUnder(relativeDir: string, absoluteDir: string): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  return (await listFilesRecursive(absoluteDir)).map((rel) => ({
    relativePath: `${relativeDir}/${rel}`,
    absolutePath: path.join(absoluteDir, ...rel.split('/')),
  }));
}

async function leakFindings(repoDir: string, resources: ReviewResource[], readText: (p: string) => Promise<string | null>): Promise<Finding[]> {
  const files = [
    ...(await Promise.all(resources.map((resource) => resource.type === 'skills'
      ? filesUnder(resource.relativePath, resource.absolutePath)
      : [{ relativePath: resource.relativePath, absolutePath: resource.absolutePath }]))).flat(),
    ...await filesUnder('scorers', path.join(repoDir, 'scorers')),
  ];
  const findings: Finding[] = [];
  for (const file of files) {
    const content = await readText(file.absolutePath);
    if (content === null || content.length > MAX_SCANNED_FILE_BYTES || content.includes('\0')) continue;

    const redacted = redact(content);
    if (redacted !== content) {
      const labels = redactedLabels(redacted);
      findings.push({
        level: 'fail',
        check: 'leaks',
        path: file.relativePath,
        message: `${file.relativePath} looks like it carries a credential (${labels.join(', ') || 'redacted'}); `
          + 'remove it before this branch is merged.',
      });
    }

    const addresses = [...new Set([...content.matchAll(INTERNAL_ADDRESS)].map((match) => match[0]))];
    if (addresses.length > 0) {
      findings.push({
        level: 'fail',
        check: 'leaks',
        path: file.relativePath,
        message: `${file.relativePath} contains an internal address (${addresses.join(', ')}); confirm it is safe to share before merging.`,
      });
    }
  }
  return findings;
}

/**
 * Config for checking the materialized branch. `kind` stays omitted, so this
 * is not self mode, and `dataHome` is an empty directory rather than this
 * machine's workflow cache.
 */
function reviewTreeConfig(repoDir: string, dataHome: string): LocalConfig {
  const parsed = LocalConfigSchema.parse({
    repo: { localPath: repoDir, remote: 'local' },
    username: 'review',
  });
  return { ...parsed, dataHome };
}

/** Invalid workflow and scorer files, and scorers a step lists that do not exist. Dry-run, so the call does not write a cache. */
async function workflowFindings(repoDir: string): Promise<Finding[]> {
  const dataHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-workflows-'));
  const wasSilent = isSilent();
  setSilent(true);
  try {
    const result = await syncWorkflowDefinitions(reviewTreeConfig(repoDir, dataHome), {
      dryRun: true,
      everyNamespace: true,
      scopeLabel: 'review',
    });
    return [
      ...result.scorers.invalid.map((diagnostic): Finding => ({
        level: 'fail',
        check: 'scorers',
        path: diagnostic.file,
        message: formatScorerDiagnostic(diagnostic),
      })),
      ...result.invalid.map((diagnostic): Finding => ({
        level: 'fail',
        check: 'workflows',
        path: diagnostic.file,
        message: formatDiagnostic(diagnostic),
      })),
      // Pull runs such a step without the scorer; a branch under review should not ship the gap.
      ...result.unknownScorers.map((unknown): Finding => ({
        level: 'fail',
        check: 'workflows',
        path: unknown.file,
        message: formatUnknownScorer(unknown),
      })),
    ];
  } finally {
    setSilent(wasSilent);
    await fse.remove(dataHome);
  }
}

/** The steps of `definition`, inside its inline workflows too, with each step's path, such as `check.classify`. */
function stepsOf(definition: { steps: WorkflowStep[] }, prefix = ''): Array<{ path: string; step: WorkflowStep }> {
  return definition.steps.flatMap((step) => [
    { path: `${prefix}${step.id}`, step },
    ...(typeof step.workflow === 'object' ? stepsOf(step.workflow, `${prefix}${step.id}.`) : []),
  ]);
}

/** The members of one selection of the branch: no role or project, one role, or one project. */
interface ModelContext {
  /** How a finding names these members: `role dev`. */
  label: string;
  aliases: ModelAliases;
  /** The agent namespaces these members receive; null when they receive every one. */
  agentNamespaces: readonly string[] | null;
}

async function modelContexts(repoDir: string, roles: RolesManifest | null, projects: ProjectsManifest | null): Promise<ModelContext[]> {
  const base = reviewTreeConfig(repoDir, os.tmpdir());
  const selections: Array<{ label: string; config: LocalConfig }> = [
    { label: 'no role or project', config: base },
    ...(roles?.roles ?? []).map((role) => ({ label: `role ${role.id}`, config: { ...base, primaryRole: role.id } })),
    ...(projects?.projects ?? []).map((project) => ({ label: `project ${project.id}`, config: { ...base, projects: [project.id] } })),
  ];
  return Promise.all(selections.map(async ({ label, config }) => ({
    label,
    aliases: await loadTeamModelAliases(config),
    agentNamespaces: await resolveResourceNamespaces(config).then((resolved) => resolved?.activeNamespaces.agents ?? null, () => null),
  })));
}

function receives(context: ModelContext, namespace: string | undefined): boolean {
  return namespace === undefined || context.agentNamespaces === null || context.agentNamespaces.some((active) => caseFoldKey(active) === caseFoldKey(namespace));
}

/** Why `model` gives none of `tools` a model, worded to follow "which", or undefined when it gives one, or is a model name. */
function valueCause(aliases: ModelAliases, model: string, tools?: readonly ToolName[]): string | undefined {
  if (!isModelAlias(aliases, model)) return undefined;
  const resolutions = (tools ?? ALL_SUPPORTED_TOOLS).map((tool) => resolveModelValue(aliases, model, tool));
  if (resolutions.some((resolution) => resolution.ok && resolution.model !== undefined)) return undefined;
  return noModelCause(resolutions[0] ?? { ok: true, step: 'default' }, tools?.join(', ') ?? 'any tool');
}

/** Why `spec` gives none of its target tools a model, as pull resolves it: a tool's extras model first. */
function agentCause(aliases: ModelAliases, spec: AgentSpec): string | undefined {
  const tools = spec.targets ?? ALL_SUPPORTED_TOOLS;
  const resolutions = tools.map((tool) => resolveAgentModel(aliases, spec, tool));
  if (resolutions.some((resolution) => resolution.ok && resolution.model !== undefined)) return undefined;
  return noModelCause(resolutions[0] ?? { ok: true, step: 'default' }, spec.targets?.join(', ') ?? 'any tool');
}

/**
 * The model aliases the branch's agents, workflow steps, `defaults.model` and scorers ask for that the branch's own
 * team aliases files map for none of the tools that would use them, or the reason those files cannot be read. Each
 * role and project the branch declares, and members with neither, receive their own agents and aliases files, so each
 * is checked on its own and a finding names the ones it is about. Member overrides, model switches and installed
 * tools are this machine's, so they play no part. A model name is never one.
 */
async function modelFindings(repoDir: string, resources: ReviewResource[], readText: (p: string) => Promise<string | null>, roles: RolesManifest | null, projects: ProjectsManifest | null): Promise<Finding[]> {
  const contexts = await modelContexts(repoDir, roles, projects);
  const [unselected] = contexts;
  const failure = unselected && loadFailure(unselected.aliases);
  if (failure) return [{ level: 'fail', check: 'models', path: TEAM_ALIASES_FILE, message: failure }];
  const findings: Finding[] = [];
  const fail = (relativePath: string, message: string) => findings.push({ level: 'fail', check: 'models', path: relativePath, message });
  const failures = new Map<string, string[]>();
  for (const context of contexts) {
    const reason = loadFailure(context.aliases);
    if (reason) failures.set(reason, [...failures.get(reason) ?? [], context.label]);
  }
  for (const [reason, labels] of failures) fail(TEAM_ALIASES_FILE, `${reason} (${labels.join(', ')})`);
  const readable = contexts.filter((context) => loadFailure(context.aliases) === undefined);
  /** The cause in the first context `causeIn` finds one, naming the contexts it holds for when the branch has roles or projects. */
  const unmapped = (among: readonly ModelContext[], causeIn: (context: ModelContext) => string | undefined): string | undefined => {
    const found = among.flatMap((context) => {
      const cause = causeIn(context);
      return cause === undefined ? [] : [{ cause, label: context.label }];
    });
    const [first] = found;
    if (!first) return undefined;
    return contexts.length === 1 ? first.cause : `${first.cause} (${found.map(({ label }) => label).join(', ')})`;
  };

  const agents: Array<{ resource: ReviewResource; spec: AgentSpec }> = [];
  for (const resource of resources) {
    if (resource.type !== 'agents' || !/\.(yaml|yml)$/i.test(resource.absolutePath)) continue;
    const content = await readText(resource.absolutePath);
    const parsed = content === null ? null : parseAgentYaml(content, path.basename(resource.relativePath));
    if (parsed?.ok) agents.push({ resource, spec: parsed.spec });
  }
  for (const { resource, spec } of agents) {
    if (spec.model === undefined) continue;
    const cause = unmapped(readable.filter((context) => receives(context, resource.namespace)), (context) => agentCause(context.aliases, spec));
    if (cause) fail(resource.relativePath, `Agent "${spec.name}" asks for model alias "${spec.model}", which ${cause}. Add one, or remove model from the agent.`);
  }

  for (const name of (await fse.readdir(path.join(repoDir, 'workflows')).catch(() => [])).filter((file) => file.endsWith('.yaml')).sort()) {
    const relativePath = `workflows/${name}`;
    const content = await readText(path.join(repoDir, 'workflows', name));
    const parsed = content === null ? undefined : parseWorkflow(relativePath, content);
    if (!parsed?.ok) continue;
    const defaults = parsed.definition.defaults?.model;
    for (const { path: stepPath, step } of stepsOf(parsed.definition)) {
      if (step.prompt === undefined && step.promptFile === undefined) continue;
      const own = step.model !== undefined;
      // A run takes `defaults.model` unless the step's agent sets its own; an agent the branch does not have may set one.
      const model = own ? step.model : defaults;
      if (model === undefined) continue;
      const takesModel = (context: ModelContext): boolean => {
        if (own || step.agent === undefined) return true;
        const agent = agents.find(({ resource, spec }) => spec.name === step.agent && receives(context, resource.namespace));
        return agent !== undefined && agent.spec.model === undefined;
      };
      const cause = unmapped(readable.filter(takesModel), (context) => valueCause(context.aliases, model));
      if (cause) fail(relativePath, stepModelUnavailableText(stepPath, own ? 'step' : 'defaults', `model alias "${model}"`, cause, 'unmapped'));
    }
  }

  for (const relative of (await listFilesRecursive(path.join(repoDir, 'scorers'))).filter((file) => file.endsWith('.md') && file !== 'README.md').sort()) {
    const relativePath = `scorers/${relative}`;
    const content = await readText(path.join(repoDir, 'scorers', ...relative.split('/')));
    const parsed = content === null ? undefined : parseScorer(relativePath, content);
    const model = parsed?.ok ? parsed.definition.model : undefined;
    if (!parsed?.ok || model === undefined) continue;
    const cause = unmapped(readable, (context) => valueCause(context.aliases, model));
    if (cause) fail(relativePath, scorerModelUnavailableText(parsed.definition.name, `model alias "${model}"`, cause, 'unmapped'));
  }
  return findings;
}

// ─── Engine ──────────────────────────────────────────────────────────────────

/** Every check, in the order the reporter listed them. */
export async function reviewBranchDir(branch: string, repoDir: string): Promise<BranchReview> {
  const [roles, projects] = await Promise.all([
    loadRolesManifestIfPresent(repoDir),
    loadProjectsManifest(repoDir),
  ]);
  const index = buildManifestIndex(roles, projects);
  const resources = await scanResources(repoDir);
  const readText = makeTextReader();

  const findings: Finding[] = [
    ...await structureFindings(resources, index),
    ...await namingFindings(resources, readText),
    ...await duplicateFindings(resources, index),
    ...await formatFindings(resources, readText),
    ...await leakFindings(repoDir, resources, readText),
    ...await workflowFindings(repoDir),
    ...await modelFindings(repoDir, resources, readText, roles, projects),
  ];

  const counts: Record<FindingLevel, number> = { fail: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.level]++;

  return { branch, ok: counts.fail === 0, counts, findings };
}

// ─── Read-only branch reader ─────────────────────────────────────────────────

/** The repo roots read out of the branch; everything else is irrelevant here. */
const READ_ROOTS = ['skills', 'rules', 'agents', 'manifest', 'workflows', 'prompts', 'scorers', 'models'];

/**
 * The ref to read `branch` from: the name itself when it resolves locally, else
 * its remote-tracking form. Null when neither exists. Read-only — this never
 * fetches.
 */
export async function resolveBranchRef(repoPath: string, branch: string): Promise<string | null> {
  if (await getHeadCommit(repoPath, branch)) return branch;
  if (await getHeadCommit(repoPath, `origin/${branch}`)) return `origin/${branch}`;
  return null;
}

/**
 * Copy the branch's resource roots out of git's object store into `destDir`.
 * Nothing is checked out into the team repo, so this leaves it untouched.
 */
export async function materializeRef(repoPath: string, ref: string, destDir: string): Promise<number> {
  let written = 0;
  for (const root of READ_ROOTS) {
    for (const entry of await listTreeAtRev(repoPath, ref, root)) {
      const content = await getFileContentAtRev(repoPath, ref, entry.path);
      if (content === null) continue;
      const dest = path.join(destDir, ...entry.path.split('/'));
      await ensureDir(path.dirname(dest));
      if (entry.mode === '120000') {
        const target = content.toString('utf8');
        await fse.symlink(target, dest);
      } else {
        await writeFile(dest, content);
      }
      written++;
    }
  }
  return written;
}

// ─── Command ─────────────────────────────────────────────────────────────────

export interface ReviewBranchOptions extends GlobalOptions {
  branch: string;
  json?: boolean;
}

const LEVEL_COLOR: Record<FindingLevel, (text: string) => string> = {
  fail: chalk.red,
  warn: chalk.yellow,
  info: chalk.dim,
};

const LEVEL_GLYPH: Record<FindingLevel, string> = { fail: '✖', warn: '!', info: 'i' };

function renderReview(review: BranchReview): void {
  const { counts } = review;
  console.log(chalk.bold(`[review] branch ${review.branch}: ${counts.fail} fail, ${counts.warn} warn, ${counts.info} info`));
  if (review.findings.length === 0) {
    console.log(chalk.green('  No findings.'));
    return;
  }
  for (const finding of review.findings) {
    const head = `${LEVEL_GLYPH[finding.level]} [${finding.check}] ${finding.message}`;
    console.log(`  ${LEVEL_COLOR[finding.level](head)}`);
  }
}

/**
 * `teamai review --branch <name>`: check a pushed branch read-only and report
 * findings. Exits non-zero when a `fail` finding exists, so CI can gate on it.
 */
export async function reviewBranchCmd(options: ReviewBranchOptions): Promise<void> {
  const jsonMode = options.json === true;
  const localConfig = await resolveConfigForDir(undefined, undefined, { dryRun: true });
  if (!localConfig) {
    log.error('TeamAI is not initialized here. Run `teamai init` first.');
    process.exitCode = 1;
    return;
  }

  const repoPath = localConfig.repo.localPath;
  const ref = await resolveBranchRef(repoPath, options.branch);
  if (ref === null) {
    log.error(`Branch "${options.branch}" was not found in ${repoPath} (tried "${options.branch}" and "origin/${options.branch}").`);
    process.exitCode = 1;
    return;
  }

  const destDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-review-'));
  let review: BranchReview;
  try {
    await materializeRef(repoPath, ref, destDir);
    review = await reviewBranchDir(options.branch, destDir);
  } finally {
    await fse.remove(destDir).catch(() => undefined);
  }

  if (jsonMode) {
    console.log(JSON.stringify(review, null, 2));
  } else {
    renderReview(review);
  }
  if (!review.ok) process.exitCode = 1;
}
