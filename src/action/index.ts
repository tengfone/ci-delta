import { reportToMarkdown } from "../reporters/markdown.js";

export async function runActionStub(): Promise<void> {
  const message = reportToMarkdown({
    provider: "github-actions",
    generatedAt: new Date().toISOString(),
    changedFiles: [],
    maxSeverity: "none",
    summary: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
    findings: [],
  });

  process.stdout.write(`${message}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runActionStub().catch((error) => {
    process.stderr.write(`ci-delta action runtime error: ${String(error)}\n`);
    process.exitCode = 3;
  });
}
