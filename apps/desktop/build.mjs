import { copyFile } from "node:fs/promises";
import { build } from "esbuild";

await Promise.all([
  build({
    entryPoints: { main: "src/main.ts", preload: "src/preload.ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
  }),
  build({
    entryPoints: ["src/renderer.ts"],
    bundle: true,
    format: "iife",
    target: "chrome156",
    outfile: "dist/renderer.js",
  }),
]);
await Promise.all(["index.html", "styles.css"].map((name) => copyFile("src/" + name, "dist/" + name)));
