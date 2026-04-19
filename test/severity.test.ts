import { describe, expect, it } from "vitest";
import { meetsThreshold } from "../src/core/severity.js";
import type { Finding } from "../src/core/types.js";

const finding = (severity: Finding["severity"]): Finding => ({
  id: `id-${severity}`,
  title: "title",
  severity,
  category: "unknown",
  file: ".github/workflows/test.yml",
  evidence: [],
});

describe("meetsThreshold", () => {
  it("returns false for none", () => {
    expect(meetsThreshold([finding("critical")], "none")).toBe(false);
  });

  it("returns true when a finding meets threshold", () => {
    expect(meetsThreshold([finding("high")], "medium")).toBe(true);
  });
});
