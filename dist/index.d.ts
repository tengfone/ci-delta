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
    /** Returns null when the path does not exist or is not a regular file. */
    readFile(path: string): Promise<FileSnapshot | null>;
    /**
     * Optional: every file path at this ref, without reading contents. Providers
     * use it to resolve wildcard includes cheaply.
     */
    listPaths?(): Promise<string[]>;
}
interface ProviderAdapter<Snapshot> {
    id: string;
    displayName: string;
    workflowGlobs: string[];
    parse(files: FileSnapshot[]): Promise<Snapshot>;
    diff(base: Snapshot, head: Snapshot): Promise<Finding[]>;
    expandFiles?(source: FileSource, files: FileSnapshot[]): Promise<FileSnapshot[]>;
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

/**
 * Helpers shared by every CI provider. Keep provider-specific semantics in the
 * provider modules; only put logic here when it means the same thing for every
 * platform.
 */
type JsonObject = Record<string, unknown>;
declare function asRecord(value: unknown): JsonObject | null;
declare function stringList(value: unknown): string[];
declare function stringValue(value: unknown): string | undefined;

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

type IncludeKind = "local" | "remote" | "project" | "template" | "component" | "unknown";
/** One entry of a file's `include:` keyword. */
interface GitLabInclude {
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
interface ParsedCiFile {
    path: string;
    raw: string;
    root: JsonObject | null;
    errors: string[];
}
interface IncludeRecord {
    /** File that declares the include. */
    file: string;
    include: GitLabInclude;
    /** Repository paths the include resolved to. */
    matched: string[];
    /** Why the include was not expanded, when it was not. */
    notExpandedReason?: string;
}
interface ResolveProblem {
    kind: "extends" | "reference" | "include-cycle";
    file: string;
    job?: string;
    detail: string;
}

interface GitLabRule {
    ifClause?: string;
    /** `when:` exactly as written, if any. */
    when?: string;
    changes: string[];
    hasChanges: boolean;
    compareTo?: string;
    exists: string[];
    hasExists: boolean;
}
interface GitLabOnlyExcept {
    refs: string[];
    variables: string[];
    changes: string[];
    kubernetes?: string;
}
interface GitLabNeed {
    name: string;
    optional: boolean;
}
interface GitLabTrigger {
    /** Downstream project for multi-project pipelines. */
    project?: string;
    branch?: string;
    /** Child pipeline configuration sources, rendered. */
    include: string[];
    strategy?: string;
}
interface GitLabEnvironment {
    name: string;
    action?: string;
    deploymentTier?: string;
}
interface GitLabSecret {
    name: string;
    source: string;
}
interface GitLabVariable {
    name: string;
    valueText?: string;
}
interface GitLabService {
    key: string;
    image?: string;
    label: string;
}
interface GitLabScript {
    location: string;
    text: string;
    inherited: boolean;
}
interface GitLabIdToken {
    name: string;
    aud?: string;
}
type AllowFailure = "true" | "false" | "exit_codes";
interface GitLabJob {
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
interface GitLabDefaults {
    file: string;
    image?: string;
    services: GitLabService[];
    tags?: string[];
    idTokens: GitLabIdToken[];
    scripts: GitLabScript[];
}
interface GitLabPipeline {
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

interface GitLabCiSnapshot {
    /** Every loaded file, parsed. `root` is null when the file is invalid. */
    files: ParsedCiFile[];
    /** Files that start a pipeline (not included by another loaded file). */
    roots: string[];
    parseFindings: Finding[];
}
declare class GitLabCiAdapter implements ProviderAdapter<GitLabCiSnapshot> {
    readonly id = "gitlab-ci";
    readonly displayName = "GitLab CI";
    readonly workflowGlobs: string[];
    expandFiles(source: FileSource, files: FileSnapshot[]): Promise<FileSnapshot[]>;
    parse(files: FileSnapshot[]): Promise<GitLabCiSnapshot>;
    diff(base: GitLabCiSnapshot, head: GitLabCiSnapshot): Promise<Finding[]>;
}
/**
 * Compares two snapshots: reports added and removed files, then builds the
 * effective pipeline for each root on both sides and compares those, so moving
 * a job between files without changing it produces no job findings.
 */
declare function diffSnapshots(base: GitLabCiSnapshot, head: GitLabCiSnapshot): Finding[];

type CiProviderId = "github-actions" | "gitlab-ci";
declare const providerAliases = "github-actions, gha, github, gitlab-ci, gitlab";
declare function resolveProviderId(input: string): CiProviderId | null;
declare function createProviderAdapter(id: CiProviderId): ProviderAdapter<unknown>;

declare function reportToMarkdown(report: Report): string;

declare const reportSchemaVersion = "ci-delta.report.v1";
declare function reportToJson(report: Report): string;

declare class LocalGitFileSource implements FileSource {
    private readonly repoRoot;
    private readonly ref;
    private pathsCache?;
    constructor(repoRoot: string, ref: string);
    listPaths(): Promise<string[]>;
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
    listPaths(): Promise<string[]>;
    readFile(filePath: string): Promise<FileSnapshot | null>;
    private getTree;
    private request;
    private get owner();
    private get repo();
}
declare function parseGitHubRepository(fullName: string): GitHubRepositoryRef;

export { type CiProviderId, type CompareSourcesParams, type FileSnapshot, type FileSource, type Finding, type FindingCategory, GitHubActionsAdapter, type GitHubActionsSnapshot, type GitHubActionsWorkflow, GitHubApiFileSource, type GitHubApiFileSourceOptions, type GitHubRepositoryRef, GitLabCiAdapter, type GitLabCiSnapshot, type GitLabPipeline, type JsonObject, LocalGitFileSource, type NormalizedJob, type NormalizedPermissions, type NormalizedService, type NormalizedStep, type NormalizedTrigger, type NormalizedTriggers, type ParsedCiFile, type PermissionAccess, type PermissionMode, type ProviderAdapter, type Report, type Severity, asRecord, buildReport, changedFilePaths, compareSeverity, compareSources, createProviderAdapter, diffSnapshots, explicitWriteScopes, getSummary, hasWritePermission, maxSeverity, meetsThreshold, normalizeJobs, normalizePermissions, normalizeTriggers, normalizeWorkflow, parseGitHubRepository, permissionAccess, providerAliases, reportSchemaVersion, reportToJson, reportToMarkdown, resolveProviderId, stringList, stringValue };
