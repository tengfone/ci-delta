#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const tempRoot = await mkdtemp(path.join(tmpdir(), "ci-delta-package-"));
const packDir = path.join(tempRoot, "pack");
const installDir = path.join(tempRoot, "install");
const npmCacheDir = path.join(tempRoot, "npm-cache");

function fail(message) {
  console.error(`verify-npm-package: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: npmCacheDir,
      npm_config_fund: "false",
      ...options.env,
    },
  });

  if (result.status !== 0) {
    fail(
      [
        `${command} ${args.join(" ")} failed with exit ${result.status}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

try {
  await mkdir(packDir);
  await mkdir(installDir);
  await writeFile(
    path.join(installDir, "package.json"),
    JSON.stringify({ private: true, type: "module" }, null, 2),
    "utf8",
  );

  const packOutput = run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDir,
  ]);
  const [packed] = JSON.parse(packOutput);
  if (!packed?.filename) {
    fail(`npm pack did not report a tarball filename: ${packOutput}`);
  }

  const tarballPath = path.join(packDir, packed.filename);
  await access(tarballPath);

  run("npm", ["install", "--ignore-scripts", tarballPath], {
    cwd: installDir,
  });

  const binPath = path.join(
    installDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "ci-delta.cmd" : "ci-delta",
  );
  const helpOutput = run(binPath, ["--help"], { cwd: installDir });
  if (!helpOutput.includes("Semantic diff reports for CI/CD config changes")) {
    fail(`CLI help output did not include the package description.`);
  }

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const mod = await import('ci-delta'); if (typeof mod.compareSources !== 'function') throw new Error('missing compareSources export');",
    ],
    { cwd: installDir },
  );

  console.log(
    `Verified npm package install and CLI entrypoint: ${packed.name}`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
