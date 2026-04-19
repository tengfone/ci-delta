import type { Report } from "../core/types.js";

export const reportSchemaVersion = "ci-delta.report.v1";

export function reportToJson(report: Report): string {
  return JSON.stringify(
    { schemaVersion: reportSchemaVersion, ...report },
    null,
    2,
  );
}
