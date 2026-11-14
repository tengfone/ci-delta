import { isScalar, parseAllDocuments, type CollectionTag } from "yaml";
import { asRecord, type JsonObject } from "../shared.js";

/**
 * A GitLab `!reference [job, key, ...]` tag. It is kept as a marker during
 * parsing and resolved against the merged configuration later, because it may
 * point at keys defined in other included files.
 */
export class GitLabReference {
  public constructor(public readonly path: string[]) {}

  public toString(): string {
    return `!reference [${this.path.join(", ")}]`;
  }
}

const referenceTag: CollectionTag = {
  tag: "!reference",
  collection: "seq",
  identify: (value) => value instanceof GitLabReference,
  resolve(seq, onError) {
    const path = seq.items.map((item) =>
      isScalar(item) ? String(item.value) : "",
    );
    if (path.length === 0 || path.some((segment) => segment === "")) {
      onError("!reference expects a sequence of key names");
    }

    return new GitLabReference(path);
  },
};

export interface ParsedGitLabYaml {
  root: JsonObject | null;
  errors: string[];
}

/**
 * Parses one GitLab CI YAML file the way GitLab reads it:
 * - YAML merge keys (`<<: *anchor`) are applied,
 * - `!reference` tags become {@link GitLabReference} markers,
 * - duplicate keys keep the last value instead of failing,
 * - an optional `spec:` header document before `---` is skipped,
 * - the configuration must be a mapping.
 */
export function parseGitLabYaml(content: string): ParsedGitLabYaml {
  const documents = parseAllDocuments(content, {
    merge: true,
    uniqueKeys: false,
    customTags: [referenceTag],
  });
  const list = Array.isArray(documents) ? documents : [];

  const errors = list.flatMap((doc) =>
    doc.errors.map((error) => error.message),
  );
  if (errors.length > 0) {
    return { root: null, errors };
  }

  if (list.length === 0) {
    return { root: {}, errors: [] };
  }

  let configDocument = list[0];
  if (list.length === 2) {
    const header = asRecord(safeToJs(list[0]).value);
    if (!header || !("spec" in header)) {
      return {
        root: null,
        errors: [
          "Found more than one YAML document. GitLab only accepts a `spec:` header document followed by the configuration.",
        ],
      };
    }
    configDocument = list[1];
  } else if (list.length > 2) {
    return {
      root: null,
      errors: [
        `Found ${list.length} YAML documents. GitLab only accepts a \`spec:\` header document followed by the configuration.`,
      ],
    };
  }

  if (!configDocument) {
    return { root: {}, errors: [] };
  }

  const converted = safeToJs(configDocument);
  if (converted.error) {
    return { root: null, errors: [converted.error] };
  }

  if (converted.value === null || converted.value === undefined) {
    return { root: {}, errors: [] };
  }

  const root = asRecord(converted.value);
  if (!root || converted.value instanceof GitLabReference) {
    return {
      root: null,
      errors: [
        `The top level of a GitLab CI file must be a mapping of keywords and jobs, found ${describeValue(converted.value)}.`,
      ],
    };
  }

  return { root, errors: [] };
}

function safeToJs(document: { toJS(options?: object): unknown }): {
  value: unknown;
  error?: string;
} {
  try {
    return { value: document.toJS({ maxAliasCount: 10_000 }) };
  } catch (error) {
    return {
      value: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return "a sequence";
  }

  if (value instanceof GitLabReference) {
    return "a !reference tag";
  }

  return `a ${typeof value} value`;
}
