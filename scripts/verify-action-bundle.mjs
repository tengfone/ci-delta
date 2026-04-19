#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const projectRoot = new URL("../", import.meta.url);
const actionMetadataUrl = new URL("action.yml", projectRoot);
const actionBundleUrl = new URL("dist/action.js", projectRoot);

const nodeBuiltinSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function fail(message) {
  console.error(`verify-action-bundle: ${message}`);
  process.exit(1);
}

function readMetadataValue(metadata, key) {
  const match = metadata.match(
    new RegExp(`^\\s*${key}:\\s*["']?([^"'\\s]+)["']?\\s*$`, "m"),
  );
  return match?.[1];
}

function findBareImports(source) {
  const bareImports = new Set();
  const importPattern =
    /^\s*import(?:\s+[^"']+\s+from\s+|\s*)["']([^"']+)["'];?/gm;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      nodeBuiltinSpecifiers.has(specifier)
    ) {
      continue;
    }
    bareImports.add(specifier);
  }

  return [...bareImports].sort();
}

const metadata = await readFile(actionMetadataUrl, "utf8");
const runtime = readMetadataValue(metadata, "using");
if (runtime !== "node24") {
  fail(`action.yml must use node24, found ${runtime ?? "missing runtime"}.`);
}

const main = readMetadataValue(metadata, "main");
if (main !== "dist/action.js") {
  fail(
    `action.yml must point at dist/action.js, found ${main ?? "missing main"}.`,
  );
}

await access(new URL(main, projectRoot));

const bundle = await readFile(actionBundleUrl, "utf8");
const bareImports = findBareImports(bundle);
if (bareImports.length > 0) {
  fail(`dist/action.js has unbundled imports: ${bareImports.join(", ")}`);
}

await import(actionBundleUrl.href);

const actionResult = spawnSync(
  process.execPath,
  [fileURLToPath(actionBundleUrl)],
  {
    encoding: "utf8",
    env: {},
  },
);
if (
  actionResult.status !== 2 ||
  !actionResult.stderr.includes("Missing github-token input")
) {
  fail(
    [
      "dist/action.js did not reach the expected configuration error.",
      `exit=${actionResult.status}`,
      `stdout=${actionResult.stdout.trim()}`,
      `stderr=${actionResult.stderr.trim()}`,
    ].join("\n"),
  );
}

console.log(
  "Verified action.yml runtime and standalone dist/action.js bundle.",
);
