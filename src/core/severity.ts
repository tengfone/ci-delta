import type { Finding, Report, Severity } from "./types.js";

const severityRank: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function compareSeverity(a: Severity, b: Severity): number {
  return severityRank[b] - severityRank[a];
}

export function maxSeverity(findings: Finding[]): Severity | "none" {
  if (findings.length === 0) {
    return "none";
  }

  return findings
    .map((finding) => finding.severity)
    .sort((a, b) => compareSeverity(a, b))[0];
}

export function getSummary(findings: Finding[]): Report["summary"] {
  const summary: Report["summary"] = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };

  for (const finding of findings) {
    summary[finding.severity] += 1;
  }

  return summary;
}

export function meetsThreshold(
  findings: Finding[],
  threshold: Severity | "none",
): boolean {
  if (threshold === "none") {
    return false;
  }

  return findings.some(
    (finding) => severityRank[finding.severity] >= severityRank[threshold],
  );
}
