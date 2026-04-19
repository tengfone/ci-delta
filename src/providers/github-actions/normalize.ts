export type JsonObject = Record<string, unknown>;

export interface GitHubActionsWorkflow {
  path: string;
  raw: string;
  parsed: JsonObject;
  name?: string;
  triggers: NormalizedTriggers;
  permissions: NormalizedPermissions;
  jobs: Record<string, NormalizedJob>;
}

export type NormalizedTriggers = Record<string, NormalizedTrigger>;

export interface NormalizedTrigger {
  name: string;
  raw: unknown;
  branches: string[];
  branchesIgnore: string[];
  paths: string[];
  pathsIgnore: string[];
  tags: string[];
}

export type PermissionAccess = "none" | "read" | "write";

export type PermissionMode =
  | "unset"
  | "none"
  | "read-all"
  | "write-all"
  | "scoped";

export interface NormalizedPermissions {
  mode: PermissionMode;
  scopes: Record<string, PermissionAccess>;
  raw: unknown;
}

export interface NormalizedJob {
  id: string;
  name?: string;
  raw: JsonObject;
  runsOn: string[];
  permissions: NormalizedPermissions;
  needs: string[];
  environment?: string;
  containerImage?: string;
  services: NormalizedService[];
  steps: NormalizedStep[];
  env: JsonObject;
}

export interface NormalizedService {
  name: string;
  image?: string;
  options?: string;
  raw: unknown;
}

export interface NormalizedStep {
  index: number;
  name?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with: JsonObject;
  env: JsonObject;
  raw: JsonObject;
}

export function normalizeWorkflow(
  path: string,
  raw: string,
  parsed: unknown,
): GitHubActionsWorkflow {
  const root = asRecord(parsed) ?? {};

  return {
    path,
    raw,
    parsed: root,
    name: stringValue(root.name),
    triggers: normalizeTriggers(root.on),
    permissions: normalizePermissions(root.permissions),
    jobs: normalizeJobs(root.jobs),
  };
}

export function normalizeTriggers(value: unknown): NormalizedTriggers {
  const triggers: NormalizedTriggers = {};

  if (typeof value === "string") {
    addTrigger(triggers, value, undefined);
    return triggers;
  }

  if (Array.isArray(value)) {
    for (const event of value) {
      if (typeof event === "string") {
        addTrigger(triggers, event, undefined);
      }
    }
    return triggers;
  }

  const triggerMap = asRecord(value);
  if (!triggerMap) {
    return triggers;
  }

  for (const [event, config] of Object.entries(triggerMap)) {
    addTrigger(triggers, event, config);
  }

  return triggers;
}

export function normalizePermissions(value: unknown): NormalizedPermissions {
  if (value === undefined || value === null) {
    return { mode: "unset", scopes: {}, raw: value };
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized === "read-all" || normalized === "write-all") {
      return { mode: normalized, scopes: {}, raw: value };
    }

    return { mode: "scoped", scopes: {}, raw: value };
  }

  const map = asRecord(value);
  if (!map) {
    return { mode: "unset", scopes: {}, raw: value };
  }

  const entries = Object.entries(map);
  if (entries.length === 0) {
    return { mode: "none", scopes: {}, raw: value };
  }

  const scopes: Record<string, PermissionAccess> = {};
  for (const [scope, access] of entries) {
    const normalized = normalizePermissionAccess(access);
    if (normalized) {
      scopes[scope] = normalized;
    }
  }

  return { mode: "scoped", scopes, raw: value };
}

export function permissionAccess(
  permissions: NormalizedPermissions,
  scope: string,
): PermissionAccess {
  if (permissions.mode === "write-all") {
    return "write";
  }

  if (permissions.mode === "read-all") {
    return "read";
  }

  if (permissions.mode === "none") {
    return "none";
  }

  return permissions.scopes[scope] ?? "none";
}

export function hasWritePermission(
  permissions: NormalizedPermissions,
): boolean {
  if (permissions.mode === "write-all") {
    return true;
  }

  return Object.values(permissions.scopes).some((access) => access === "write");
}

export function explicitWriteScopes(
  permissions: NormalizedPermissions,
): string[] {
  if (permissions.mode === "write-all") {
    return ["*"];
  }

  return Object.entries(permissions.scopes)
    .filter(([, access]) => access === "write")
    .map(([scope]) => scope)
    .sort();
}

export function normalizeJobs(value: unknown): Record<string, NormalizedJob> {
  const jobMap = asRecord(value);
  if (!jobMap) {
    return {};
  }

  const jobs: Record<string, NormalizedJob> = {};
  for (const [id, rawJob] of Object.entries(jobMap)) {
    const job = asRecord(rawJob);
    if (!job) {
      continue;
    }

    jobs[id] = {
      id,
      name: stringValue(job.name),
      raw: job,
      runsOn: stringList(job["runs-on"]),
      permissions: normalizePermissions(job.permissions),
      needs: stringList(job.needs),
      environment: normalizeEnvironment(job.environment),
      containerImage: normalizeContainerImage(job.container),
      services: normalizeServices(job.services),
      steps: normalizeSteps(job.steps),
      env: asRecord(job.env) ?? {},
    };
  }

  return jobs;
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

export function asRecord(value: unknown): JsonObject | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  return null;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function addTrigger(
  triggers: NormalizedTriggers,
  event: string,
  config: unknown,
): void {
  const triggerConfig = asRecord(config) ?? {};

  triggers[event] = {
    name: event,
    raw: config,
    branches: stringList(triggerConfig.branches),
    branchesIgnore: stringList(triggerConfig["branches-ignore"]),
    paths: stringList(triggerConfig.paths),
    pathsIgnore: stringList(triggerConfig["paths-ignore"]),
    tags: stringList(triggerConfig.tags),
  };
}

function normalizePermissionAccess(
  value: unknown,
): PermissionAccess | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase();
  if (
    normalized === "read" ||
    normalized === "write" ||
    normalized === "none"
  ) {
    return normalized;
  }

  return undefined;
}

function normalizeEnvironment(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const map = asRecord(value);
  return stringValue(map?.name);
}

function normalizeContainerImage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const map = asRecord(value);
  return stringValue(map?.image);
}

function normalizeServices(value: unknown): NormalizedService[] {
  const services = asRecord(value);
  if (!services) {
    return [];
  }

  return Object.entries(services).map(([name, rawService]) => {
    if (typeof rawService === "string") {
      return { name, image: rawService, raw: rawService };
    }

    const service = asRecord(rawService);
    return {
      name,
      image: stringValue(service?.image),
      options: stringValue(service?.options),
      raw: rawService,
    };
  });
}

function normalizeSteps(value: unknown): NormalizedStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((rawStep, index) => {
    const step = asRecord(rawStep);
    if (!step) {
      return [];
    }

    return {
      index,
      name: stringValue(step.name),
      uses: stringValue(step.uses),
      run: stringValue(step.run),
      shell: stringValue(step.shell),
      with: asRecord(step.with) ?? {},
      env: asRecord(step.env) ?? {},
      raw: step,
    };
  });
}
