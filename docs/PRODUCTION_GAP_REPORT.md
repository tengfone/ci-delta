# Production Gap Report

## Current package manager

- The repository uses **npm** (detected via `package-lock.json` and successful `npm install`).

## Current scripts

From `package.json`:

- `build`: `tsup src/index.ts src/cli.ts src/action.ts --format esm --dts --out-dir dist --clean`
- `test`: `vitest run`
- `test:watch`: `vitest`
- `lint`: `tsc --noEmit`

Notably missing compared to the hardening plan:

- `typecheck`
- `format`
- `format:check`
- `prepack`

## Current architecture

Current repository structure indicates an early scaffold:

- TypeScript project with `src/` and `test/`
- CLI entrypoint (`src/cli.ts`, `src/cli/index.ts`)
- Action entrypoint stubs (`src/action.ts`, `src/action/index.ts`)
- Core types (`src/core/types.ts`, `src/core/severity.ts`, `src/core/report.ts`)
- Local git file source (`src/file-sources/local-git.ts`)
- Reporters (`src/reporters/markdown.ts`, `src/reporters/json.ts`)
- Action metadata (`action.yml`)

No production docs folder existed before this milestone, and no production schema/config/rule docs exist yet.

## Passing checks

Commands executed and outcomes:

- `npm install` ✅ passed
- `npm test` ✅ passed (2 test files, 3 tests)
- `npm run build` ✅ passed

## Failing checks

Commands executed and outcomes:

- `npm run typecheck` ❌ failed because script is missing from `package.json`
- `npm run lint` ❌ failed with TypeScript rootDir/include mismatch:
  - `test/*.ts` included in project
  - `compilerOptions.rootDir` set to `src`
  - causes TS6059 errors for test files outside `rootDir`

## Missing production pieces

Relative to the production-ready definition and milestone sequence, key gaps include:

- Script completeness (`typecheck`, formatting, `prepack`)
- CI workflow coverage for install/lint/format/typecheck/test/build
- Stable domain model and schema validation (`schemaVersion`, Zod schemas)
- Parser fixture suite for GitHub Actions workflow forms and invalid YAML handling
- Deterministic semantic diff engine and rule engine coverage
- Rule documentation and stable rule IDs
- Config file parsing/validation and docs
- GitHub API file source for safe PR analysis without checkout
- Sticky PR comment implementation in Action wrapper
- Golden fixtures for risk scenarios
- OSS hygiene files (SECURITY, CONTRIBUTING, templates, Dependabot, CodeQL, release workflow)
- Release process hardening and pack/install verification from tarball

## Risky assumptions

Current risks/assumptions observed in the scaffold state:

- `lint` currently doubles as `typecheck`; script naming is unclear and mismatched with required checks.
- TypeScript config assumes a single `rootDir: src` while tests are compiled in the same program, causing CI brittleness.
- Action wrapper appears stubbed; safety guarantees (no checkout, no PR code execution) are not yet proven.
- No explicit JSON schema versioning/tests found, so downstream API stability is not guaranteed yet.
- No evidence yet of deterministic rule evidence enforcement (`id`, `severity`, `confidence`, evidence completeness).

## Recommended next milestone

Proceed to **Milestone 1 — Stabilize project foundation**:

1. Add/normalize required scripts (`typecheck`, `format`, `format:check`, `prepack`).
2. Fix TS project layout so lint/typecheck pass cleanly with tests.
3. Add CI workflow for push/PR covering install, lint, format check, typecheck, test, build.
4. Re-run all baseline checks to establish a reliable foundation before semantic/diff work.
