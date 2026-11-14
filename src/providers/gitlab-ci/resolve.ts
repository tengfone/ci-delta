import { asRecord, stringList, type JsonObject } from "../shared.js";
import {
  extractIncludes,
  isYamlPath,
  matchLocalInclude,
  type GitLabInclude,
} from "./includes.js";
import { GitLabReference } from "./yaml.js";

/**
 * Builds the effective GitLab CI configuration for one pipeline root, following
 * the order GitLab itself uses:
 *
 * 1. `include:` files are merged in order (later files win), then the including
 *    file's own content is merged on top. Hashes deep-merge; arrays and scalars
 *    are replaced.
 * 2. `extends:` is resolved (multi-level, list form, same merge rules).
 * 3. `!reference` tags are resolved against the merged configuration.
 * 4. Jobs inherit `default:` (and legacy top-level) keywords unless `inherit:`
 *    says otherwise.
 */

export interface ParsedCiFile {
  path: string;
  raw: string;
  root: JsonObject | null;
  errors: string[];
}

export interface IncludeRecord {
  /** File that declares the include. */
  file: string;
  include: GitLabInclude;
  /** Repository paths the include resolved to. */
  matched: string[];
  /** Why the include was not expanded, when it was not. */
  notExpandedReason?: string;
}

export interface ResolveProblem {
  kind: "extends" | "reference" | "include-cycle";
  file: string;
  job?: string;
  detail: string;
}

export interface ResolvedJob {
  id: string;
  file: string;
  config: JsonObject;
  /** Keywords that came from `default:` or legacy top-level keywords. */
  inherited: Set<string>;
  extends: string[];
}

export interface ResolvedPipeline {
  rootPath: string;
  files: string[];
  config: JsonObject;
  origins: Map<string, string>;
  jobs: ResolvedJob[];
  defaults: JsonObject;
  defaultsFile: string;
  includes: IncludeRecord[];
  problems: ResolveProblem[];
}

export const globalKeywords = new Set([
  "default",
  "include",
  "stages",
  "variables",
  "workflow",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "types",
  "spec",
]);

const legacyDefaultKeywords = [
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
] as const;

export const inheritableDefaultKeywords = new Set([
  "after_script",
  "artifacts",
  "before_script",
  "cache",
  "hooks",
  "id_tokens",
  "identity",
  "image",
  "interruptible",
  "retry",
  "services",
  "tags",
  "timeout",
]);

const maxExtendsDepth = 11;
const maxReferenceDepth = 10;

interface Layer {
  config: JsonObject;
  origins: Map<string, string>;
}

export function resolvePipeline(
  rootPath: string,
  files: Map<string, ParsedCiFile>,
): ResolvedPipeline {
  const includes: IncludeRecord[] = [];
  const problems: ResolveProblem[] = [];
  const visited = new Set<string>();
  const available = [...files.keys()];

  const expand = (filePath: string, stack: string[]): Layer => {
    visited.add(filePath);
    const root = files.get(filePath)?.root ?? {};
    const layer: Layer = { config: {}, origins: new Map() };

    for (const include of extractIncludes(root)) {
      const record: IncludeRecord = { file: filePath, include, matched: [] };
      includes.push(record);

      if (include.kind !== "local") {
        record.notExpandedReason = notExpandedReason(include);
        continue;
      }

      if (!include.localPattern) {
        record.notExpandedReason = "the local path is not a repository path";
        continue;
      }

      if (!include.wildcard && !isYamlPath(include.localPattern)) {
        record.notExpandedReason =
          "local includes must be `.yml` or `.yaml` files";
        continue;
      }

      const matched = matchLocalInclude(
        include,
        available.filter((candidate) => candidate !== filePath),
      );
      record.matched = matched;
      if (matched.length === 0) {
        record.notExpandedReason = include.wildcard
          ? "the wildcard did not match any `.yml` or `.yaml` file at this ref"
          : "the file does not exist at this ref";
        continue;
      }

      for (const includedPath of matched) {
        if (stack.includes(includedPath)) {
          problems.push({
            kind: "include-cycle",
            file: filePath,
            detail: `\`${includedPath}\` includes itself through \`${[...stack, includedPath].join("` -> `")}\`.`,
          });
          continue;
        }

        if (visited.has(includedPath)) {
          continue;
        }

        mergeLayer(layer, expand(includedPath, [...stack, includedPath]));
      }
    }

    const own: Layer = { config: {}, origins: new Map() };
    for (const [key, value] of Object.entries(root)) {
      if (key === "include") {
        continue;
      }
      own.config[key] = value;
      own.origins.set(key, filePath);
    }
    mergeLayer(layer, own);
    return layer;
  };

  const merged = expand(rootPath, [rootPath]);
  const config = merged.config;
  const origins = merged.origins;
  const originOf = (key: string) => origins.get(key) ?? rootPath;

  const extendsByKey = resolveExtends(config, originOf, problems);
  resolveAllReferences(config, originOf, problems);

  const { defaults, defaultsFile } = collectDefaults(config, originOf);
  const jobs: ResolvedJob[] = [];

  for (const [id, value] of Object.entries(config)) {
    if (globalKeywords.has(id) || id.startsWith(".")) {
      continue;
    }

    const job = asRecord(value);
    if (!job) {
      continue;
    }

    const allowed = allowedDefaultKeys(job);
    const effective: JsonObject = { ...job };
    const inherited = new Set<string>();
    for (const [key, defaultValue] of Object.entries(defaults)) {
      if (!allowed(key) || key in job || defaultValue === undefined) {
        continue;
      }
      effective[key] = defaultValue;
      inherited.add(key);
    }

    jobs.push({
      id,
      file: originOf(id),
      config: effective,
      inherited,
      extends: extendsByKey.get(id) ?? [],
    });
  }

  return {
    rootPath,
    files: [...visited].sort(),
    config,
    origins,
    jobs,
    defaults,
    defaultsFile,
    includes,
    problems,
  };
}

function notExpandedReason(include: GitLabInclude): string {
  switch (include.kind) {
    case "remote":
      return "remote includes are not fetched";
    case "project":
      return "includes from other projects are not fetched";
    case "template":
      return "GitLab templates are not fetched";
    case "component":
      return "CI/CD components are not fetched";
    default:
      return "the include entry is not recognized";
  }
}

function mergeLayer(target: Layer, source: Layer): void {
  for (const [key, value] of Object.entries(source.config)) {
    target.config[key] = deepMerge(target.config[key], value);
    const origin = source.origins.get(key);
    if (origin) {
      target.origins.set(key, origin);
    }
  }
}

/**
 * GitLab's deep merge: hashes merge recursively, everything else (arrays,
 * scalars, `!reference` markers) is replaced by the overriding value.
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  const baseRecord = mergeableRecord(base);
  const overrideRecord = mergeableRecord(override);
  if (!baseRecord || !overrideRecord) {
    return override;
  }

  const result: JsonObject = { ...baseRecord };
  for (const [key, value] of Object.entries(overrideRecord)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

function mergeableRecord(value: unknown): JsonObject | null {
  return value instanceof GitLabReference ? null : asRecord(value);
}

function resolveExtends(
  config: JsonObject,
  originOf: (key: string) => string,
  problems: ResolveProblem[],
): Map<string, string[]> {
  const resolved = new Map<string, JsonObject>();
  const extendsByKey = new Map<string, string[]>();

  const resolve = (key: string, stack: string[]): JsonObject | null => {
    const cached = resolved.get(key);
    if (cached) {
      return cached;
    }

    const entry = mergeableRecord(config[key]);
    if (!entry) {
      return null;
    }

    const parents = stringList(entry.extends);
    if (parents.length === 0) {
      resolved.set(key, entry);
      return entry;
    }

    const owner = stack[0] ?? key;
    let base: unknown = {};
    for (const parent of parents) {
      if (parent === key || stack.includes(parent)) {
        problems.push({
          kind: "extends",
          file: originOf(owner),
          job: jobName(owner),
          detail: `\`${key}\` has a circular \`extends: ${parent}\`.`,
        });
        continue;
      }

      if (stack.length >= maxExtendsDepth) {
        problems.push({
          kind: "extends",
          file: originOf(owner),
          job: jobName(owner),
          detail: `\`${key}\` exceeds GitLab's ${maxExtendsDepth}-level \`extends\` limit.`,
        });
        continue;
      }

      const parentConfig = resolve(parent, [...stack, key]);
      if (!parentConfig) {
        problems.push({
          kind: "extends",
          file: originOf(key),
          job: jobName(key),
          detail: `\`${key}\` extends \`${parent}\`, which is not defined in the merged configuration.`,
        });
        continue;
      }

      base = deepMerge(base, parentConfig);
    }

    const result = deepMerge(base, entry) as JsonObject;
    resolved.set(key, result);
    return result;
  };

  for (const key of Object.keys(config)) {
    const entry = mergeableRecord(config[key]);
    if (!entry || entry.extends === undefined) {
      continue;
    }

    extendsByKey.set(key, stringList(entry.extends));
    const result = resolve(key, []);
    if (result) {
      config[key] = result;
    }
  }

  return extendsByKey;
}

function resolveAllReferences(
  config: JsonObject,
  originOf: (key: string) => string,
  problems: ResolveProblem[],
): void {
  const snapshot = { ...config };
  for (const key of Object.keys(config)) {
    config[key] = resolveReferences(snapshot[key], snapshot, 0, (detail) =>
      problems.push({
        kind: "reference",
        file: originOf(key),
        job: jobName(key),
        detail,
      }),
    );
  }
}

function resolveReferences(
  value: unknown,
  config: JsonObject,
  depth: number,
  report: (detail: string) => void,
): unknown {
  if (value instanceof GitLabReference) {
    if (depth >= maxReferenceDepth) {
      report(
        `\`${value.toString()}\` exceeds GitLab's ${maxReferenceDepth}-level \`!reference\` nesting limit.`,
      );
      return undefined;
    }

    const target = lookupPath(config, value.path);
    if (target === undefined) {
      report(
        `\`${value.toString()}\` points at a key that is not defined in the merged configuration.`,
      );
      return undefined;
    }

    return resolveReferences(target, config, depth + 1, report);
  }

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const resolved = resolveReferences(item, config, depth, report);
      if (item instanceof GitLabReference && Array.isArray(resolved)) {
        items.push(...resolved);
      } else if (resolved !== undefined) {
        items.push(resolved);
      }
    }
    return items;
  }

  const record = asRecord(value);
  if (record) {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(record)) {
      const resolved = resolveReferences(child, config, depth, report);
      if (resolved !== undefined) {
        result[key] = resolved;
      }
    }
    return result;
  }

  return value;
}

function lookupPath(config: JsonObject, segments: string[]): unknown {
  let current: unknown = config;
  for (const segment of segments) {
    const record = mergeableRecord(current);
    if (!record || !(segment in record)) {
      return undefined;
    }
    current = record[segment];
  }
  return current;
}

function collectDefaults(
  config: JsonObject,
  originOf: (key: string) => string,
): { defaults: JsonObject; defaultsFile: string } {
  const defaults: JsonObject = {};
  let defaultsFile: string | undefined;

  for (const key of legacyDefaultKeywords) {
    if (config[key] !== undefined) {
      defaults[key] = config[key];
      defaultsFile ??= originOf(key);
    }
  }

  const explicit = asRecord(config.default);
  if (explicit) {
    Object.assign(defaults, explicit);
    defaultsFile = originOf("default");
  }

  return { defaults, defaultsFile: defaultsFile ?? originOf("default") };
}

function allowedDefaultKeys(job: JsonObject): (key: string) => boolean {
  const inherit = asRecord(job.inherit);
  const setting = inherit?.default;
  if (setting === false) {
    return () => false;
  }

  if (Array.isArray(setting)) {
    const allowed = new Set(stringList(setting));
    return (key) => inheritableDefaultKeywords.has(key) && allowed.has(key);
  }

  return (key) => inheritableDefaultKeywords.has(key);
}

function jobName(key: string): string | undefined {
  return key.startsWith(".") || globalKeywords.has(key) ? undefined : key;
}
