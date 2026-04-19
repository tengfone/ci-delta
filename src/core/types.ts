export type Severity = "info" | "low" | "medium" | "high" | "critical";

export type FindingCategory =
  | "trigger"
  | "permission"
  | "secret"
  | "oidc"
  | "runner"
  | "checkout"
  | "deployment"
  | "supply-chain"
  | "workflow-graph"
  | "config"
  | "unknown";

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  category: FindingCategory;
  file: string;
  job?: string;
  before?: unknown;
  after?: unknown;
  evidence: string[];
  recommendation?: string;
}

export interface Report {
  provider: string;
  baseRef?: string;
  headRef?: string;
  generatedAt: string;
  changedFiles: string[];
  maxSeverity: Severity | "none";
  summary: Record<Severity, number>;
  findings: Finding[];
}

export interface FileSnapshot {
  path: string;
  content: string;
  sha?: string;
}

export interface FileSource {
  listFiles(globs: string[]): Promise<FileSnapshot[]>;
  readFile(path: string): Promise<FileSnapshot | null>;
}

export interface ProviderAdapter<Snapshot> {
  id: string;
  displayName: string;
  workflowGlobs: string[];
  parse(files: FileSnapshot[]): Promise<Snapshot>;
  diff(base: Snapshot, head: Snapshot): Promise<Finding[]>;
}
