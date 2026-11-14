import path from "node:path";
import { asRecord, stringList, type JsonObject } from "../shared.js";

export type IncludeKind =
  | "local"
  | "remote"
  | "project"
  | "template"
  | "component"
  | "unknown";

/** One entry of a file's `include:` keyword. */
export interface GitLabInclude {
  kind: IncludeKind;
  /** Human-readable identity used in evidence and to match base/head. */
  locator: string;
  /** Normalized repository path or wildcard pattern for local includes. */
  localPattern?: string;
  wildcard: boolean;
  /** Rendered `include:rules`, which ci-delta does not evaluate. */
  rules: string[];
  hasInputs: boolean;
}

export function extractIncludes(root: JsonObject): GitLabInclude[] {
  const raw = root.include;
  if (raw === undefined || raw === null) {
    return [];
  }

  const entries = Array.isArray(raw) ? raw : [raw];
  return entries.map((entry) => classifyInclude(entry));
}

function classifyInclude(entry: unknown): GitLabInclude {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return isRemoteLocator(trimmed)
      ? include("remote", `remote: ${trimmed}`)
      : localInclude(trimmed, {});
  }

  const record = asRecord(entry);
  if (!record) {
    return include("unknown", "include: unsupported entry");
  }

  if (typeof record.local === "string") {
    return localInclude(record.local, record);
  }

  if (typeof record.remote === "string") {
    return include("remote", `remote: ${record.remote.trim()}`, record);
  }

  if (typeof record.template === "string") {
    return include("template", `template: ${record.template.trim()}`, record);
  }

  if (typeof record.component === "string") {
    return include(
      "component",
      `component: ${record.component.trim()}`,
      record,
    );
  }

  if ("project" in record) {
    const project =
      typeof record.project === "string" ? record.project.trim() : "unknown";
    const files = stringList(record.file)
      .map((file) => file.trim())
      .filter(Boolean);
    const ref = typeof record.ref === "string" ? ` ref: ${record.ref}` : "";
    const locator =
      files.length > 0
        ? `project: ${project}${ref} file: ${files.join(", ")}`
        : `project: ${project}${ref}`;
    return include("project", locator, record);
  }

  return include("unknown", "include: unsupported entry", record);
}

function localInclude(value: string, record: JsonObject): GitLabInclude {
  const localPattern = normalizeRepoPath(value);
  const wildcard = localPattern ? hasWildcard(localPattern) : false;
  return {
    ...include("local", `local: ${localPattern ?? value.trim()}`, record),
    localPattern: localPattern ?? undefined,
    wildcard,
  };
}

function include(
  kind: IncludeKind,
  locator: string,
  record: JsonObject = {},
): GitLabInclude {
  return {
    kind,
    locator,
    wildcard: false,
    rules: renderIncludeRules(record.rules),
    hasInputs: asRecord(record.inputs) !== null,
  };
}

function renderIncludeRules(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return String(entry);
    }

    return Object.entries(record)
      .map(([key, raw]) => `${key}: ${formatRuleValue(raw)}`)
      .join("; ");
  });
}

function formatRuleValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function isRemoteLocator(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function hasWildcard(pattern: string): boolean {
  return /[*?{]/.test(pattern);
}

export function isYamlPath(filePath: string): boolean {
  return /\.ya?ml$/i.test(filePath);
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

  return normalized.replace(/\/+$/, "");
}

/**
 * Converts a GitLab `include:local` wildcard into a regular expression.
 * GitLab documents `*` as matching within one directory and `**` as matching
 * across directories (`configs/**.yml` matches files in subfolders too).
 */
export function wildcardToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end === -1) {
        source += "\\{";
      } else {
        const options = pattern
          .slice(index + 1, end)
          .split(",")
          .map((option) => option.replace(/[.+^$()|[\]\\]/g, "\\$&"));
        source += `(?:${options.join("|")})`;
        index = end;
      }
    } else {
      source += char.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`);
}

/** Returns the sorted repository paths a local include entry resolves to. */
export function matchLocalInclude(
  include: GitLabInclude,
  paths: Iterable<string>,
): string[] {
  if (!include.localPattern) {
    return [];
  }

  if (!include.wildcard) {
    for (const candidate of paths) {
      if (candidate === include.localPattern) {
        return [candidate];
      }
    }
    return [];
  }

  const matcher = wildcardToRegExp(include.localPattern);
  return [...paths]
    .filter((candidate) => matcher.test(candidate) && isYamlPath(candidate))
    .sort();
}
