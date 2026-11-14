import type {
  FileSnapshot,
  FileSource,
  Finding,
  ProviderAdapter,
} from "../../core/types.js";
import { fileChangeFinding, parseErrorFinding } from "../shared.js";
import { diffPipelines } from "./diff.js";
import {
  extractIncludes,
  isYamlPath,
  matchLocalInclude,
  wildcardToRegExp,
} from "./includes.js";
import { normalizePipeline, type GitLabPipeline } from "./normalize.js";
import { resolvePipeline, type ParsedCiFile } from "./resolve.js";
import { parseGitLabYaml } from "./yaml.js";

export type { GitLabPipeline, ParsedCiFile };

export interface GitLabCiSnapshot {
  /** Every loaded file, parsed. `root` is null when the file is invalid. */
  files: ParsedCiFile[];
  /** Files that start a pipeline (not included by another loaded file). */
  roots: string[];
  parseFindings: Finding[];
}

/** GitLab stops at 150 includes per pipeline; stay well above that. */
const maxIncludedFiles = 500;

export class GitLabCiAdapter implements ProviderAdapter<GitLabCiSnapshot> {
  public readonly id = "gitlab-ci";

  public readonly displayName = "GitLab CI";

  public readonly workflowGlobs = [".gitlab-ci.yml", ".gitlab-ci.yaml"];

  public async expandFiles(
    source: FileSource,
    files: FileSnapshot[],
  ): Promise<FileSnapshot[]> {
    const byPath = new Map(files.map((file) => [file.path, file]));
    const pending = [...files];
    const attempted = new Set<string>(byPath.keys());
    let repositoryPaths: Promise<string[] | null> | undefined;
    const listPaths = () => {
      repositoryPaths ??= source.listPaths
        ? source.listPaths()
        : Promise.resolve(null);
      return repositoryPaths;
    };

    const load = async (filePath: string) => {
      if (attempted.has(filePath) || attempted.size >= maxIncludedFiles) {
        return;
      }
      attempted.add(filePath);
      const extra = await source.readFile(filePath);
      if (extra) {
        byPath.set(extra.path, extra);
        pending.push(extra);
      }
    };

    while (pending.length > 0) {
      const file = pending.shift();
      if (!file) {
        break;
      }

      const { root } = parseGitLabYaml(file.content);
      if (!root) {
        continue;
      }

      for (const include of extractIncludes(root)) {
        if (include.kind !== "local" || !include.localPattern) {
          continue;
        }

        if (!include.wildcard) {
          if (isYamlPath(include.localPattern)) {
            await load(include.localPattern);
          }
          continue;
        }

        const paths = await listPaths();
        if (paths) {
          for (const match of matchLocalInclude(include, paths)) {
            await load(match);
          }
          continue;
        }

        // The source cannot list paths cheaply; ask it for a glob that is a
        // superset of the GitLab wildcard and filter with GitLab's semantics.
        const matcher = wildcardToRegExp(include.localPattern);
        const candidates = await source.listFiles([
          include.localPattern.replace(/\*\*+/g, "**/*"),
        ]);
        for (const candidate of candidates) {
          if (
            matcher.test(candidate.path) &&
            isYamlPath(candidate.path) &&
            !attempted.has(candidate.path)
          ) {
            attempted.add(candidate.path);
            byPath.set(candidate.path, candidate);
            pending.push(candidate);
          }
        }
      }
    }

    return [...byPath.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }

  public async parse(files: FileSnapshot[]): Promise<GitLabCiSnapshot> {
    const parsed: ParsedCiFile[] = [];
    const parseFindings: Finding[] = [];

    for (const file of [...files].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const doc = parseGitLabYaml(file.content);
      parsed.push({
        path: file.path,
        raw: file.content,
        root: doc.root,
        errors: doc.errors,
      });

      if (!doc.root) {
        parseFindings.push(
          parseErrorFinding({
            file: file.path,
            title: "CI file parse error",
            errors: doc.errors,
            recommendation:
              "Fix invalid CI YAML before relying on CI Delta results. ci-delta compares this file as if it were unchanged.",
          }),
        );
      }
    }

    return {
      files: parsed,
      roots: findRoots(parsed, this.workflowGlobs),
      parseFindings,
    };
  }

  public async diff(
    base: GitLabCiSnapshot,
    head: GitLabCiSnapshot,
  ): Promise<Finding[]> {
    return [
      ...base.parseFindings,
      ...head.parseFindings,
      ...diffSnapshots(base, head),
    ];
  }
}

function findRoots(files: ParsedCiFile[], defaultRoots: string[]): string[] {
  const paths = files.map((file) => file.path);
  const included = new Set<string>();

  for (const file of files) {
    if (!file.root) {
      continue;
    }

    for (const include of extractIncludes(file.root)) {
      if (include.kind !== "local") {
        continue;
      }
      for (const match of matchLocalInclude(
        include,
        paths.filter((candidate) => candidate !== file.path),
      )) {
        included.add(match);
      }
    }
  }

  const roots = paths.filter((candidate) => !included.has(candidate));
  if (roots.length > 0 || paths.length === 0) {
    return roots;
  }

  // Every file is included by another one (an include cycle). Fall back to
  // the conventional root file names.
  return paths.filter((candidate) => defaultRoots.includes(candidate));
}

/**
 * Compares two snapshots: reports added and removed files, then builds the
 * effective pipeline for each root on both sides and compares those, so moving
 * a job between files without changing it produces no job findings.
 */
export function diffSnapshots(
  base: GitLabCiSnapshot,
  head: GitLabCiSnapshot,
): Finding[] {
  const findings: Finding[] = [];
  const baseByPath = new Map(base.files.map((file) => [file.path, file]));
  const headByPath = new Map(head.files.map((file) => [file.path, file]));
  const paths = [
    ...new Set([...baseByPath.keys(), ...headByPath.keys()]),
  ].sort();

  for (const filePath of paths) {
    const before = baseByPath.get(filePath);
    const after = headByPath.get(filePath);
    if (before && !after) {
      findings.push(
        fileRemovedFinding(filePath, base.roots.includes(filePath)),
      );
    } else if (after && !before) {
      findings.push(fileAddedFinding(filePath, head.roots.includes(filePath)));
    }
  }

  const baseDocs = substituteInvalid(baseByPath, headByPath);
  const headDocs = substituteInvalid(headByPath, baseByPath);

  for (const rootPath of [...head.roots].sort()) {
    const headPipeline = buildPipeline(rootPath, headDocs);
    const basePipeline = baseDocs.has(rootPath)
      ? buildPipeline(rootPath, baseDocs)
      : undefined;
    findings.push(...diffPipelines(basePipeline, headPipeline));
  }

  return findings;
}

function buildPipeline(
  rootPath: string,
  docs: Map<string, ParsedCiFile>,
): GitLabPipeline {
  return normalizePipeline(resolvePipeline(rootPath, docs));
}

/**
 * When a file fails to parse on one side, compare it as if it were unchanged
 * (using the other side's parse) so the parse error finding is not followed by
 * a cascade of bogus job removals or additions.
 */
function substituteInvalid(
  side: Map<string, ParsedCiFile>,
  other: Map<string, ParsedCiFile>,
): Map<string, ParsedCiFile> {
  const result = new Map<string, ParsedCiFile>();
  for (const [filePath, file] of side) {
    const fallback = other.get(filePath);
    result.set(
      filePath,
      !file.root && fallback?.root ? { ...file, root: fallback.root } : file,
    );
  }
  return result;
}

function fileAddedFinding(filePath: string, root: boolean): Finding {
  return root
    ? fileChangeFinding({
        id: "ci-file-added",
        title: "CI file added",
        severity: "medium",
        file: filePath,
        evidence: `New CI file detected: ${filePath}`,
        recommendation:
          "Review the new CI file's jobs, rules, images, runner tags, and secrets before merge.",
      })
    : fileChangeFinding({
        id: "ci-file-added",
        title: "Included CI file added",
        severity: "info",
        file: filePath,
        evidence: `New included CI file: ${filePath}. Its jobs are compared as part of the merged pipeline.`,
        recommendation:
          "Job-level findings, if any, describe what this file changes in the effective pipeline.",
      });
}

function fileRemovedFinding(filePath: string, root: boolean): Finding {
  return root
    ? fileChangeFinding({
        id: "ci-file-removed",
        title: "CI file removed",
        severity: "medium",
        file: filePath,
        evidence: `CI file removed: ${filePath}`,
        recommendation:
          "Confirm the removed CI file is no longer required by pipeline gates.",
      })
    : fileChangeFinding({
        id: "ci-file-removed",
        title: "Included CI file removed",
        severity: "info",
        file: filePath,
        evidence: `Included CI file removed: ${filePath}. Its jobs are compared as part of the merged pipeline.`,
        recommendation:
          "Job-level findings, if any, describe what removing this file changes in the effective pipeline.",
      });
}
