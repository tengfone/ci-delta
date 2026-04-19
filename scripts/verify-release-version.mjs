#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJsonPath = path.join(projectRoot, "package.json");
const tagName = process.argv[2] ?? process.env.GITHUB_REF_NAME;

function fail(message) {
  console.error(`verify-release-version: ${message}`);
  process.exit(1);
}

if (!tagName) {
  fail("expected a release tag argument or GITHUB_REF_NAME.");
}

if (!/^v\d+\.\d+\.\d+$/.test(tagName)) {
  fail(`expected a stable semver tag like v1.2.3, got ${tagName}.`);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const expectedTag = `v${packageJson.version}`;

if (tagName !== expectedTag) {
  fail(
    `release tag ${tagName} does not match package.json version ${packageJson.version}.`,
  );
}

console.log(`Verified release tag ${tagName} matches package version.`);
