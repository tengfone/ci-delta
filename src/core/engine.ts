import { buildReport } from "./report.js";
import type {
  FileSnapshot,
  FileSource,
  ProviderAdapter,
  Report,
} from "./types.js";

export interface CompareSourcesParams<Snapshot> {
  provider: ProviderAdapter<Snapshot>;
  baseSource: FileSource;
  headSource: FileSource;
  globs?: string[];
  baseRef?: string;
  headRef?: string;
}

export async function compareSources<Snapshot>({
  provider,
  baseSource,
  headSource,
  globs = provider.workflowGlobs,
  baseRef,
  headRef,
}: CompareSourcesParams<Snapshot>): Promise<Report> {
  const [baseFiles, headFiles] = await Promise.all([
    baseSource.listFiles(globs),
    headSource.listFiles(globs),
  ]);

  const [baseSnapshot, headSnapshot] = await Promise.all([
    provider.parse(baseFiles),
    provider.parse(headFiles),
  ]);

  const findings = await provider.diff(baseSnapshot, headSnapshot);

  return buildReport({
    provider: provider.id,
    baseRef,
    headRef,
    changedFiles: changedFilePaths(baseFiles, headFiles),
    findings,
  });
}

export function changedFilePaths(
  baseFiles: FileSnapshot[],
  headFiles: FileSnapshot[],
): string[] {
  const paths = new Set<string>();
  const baseByPath = toPathMap(baseFiles);
  const headByPath = toPathMap(headFiles);

  for (const path of new Set([...baseByPath.keys(), ...headByPath.keys()])) {
    const base = baseByPath.get(path);
    const head = headByPath.get(path);

    if (!base || !head) {
      paths.add(path);
      continue;
    }

    if (base.content !== head.content || base.sha !== head.sha) {
      paths.add(path);
    }
  }

  return [...paths].sort();
}

function toPathMap(files: FileSnapshot[]): Map<string, FileSnapshot> {
  return new Map(files.map((file) => [file.path, file]));
}
