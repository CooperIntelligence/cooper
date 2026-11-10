import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";

/**
 * Bundles the CLI into a single ESM file for local packaging.
 *
 * Two known hazards, both handled here:
 * - ink's react-devtools-core import is DEV-only but esbuild still emits it;
 *   alias to a stub.
 * - Several deps (signal-exit, …) call require() at runtime. ESM output
 *   normally throws "Dynamic require is not supported"; a createRequire
 *   banner defines `require` before esbuild's __require helper runs, so
 *   the helper picks it up (it checks typeof require !== "undefined").
 */
await mkdir("dist", { recursive: true });

const outfile = "dist/cooper.mjs";
const result = await build({
  entryPoints: ["apps/cli/src/index.tsx"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  jsx: "automatic",
  outfile,
  alias: {
    "react-devtools-core": "./scripts/stub-react-devtools.mjs",
  },
  banner: {
    js: [
      'import { createRequire as __coopCreateRequire } from "node:module";',
      "const require = __coopCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Entry (index.tsx) already starts with #!/usr/bin/env node; esbuild keeps
  // it as line 1. Do not add a second banner shebang.
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundle: ${outfile} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
await chmod(outfile, 0o755);
