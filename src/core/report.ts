import type { Finding, Report } from "./types.js";
import { getSummary, maxSeverity } from "./severity.js";

export function buildReport(params: {
  provider: string;
  baseRef?: string;
  headRef?: string;
  changedFiles: string[];
  findings: Finding[];
}): Report {
  const findings = [...params.findings].sort((a, b) => {
    if (a.severity !== b.severity) {
      const order = ["critical", "high", "medium", "low", "info"];
      return order.indexOf(a.severity) - order.indexOf(b.severity);
    }

    if (a.category !== b.category) {
      return a.category.localeCompare(b.category);
    }

    return a.file.localeCompare(b.file);
  });

  return {
    provider: params.provider,
    baseRef: params.baseRef,
    headRef: params.headRef,
    generatedAt: new Date().toISOString(),
    changedFiles: [...params.changedFiles].sort(),
    maxSeverity: maxSeverity(findings),
    summary: getSummary(findings),
    findings,
  };
}
