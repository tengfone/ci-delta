type Severity = "info" | "low" | "medium" | "high" | "critical";
type FindingCategory = "trigger" | "permission" | "secret" | "oidc" | "runner" | "checkout" | "deployment" | "supply-chain" | "workflow-graph" | "config" | "unknown";
interface Finding {
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
interface Report {
    provider: string;
    baseRef?: string;
    headRef?: string;
    generatedAt: string;
    changedFiles: string[];
    maxSeverity: Severity | "none";
    summary: Record<Severity, number>;
    findings: Finding[];
}
interface FileSnapshot {
    path: string;
    content: string;
    sha?: string;
}
interface FileSource {
    listFiles(globs: string[]): Promise<FileSnapshot[]>;
    readFile(path: string): Promise<FileSnapshot | null>;
}
interface ProviderAdapter<Snapshot> {
    id: string;
    displayName: string;
    workflowGlobs: string[];
    parse(files: FileSnapshot[]): Promise<Snapshot>;
    diff(base: Snapshot, head: Snapshot): Promise<Finding[]>;
}

declare function buildReport(params: {
    provider: string;
    baseRef?: string;
    headRef?: string;
    changedFiles: string[];
    findings: Finding[];
}): Report;

interface CompareSourcesParams<Snapshot> {
    provider: ProviderAdapter<Snapshot>;
    baseSource: FileSource;
    headSource: FileSource;
    globs?: string[];
    baseRef?: string;
    headRef?: string;
}
declare function compareSources<Snapshot>({ provider, baseSource, headSource, globs, baseRef, headRef, }: CompareSourcesParams<Snapshot>): Promise<Report>;
declare function changedFilePaths(baseFiles: FileSnapshot[], headFiles: FileSnapshot[]): string[];

declare function compareSeverity(a: Severity, b: Severity): number;
declare function maxSeverity(findings: Finding[]): Severity | "none";
declare function getSummary(findings: Finding[]): Report["summary"];
declare function meetsThreshold(findings: Finding[], threshold: Severity | "none"): boolean;

type JsonObject = Record<string, unknown>;
interface GitHubActionsWorkflow {
    path: string;
    raw: string;
    parsed: JsonObject;
    name?: string;
    triggers: NormalizedTriggers;
    permissions: NormalizedPermissions;
    jobs: Record<string, NormalizedJob>;
}
type NormalizedTriggers = Record<string, NormalizedTrigger>;
interface NormalizedTrigger {
    name: string;
    raw: unknown;
    branches: string[];
    branchesIgnore: string[];
    paths: string[];
    pathsIgnore: string[];
    tags: string[];
}
type PermissionAccess = "none" | "read" | "write";
type PermissionMode = "unset" | "none" | "read-all" | "write-all" | "scoped";
interface NormalizedPermissions {
    mode: PermissionMode;
    scopes: Record<string, PermissionAccess>;
    raw: unknown;
}
interface NormalizedJob {
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
interface NormalizedService {
    name: string;
    image?: string;
    options?: string;
    raw: unknown;
}
interface NormalizedStep {
    index: number;
    name?: string;
    uses?: string;
    run?: string;
    shell?: string;
    with: JsonObject;
    env: JsonObject;
    raw: JsonObject;
}
declare function normalizeWorkflow(path: string, raw: string, parsed: unknown): GitHubActionsWorkflow;
declare function normalizeTriggers(value: unknown): NormalizedTriggers;
declare function normalizePermissions(value: unknown): NormalizedPermissions;
declare function permissionAccess(permissions: NormalizedPermissions, scope: string): PermissionAccess;
declare function hasWritePermission(permissions: NormalizedPermissions): boolean;
declare function explicitWriteScopes(permissions: NormalizedPermissions): string[];
declare function normalizeJobs(value: unknown): Record<string, NormalizedJob>;
declare function stringList(value: unknown): string[];
declare function asRecord(value: unknown): JsonObject | null;
declare function stringValue(value: unknown): string | undefined;

interface GitHubActionsSnapshot {
    workflows: GitHubActionsWorkflow[];
    parseFindings: Finding[];
}
declare class GitHubActionsAdapter implements ProviderAdapter<GitHubActionsSnapshot> {
    readonly id = "github-actions";
    readonly displayName = "GitHub Actions";
    readonly workflowGlobs: string[];
    parse(files: FileSnapshot[]): Promise<GitHubActionsSnapshot>;
    diff(base: GitHubActionsSnapshot, head: GitHubActionsSnapshot): Promise<Finding[]>;
}

declare function reportToMarkdown(report: Report): string;

declare const reportSchemaVersion = "ci-delta.report.v1";
declare function reportToJson(report: Report): string;

declare class LocalGitFileSource {
    private readonly repoRoot;
    private readonly ref;
    constructor(repoRoot: string, ref: string);
    listFiles(globs: string[]): Promise<FileSnapshot[]>;
    readFile(path: string): Promise<FileSnapshot | null>;
}

interface GitHubRepositoryRef {
    owner: string;
    repo: string;
}
interface GitHubApiFileSourceOptions {
    repository: GitHubRepositoryRef;
    ref: string;
    token: string;
    apiUrl?: string;
    fetchImpl?: typeof fetch;
}
declare class GitHubApiFileSource implements FileSource {
    private readonly options;
    private readonly apiUrl;
    private readonly fetchImpl;
    private treeCache?;
    private readonly blobCache;
    constructor(options: GitHubApiFileSourceOptions);
    listFiles(globs: string[]): Promise<FileSnapshot[]>;
    readFile(filePath: string): Promise<FileSnapshot | null>;
    private getTree;
    private request;
    private get owner();
    private get repo();
}
declare function parseGitHubRepository(fullName: string): GitHubRepositoryRef;

export { type CompareSourcesParams, type FileSnapshot, type FileSource, type Finding, type FindingCategory, GitHubActionsAdapter, type GitHubActionsSnapshot, type GitHubActionsWorkflow, GitHubApiFileSource, type GitHubApiFileSourceOptions, type GitHubRepositoryRef, type JsonObject, LocalGitFileSource, type NormalizedJob, type NormalizedPermissions, type NormalizedService, type NormalizedStep, type NormalizedTrigger, type NormalizedTriggers, type PermissionAccess, type PermissionMode, type ProviderAdapter, type Report, type Severity, asRecord, buildReport, changedFilePaths, compareSeverity, compareSources, explicitWriteScopes, getSummary, hasWritePermission, maxSeverity, meetsThreshold, normalizeJobs, normalizePermissions, normalizeTriggers, normalizeWorkflow, parseGitHubRepository, permissionAccess, reportSchemaVersion, reportToJson, reportToMarkdown, stringList, stringValue };
