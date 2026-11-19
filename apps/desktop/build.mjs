import { copyFile, mkdir } from "node:fs/promises";
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
await mkdir("dist/assets", { recursive: true });
const images = ["cooper-code-logo.png", "cooper-icon-192.png", "cooper-icon-512.png"];
await Promise.all([
  copyFile("src/index.html", "dist/index.html"),
  copyFile("src/styles.css", "dist/styles.css"),
  ...images.map((name) => copyFile("src/assets/" + name, "dist/assets/" + name)),
]);
