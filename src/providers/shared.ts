import type { Finding, Severity } from "../core/types.js";

/**
 * Helpers shared by every CI provider. Keep provider-specific semantics in the
 * provider modules; only put logic here when it means the same thing for every
 * platform.
 */

export type JsonObject = Record<string, unknown>;

/** Stable finding id for unparseable CI files, shared by every provider. */
export const parseErrorFindingId = "workflow-parse-error";

export function asRecord(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return null;
}

export function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  return [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Renders values as a comma-separated list of inline code spans. `emptyLabel`
 * is what an empty list means for the caller, such as "`<all>`" for an absent
 * filter or "`none`" for an absent tag list.
 */
export function formatList(values: string[], emptyLabel = "`<all>`"): string {
  if (values.length === 0) {
    return emptyLabel;
  }

  return values.map((value) => `\`${value}\``).join(", ");
}

/** Order-insensitive comparison of two string lists. */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const right = new Set(b);
  return new Set(a).size === right.size && a.every((value) => right.has(value));
}

/**
 * True when an image reference floats: an explicit `:latest` tag or no tag at
 * all. Digest-pinned references never float.
 */
export function imageUsesLatest(image: string): boolean {
  if (image.includes("@sha256:")) {
    return false;
  }

  const lastSegment = image.split("/").pop() ?? image;
  return lastSegment.endsWith(":latest") || !lastSegment.includes(":");
}

/**
 * Docker-in-Docker images (`docker:dind`, `docker:24-dind`,
 * `registry.example.com/docker:27.1-dind-rootless`) need a privileged runner
 * or container to work.
 */
export function isDockerInDockerImage(image: string | undefined): boolean {
  if (!image) {
    return false;
  }

  const lastSegment = image.toLowerCase().split("/").pop() ?? "";
  return /^docker:(?:[^\s]*-)?dind(?:-[^\s]*)?$/.test(lastSegment);
}

export function isPrivilegedService(
  image: string | undefined,
  options: string | undefined,
): boolean {
  return (
    isDockerInDockerImage(image) ||
    options?.toLowerCase().includes("privileged") === true
  );
}

export function isProductionEnvironment(environment: string): boolean {
  return /^prod(uction)?$/i.test(environment);
}

/** Heuristic used to raise severity for jobs that look like deploys. */
export function isDeployLikeName(...names: Array<string | undefined>): boolean {
  const haystack = names
    .filter((name): name is string => Boolean(name))
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("deploy") ||
    haystack.includes("release") ||
    haystack.includes("publish")
  );
}

/** Heuristic for jobs that usually act as validation gates. */
export function isGateJobName(jobId: string): boolean {
  const normalized = jobId.toLowerCase();
  return (
    normalized.includes("test") ||
    normalized.includes("lint") ||
    normalized.includes("build")
  );
}

export function parseErrorFinding(params: {
  file: string;
  title: string;
  errors: string[];
  recommendation: string;
}): Finding {
  return {
    id: parseErrorFindingId,
    title: params.title,
    severity: "high",
    category: "config",
    file: params.file,
    evidence: params.errors,
    recommendation: params.recommendation,
  };
}

export function fileChangeFinding(params: {
  id: string;
  title: string;
  severity: Severity;
  file: string;
  evidence: string;
  recommendation: string;
}): Finding {
  return {
    id: params.id,
    title: params.title,
    severity: params.severity,
    category: "config",
    file: params.file,
    evidence: [params.evidence],
    recommendation: params.recommendation,
  };
}
