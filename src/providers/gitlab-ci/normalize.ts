import path from "node:path";
import { parseDocument } from "yaml";

export type JsonObject = Record<string, unknown>;

const globalKeys = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "spec",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "types",
]);

const scriptKeys = ["before_script", "script", "after_script"] as const;

export type IncludeKind =
  | "local"
  | "remote"
  | "project"
  | "template"
  | "component"
  | "unknown";

export interface GitLabInclude {
  kind: IncludeKind;
  localPath?: string;
  expanded: boolean;
  locator: string;
}

export interface GitLabRule {
  ifClause?: string;
  when?: string;
  changes: string[];
  hasChanges: boolean;
  exists: string[];
  unconditionalPositive: boolean;
  restrictive: boolean;
}

export interface GitLabVariable {
  name: string;
  protected: boolean;
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
}

export interface GitLabIdToken {
  name: string;
  aud?: string;
}

export interface GitLabJob {
  id: string;
  image?: string;
  services: GitLabService[];
  tags?: string[];
  rules: GitLabRule[];
  variables: GitLabVariable[];
  idTokens: GitLabIdToken[];
  scripts: GitLabScript[];
}

export interface GitLabCiFile {
  path: string;
  raw: string;
  valid: boolean;
  jobs: Record<string, GitLabJob>;
  workflowRules: GitLabRule[];
  variables: GitLabVariable[];
  defaultImage?: string;
  defaultServices: GitLabService[];
  defaultTags?: string[];
  defaultScripts: GitLabScript[];
  defaultIdTokens: GitLabIdToken[];
  rootImage?: string;
  rootServices: GitLabService[];
  rootScripts: GitLabScript[];
  includes: GitLabInclude[];
}

export function parseYamlRoot(content: string): {
  root: JsonObject | null;
  errors: string[];
} {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    return {
      root: null,
      errors: doc.errors.map((error) => error.message),
    };
  }

  return { root: asRecord(doc.toJSON()) ?? {}, errors: [] };
}

export function localIncludePaths(content: string): string[] {
  const parsed = parseYamlRoot(content);
  if (!parsed.root) {
    return [];
  }

  return extractIncludes(parsed.root, new Set())
    .map((include) => include.localPath)
    .filter((includePath): includePath is string => Boolean(includePath));
}

export function normalizeCiFile(
  filePath: string,
  raw: string,
  root: JsonObject,
  available: Set<string>,
): GitLabCiFile {
  const defaults = asRecord(root.default) ?? {};
  const workflow = asRecord(root.workflow) ?? {};

  return {
    path: filePath,
    raw,
    valid: true,
    jobs: normalizeJobs(root),
    workflowRules: normalizeRules(workflow.rules),
    variables: normalizeVariables(root.variables),
    defaultImage: imageRef(defaults.image),
    defaultServices: normalizeServices(defaults.services),
    defaultTags: tagsRef(defaults.tags),
    defaultScripts: collectScripts(defaults, "default "),
    defaultIdTokens: normalizeIdTokens(defaults.id_tokens),
    rootImage: imageRef(root.image),
    rootServices: normalizeServices(root.services),
    rootScripts: collectScripts(root, ""),
    includes: extractIncludes(root, available),
  };
}

export function invalidCiFile(filePath: string, raw: string): GitLabCiFile {
  return {
    path: filePath,
    raw,
    valid: false,
    jobs: {},
    workflowRules: [],
    variables: [],
    defaultServices: [],
    defaultScripts: [],
    defaultIdTokens: [],
    rootServices: [],
    rootScripts: [],
    includes: [],
  };
}

export function normalizeRepoPath(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("\0")) {
    return null;
  }

  const normalized = path.posix.normalize(trimmed.replace(/^\/+/, ""));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    return null;
  }

  return normalized;
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
  }
  if (rule.exists.length > 0) {
    parts.push(`exists: ${rule.exists.join(", ")}`);
  }
  if (rule.when) {
    parts.push(`when: ${rule.when}`);
  }

  return parts.join("; ") || "unconditional";
}

function extractIncludes(
  root: JsonObject,
  available: Set<string>,
): GitLabInclude[] {
  if (
    !("include" in root) ||
    root.include === undefined ||
    root.include === null
  ) {
    return [];
  }

  const entries = Array.isArray(root.include) ? root.include : [root.include];
  return entries.flatMap((entry) => classifyInclude(entry, available));
}

function classifyInclude(
  entry: unknown,
  available: Set<string>,
): GitLabInclude[] {
  if (typeof entry === "string") {
    return [classifyIncludeString(entry, available)];
  }

  const record = asRecord(entry);
  if (!record) {
    return [unexpanded("unknown", "include: unsupported entry")];
  }

  if (typeof record.local === "string") {
    return [localInclude(record.local, available)];
  }

  if (typeof record.remote === "string") {
    return [unexpanded("remote", `remote: ${record.remote.trim()}`)];
  }

  if (typeof record.template === "string") {
    return [unexpanded("template", `template: ${record.template.trim()}`)];
  }

  if (typeof record.component === "string") {
    return [unexpanded("component", `component: ${record.component.trim()}`)];
  }

  if ("project" in record) {
    const project =
      typeof record.project === "string" ? record.project.trim() : "unknown";
    const file = formatProjectFile(record.file);
    return [
      unexpanded(
        "project",
        file ? `project: ${project} file: ${file}` : `project: ${project}`,
      ),
    ];
  }

  return [unexpanded("unknown", "include: unsupported entry")];
}

function classifyIncludeString(
  entry: string,
  available: Set<string>,
): GitLabInclude {
  const trimmed = entry.trim();
  if (isRemoteLocator(trimmed)) {
    return unexpanded("remote", `remote: ${trimmed}`);
  }

  return localInclude(trimmed, available);
}

function localInclude(value: string, available: Set<string>): GitLabInclude {
  const localPath = normalizeRepoPath(value);
  if (!localPath) {
    return {
      kind: "local",
      expanded: false,
      locator: `local: ${value.trim()}`,
    };
  }

  return {
    kind: "local",
    localPath,
    expanded: available.has(localPath),
    locator: `local: ${localPath}`,
  };
}

function unexpanded(kind: IncludeKind, locator: string): GitLabInclude {
  return { kind, expanded: false, locator };
}

function isRemoteLocator(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    value.startsWith("git@") ||
    value.startsWith("ssh://")
  );
}

function formatProjectFile(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(", ");
  }

  return "";
}

function normalizeJobs(root: JsonObject): Record<string, GitLabJob> {
  const jobs: Record<string, GitLabJob> = {};

  for (const [id, value] of Object.entries(root)) {
    if (globalKeys.has(id)) {
      continue;
    }

    const job = asRecord(value);
    if (!job) {
      continue;
    }

    jobs[id] = {
      id,
      image: imageRef(job.image),
      services: normalizeServices(job.services),
      tags: tagsRef(job.tags),
      rules: normalizeRules(job.rules),
      variables: normalizeVariables(job.variables),
      idTokens: normalizeIdTokens(job.id_tokens),
      scripts: collectScripts(job, ""),
    };
  }

  return jobs;
}

export function normalizeRules(value: unknown): GitLabRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const rule = normalizeRule(entry);
    return rule ? [rule] : [];
  });
}

function normalizeRule(value: unknown): GitLabRule | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const ifClause = typeof record.if === "string" ? record.if : undefined;
  const when = typeof record.when === "string" ? record.when : undefined;
  const hasChanges = hasChangeGuard(record.changes);
  const changes = changePaths(record.changes);
  const exists = stringList(record.exists);
  const guarded = Boolean(ifClause) || hasChanges || exists.length > 0;

  return {
    ifClause,
    when,
    changes,
    hasChanges,
    exists,
    unconditionalPositive: !guarded && when !== "never",
    restrictive: guarded || when === "never",
  };
}

function hasChangeGuard(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return Boolean(value) && typeof value === "object";
}

function changePaths(value: unknown): string[] {
  if (Array.isArray(value)) {
    return stringList(value);
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  return stringList(record.paths);
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
      return { name, protected: false, valueText: String(raw) };
    }

    const map = asRecord(raw);
    const variableValue = map?.value;
    const valueText =
      typeof variableValue === "string" ||
      typeof variableValue === "number" ||
      typeof variableValue === "boolean"
        ? String(variableValue)
        : undefined;

    return {
      name,
      protected: map?.protected === true,
      valueText,
    };
  });
}

export function normalizeServices(value: unknown): GitLabService[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item, index) => {
    if (typeof item === "string" && item.trim()) {
      return [{ key: `image:${item}`, image: item, label: item }];
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

  if (Array.isArray(value)) {
    const audiences = value.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim() !== "",
    );
    return audiences.length > 0 ? audiences.join(", ") : undefined;
  }

  return undefined;
}

function collectScripts(source: JsonObject, prefix: string): GitLabScript[] {
  const scripts: GitLabScript[] = [];

  for (const key of scriptKeys) {
    for (const text of scriptLines(source[key])) {
      scripts.push({ location: `${prefix}${key}`.trim(), text });
    }
  }

  return scripts;
}

function scriptLines(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
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

export function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

export function asRecord(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return null;
}
