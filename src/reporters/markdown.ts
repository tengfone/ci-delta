import type { Report, Severity } from "../core/types.js";

const orderedSeverities: Severity[] = ["critical", "high", "medium", "low", "info"];

export function reportToMarkdown(report: Report): string {
  const lines: string[] = [];

  lines.push("## CI Delta Report", "", `Risk: ${capitalize(report.maxSeverity)}`, "");

  if (report.changedFiles.length === 0) {
    lines.push("No GitHub Actions workflow changes detected.");
    return lines.join("\n");
  }

  lines.push("Changed workflow files:");
  for (const file of report.changedFiles) {
    lines.push(`- \`${file}\``);
  }

  for (const severity of orderedSeverities) {
    const matches = report.findings.filter((finding) => finding.severity === severity);
    if (matches.length === 0) {
      continue;
    }

    lines.push("", `### ${capitalize(severity)}`, "");

    for (const finding of matches) {
      lines.push(`#### ${finding.title}`, "", `File: \`${finding.file}\``, "");

      if (finding.evidence.length > 0) {
        lines.push("Evidence:");
        for (const entry of finding.evidence) {
          lines.push(`- ${entry}`);
        }
        lines.push("");
      }

      if (finding.recommendation) {
        lines.push(`Recommendation: ${finding.recommendation}`, "");
      }
    }
  }

  lines.push("### Summary", "");
  for (const severity of orderedSeverities) {
    lines.push(`- ${capitalize(severity)}: ${report.summary[severity]}`);
  }

  return lines.join("\n").trimEnd();
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
