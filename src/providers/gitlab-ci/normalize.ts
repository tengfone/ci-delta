import { asRecord, stringList, type JsonObject } from "../shared.js";
import type {
  IncludeRecord,
  ResolvedJob,
  ResolvedPipeline,
  ResolveProblem,
} from "./resolve.js";

export type { JsonObject };

/** GitLab's stage list when `stages:` is not set. */
export const defaultStages = [".pre", "build", "test", "deploy", ".post"];

export interface GitLabRule {
  ifClause?: string;
  /** `when:` exactly as written, if any. */
  when?: string;
  changes: string[];
  hasChanges: boolean;
  compareTo?: string;
  exists: string[];
  hasExists: boolean;
}

export interface GitLabOnlyExcept {
  refs: string[];
  variables: string[];
  changes: string[];
  kubernetes?: string;
}

export interface GitLabNeed {
  name: string;
  optional: boolean;
}

export interface GitLabTrigger {
  /** Downstream project for multi-project pipelines. */
  project?: string;
  branch?: string;
  /** Child pipeline configuration sources, rendered. */
  include: string[];
  strategy?: string;
}

export interface GitLabEnvironment {
  name: string;
  action?: string;
  deploymentTier?: string;
}

export interface GitLabSecret {
  name: string;
  source: string;
}

export interface GitLabVariable {
  name: string;
  valueText?: string;
}

export interface GitLabService {
  key: string;
  image?: string;
  label: string;
}

export interface GitLabScript {
  location: string;
  text: string;
  inherited: boolean;
}

export interface GitLabIdToken {
  name: string;
  aud?: string;
}

export type AllowFailure = "true" | "false" | "exit_codes";

export interface GitLabJob {
  id: string;
  file: string;
  extends: string[];
  stage: string;
  /** Job-level `when:`; undefined means GitLab's default (`on_success`). */
  when?: string;
  allowFailure: AllowFailure;
  /** undefined when the job has no `rules:` keyword. */
  rules?: GitLabRule[];
  only?: GitLabOnlyExcept;
  except?: GitLabOnlyExcept;
  /** undefined means stage ordering; [] means the job starts immediately. */
  needs?: GitLabNeed[];
  trigger?: GitLabTrigger;
  environment?: GitLabEnvironment;
  resourceGroup?: string;
  secrets: GitLabSecret[];
  image?: string;
  services: GitLabService[];
  tags?: string[];
  idTokens: GitLabIdToken[];
  variables: GitLabVariable[];
  scripts: GitLabScript[];
  /** Keywords that came from `default:` rather than the job itself. */
  inherited: Set<string>;
}

export interface GitLabDefaults {
  file: string;
  image?: string;
  services: GitLabService[];
  tags?: string[];
  idTokens: GitLabIdToken[];
  scripts: GitLabScript[];
}

export interface GitLabPipeline {
  rootPath: string;
  files: string[];
  workflowRules?: GitLabRule[];
  workflowFile: string;
  stages: string[];
  stagesFile: string;
  variables: GitLabVariable[];
  variablesFile: string;
  defaults: GitLabDefaults;
  jobs: Record<string, GitLabJob>;
  includes: IncludeRecord[];
  problems: ResolveProblem[];
}

export function normalizePipeline(resolved: ResolvedPipeline): GitLabPipeline {
  const { config } = resolved;
  const originOf = (key: string) =>
    resolved.origins.get(key) ?? resolved.rootPath;
  const workflow = asRecord(config.workflow) ?? {};
  const defaults = resolved.defaults;
  const stages = normalizeStages(config.stages ?? config.types);

  const jobs: Record<string, GitLabJob> = {};
  for (const job of resolved.jobs) {
    jobs[job.id] = normalizeJob(job);
  }

  return {
    rootPath: resolved.rootPath,
    files: resolved.files,
    workflowRules:
      workflow.rules === undefined ? undefined : normalizeRules(workflow.rules),
    workflowFile: originOf("workflow"),
    stages,
    stagesFile: originOf(config.stages !== undefined ? "stages" : "types"),
    variables: normalizeVariables(config.variables),
    variablesFile: originOf("variables"),
    defaults: {
      file: resolved.defaultsFile,
      image: imageRef(defaults.image),
      services: normalizeServices(defaults.services),
      tags: tagsRef(defaults.tags),
      idTokens: normalizeIdTokens(defaults.id_tokens),
      scripts: collectScripts(defaults, new Set()),
    },
    jobs,
    includes: resolved.includes,
    problems: resolved.problems,
  };
}

function normalizeStages(value: unknown): string[] {
  const declared = stringList(value);
  if (declared.length === 0) {
    return defaultStages;
  }

  return [
    ".pre",
    ...declared.filter((stage) => stage !== ".pre" && stage !== ".post"),
    ".post",
  ];
}

function normalizeJob(resolved: ResolvedJob): GitLabJob {
  const job = resolved.config;
  const when = typeof job.when === "string" ? job.when : undefined;
  const rules = job.rules === undefined ? undefined : normalizeRules(job.rules);

  return {
    id: resolved.id,
    file: resolved.file,
    extends: resolved.extends,
    stage: typeof job.stage === "string" ? job.stage : "test",
    when,
    allowFailure: normalizeAllowFailure(job.allow_failure, when, rules),
    rules: rules && rules.length > 0 ? rules : undefined,
    only: normalizeOnlyExcept(job.only),
    except: normalizeOnlyExcept(job.except),
    needs: job.needs === undefined ? undefined : normalizeNeeds(job.needs),
    trigger: normalizeTrigger(job.trigger),
    environment: normalizeEnvironment(job.environment),
    resourceGroup:
      typeof job.resource_group === "string" && job.resource_group.trim()
        ? job.resource_group.trim()
        : undefined,
    secrets: normalizeSecrets(job.secrets),
    image: imageRef(job.image),
    services: normalizeServices(job.services),
    tags: tagsRef(job.tags),
    idTokens: normalizeIdTokens(job.id_tokens),
    variables: normalizeVariables(job.variables),
    scripts: collectScripts(job, resolved.inherited),
    inherited: resolved.inherited,
  };
}

function normalizeAllowFailure(
  value: unknown,
  when: string | undefined,
  rules: GitLabRule[] | undefined,
): AllowFailure {
  if (value === true) {
    return "true";
  }

  if (value === false) {
    return "false";
  }

  if (asRecord(value)) {
    return "exit_codes";
  }

  // GitLab defaults manual jobs without rules to allow_failure: true.
  return when === "manual" && !rules ? "true" : "false";
}

export function normalizeRules(value: unknown): GitLabRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return [];
    }

    const changesRecord = asRecord(record.changes);
    const changes = changesRecord
      ? stringList(changesRecord.paths)
      : stringList(record.changes);
    const existsRecord = asRecord(record.exists);
    const exists = existsRecord
      ? stringList(existsRecord.paths)
      : stringList(record.exists);

    return [
      {
        ifClause:
          typeof record.if === "string" && record.if.trim()
            ? normalizeExpression(record.if)
            : undefined,
        when: typeof record.when === "string" ? record.when : undefined,
        changes: [...changes].sort(),
        hasChanges: changes.length > 0 || changesRecord !== null,
        compareTo:
          typeof changesRecord?.compare_to === "string"
            ? changesRecord.compare_to
            : undefined,
        exists: [...exists].sort(),
        hasExists: exists.length > 0 || existsRecord !== null,
      },
    ];
  });
}

export function normalizeExpression(expression: string): string {
  return expression.trim().replace(/\s+/g, " ");
}

function normalizeOnlyExcept(value: unknown): GitLabOnlyExcept | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" || Array.isArray(value)) {
    return { refs: stringList(value), variables: [], changes: [] };
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const changesRecord = asRecord(record.changes);
  return {
    refs: stringList(record.refs),
    variables: stringList(record.variables).map(normalizeExpression),
    changes: changesRecord
      ? stringList(changesRecord.paths)
      : stringList(record.changes),
    kubernetes:
      typeof record.kubernetes === "string" ? record.kubernetes : undefined,
  };
}

function normalizeNeeds(value: unknown): GitLabNeed[] {
  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) {
      return [{ name: entry.trim(), optional: false }];
    }

    const record = asRecord(entry);
    if (!record || typeof record.job !== "string") {
      return [];
    }

    const prefix =
      typeof record.project === "string"
        ? `${record.project}:`
        : typeof record.pipeline === "string"
          ? `pipeline ${record.pipeline}:`
          : "";
    return [
      { name: `${prefix}${record.job}`, optional: record.optional === true },
    ];
  });
}

function normalizeTrigger(value: unknown): GitLabTrigger | undefined {
  if (typeof value === "string" && value.trim()) {
    return { project: value.trim(), include: [] };
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const includes = record.include === undefined ? [] : record.include;
  return {
    project: typeof record.project === "string" ? record.project : undefined,
    branch: typeof record.branch === "string" ? record.branch : undefined,
    include: (Array.isArray(includes) ? includes : [includes]).flatMap(
      renderTriggerInclude,
    ),
    strategy: typeof record.strategy === "string" ? record.strategy : undefined,
  };
}

function renderTriggerInclude(entry: unknown): string[] {
  if (typeof entry === "string") {
    return [`local: ${entry}`];
  }

  const record = asRecord(entry);
  if (!record) {
    return [];
  }

  return [
    Object.entries(record)
      .filter(([key]) => key !== "inputs")
      .map(
        ([key, raw]) =>
          `${key}: ${typeof raw === "string" ? raw : JSON.stringify(raw)}`,
      )
      .join(" "),
  ];
}

function normalizeEnvironment(value: unknown): GitLabEnvironment | undefined {
  if (typeof value === "string" && value.trim()) {
    return { name: value.trim() };
  }

  const record = asRecord(value);
  if (!record || typeof record.name !== "string" || !record.name.trim()) {
    return undefined;
  }

  return {
    name: record.name.trim(),
    action: typeof record.action === "string" ? record.action : undefined,
    deploymentTier:
      typeof record.deployment_tier === "string"
        ? record.deployment_tier
        : undefined,
  };
}

const secretProviders = [
  "vault",
  "azure_key_vault",
  "gcp_secret_manager",
  "aws_secrets_manager",
  "akeyless",
  "gitlab_secrets_manager",
];

function normalizeSecrets(value: unknown): GitLabSecret[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  return Object.entries(record).map(([name, raw]) => ({
    name,
    source: describeSecretSource(raw),
  }));
}

function describeSecretSource(value: unknown): string {
  const record = asRecord(value);
  if (!record) {
    return "unknown source";
  }

  for (const provider of secretProviders) {
    const config = record[provider];
    if (config === undefined) {
      continue;
    }

    if (typeof config === "string") {
      return `${provider}: ${config}`;
    }

    const details = asRecord(config);
    if (!details) {
      return provider;
    }

    const engine = asRecord(details.engine);
    const parts = [
      engine && typeof engine.path === "string" ? `${engine.path}/` : "",
      typeof details.path === "string" ? details.path : "",
      typeof details.name === "string" ? details.name : "",
      typeof details.field === "string" ? `#${details.field}` : "",
      details.version !== undefined ? `@${String(details.version)}` : "",
    ].join("");
    return parts ? `${provider}: ${parts}` : provider;
  }

  return "unknown source";
}

export function normalizeVariables(value: unknown): GitLabVariable[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  return Object.entries(record).map(([name, raw]) => {
    if (
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean"
    ) {
      return { name, valueText: String(raw) };
    }

    const variableValue = asRecord(raw)?.value;
    return {
      name,
      valueText:
        typeof variableValue === "string" ||
        typeof variableValue === "number" ||
        typeof variableValue === "boolean"
          ? String(variableValue)
          : undefined,
    };
  });
}

export function normalizeServices(value: unknown): GitLabService[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    if (typeof item === "string" && item.trim()) {
      return [{ key: `image:${item}`, image: item.trim(), label: item.trim() }];
    }

    const record = asRecord(item);
    if (!record) {
      return [];
    }

    const name = typeof record.name === "string" ? record.name : undefined;
    const alias = typeof record.alias === "string" ? record.alias : undefined;
    const label = alias || name || `service ${index + 1}`;
    const key = alias
      ? `alias:${alias}`
      : name
        ? `image:${name}`
        : `index:${index}`;

    return [{ key, image: name, label }];
  });
}

export function normalizeIdTokens(value: unknown): GitLabIdToken[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  return Object.entries(record).map(([name, raw]) => ({
    name,
    aud: formatAud(asRecord(raw)?.aud),
  }));
}

function formatAud(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const audiences = stringList(value)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return audiences.length > 0 ? audiences.join(", ") : undefined;
}

const scriptKeys = ["before_script", "script", "after_script"] as const;

function collectScripts(
  source: JsonObject,
  inherited: Set<string>,
): GitLabScript[] {
  const scripts: GitLabScript[] = [];

  for (const key of scriptKeys) {
    for (const text of scriptLines(source[key])) {
      scripts.push({ location: key, text, inherited: inherited.has(key) });
    }
  }

  return scripts;
}

/**
 * GitLab flattens nested script arrays (common with `!reference`). A script
 * line such as `- curl -H "PRIVATE-TOKEN: $TOKEN"` is a YAML mapping, which
 * GitLab rejects; it is rendered back to text so its references are still
 * analyzed.
 */
function scriptLines(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  const record = asRecord(value);
  if (record) {
    return Object.entries(record).map(
      ([key, entry]) => `${key}: ${scriptLines(entry).join(" ")}`,
    );
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => scriptLines(entry));
}

export function imageRef(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const record = asRecord(value);
  if (typeof record?.name === "string" && record.name.trim()) {
    return record.name.trim();
  }

  return undefined;
}

export function tagsRef(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return stringList(value);
}

export function renderRule(rule: GitLabRule): string {
  const parts: string[] = [];
  if (rule.ifClause) {
    parts.push(`if: ${rule.ifClause}`);
  }
  if (rule.hasChanges) {
    parts.push(
      rule.changes.length > 0
        ? `changes: ${rule.changes.join(", ")}`
        : "changes",
    );
    if (rule.compareTo) {
      parts.push(`compare_to: ${rule.compareTo}`);
    }
  }
  if (rule.hasExists) {
    parts.push(
      rule.exists.length > 0 ? `exists: ${rule.exists.join(", ")}` : "exists",
    );
  }
  if (rule.when) {
    parts.push(`when: ${rule.when}`);
  }

  return parts.join("; ") || "unconditional";
}

export function renderOnlyExcept(value: GitLabOnlyExcept): string {
  const parts: string[] = [];
  if (value.refs.length > 0) {
    parts.push(`refs: ${value.refs.join(", ")}`);
  }
  if (value.variables.length > 0) {
    parts.push(`variables: ${value.variables.join(", ")}`);
  }
  if (value.changes.length > 0) {
    parts.push(`changes: ${value.changes.join(", ")}`);
  }
  if (value.kubernetes) {
    parts.push(`kubernetes: ${value.kubernetes}`);
  }
  return parts.join("; ") || "empty";
}
