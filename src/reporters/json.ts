import type { Report } from "../core/types.js";

export function reportToJson(report: Report): string {
  return JSON.stringify(report, null, 2);
}
