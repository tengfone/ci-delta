import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/action.ts"],
  format: ["esm"],
  dts: true,
  outDir: "dist",
  clean: true,
  splitting: false,
  platform: "node",
  target: "node20",
  noExternal: ["commander", "fast-glob", "minimatch", "yaml"],
  banner: {
    js: 'import { createRequire as __ciDeltaCreateRequire } from "node:module"; const require = __ciDeltaCreateRequire(import.meta.url);',
  },
});
