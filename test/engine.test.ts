import { describe, expect, it } from "vitest";
import { changedFilePaths } from "../src/core/engine.js";
import type { FileSnapshot } from "../src/core/types.js";

const file = (path: string, content: string, sha?: string): FileSnapshot => ({
  path,
  content,
  sha,
});

describe("changedFilePaths", () => {
  it("returns no paths when base and head files match", () => {
    expect(
      changedFilePaths(
        [file(".github/workflows/ci.yml", "name: CI\n")],
        [file(".github/workflows/ci.yml", "name: CI\n")],
      ),
    ).toEqual([]);
  });

  it("returns added, removed, and modified workflow paths", () => {
    expect(
      changedFilePaths(
        [
          file(".github/workflows/removed.yml", "name: Removed\n"),
          file(".github/workflows/changed.yml", "name: Old\n"),
        ],
        [
          file(".github/workflows/added.yml", "name: Added\n"),
          file(".github/workflows/changed.yml", "name: New\n"),
        ],
      ),
    ).toEqual([
      ".github/workflows/added.yml",
      ".github/workflows/changed.yml",
      ".github/workflows/removed.yml",
    ]);
  });
});
