import { spawnSync } from "node:child_process";
import { chmod, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "postject";

/**
 * Full SEA packaging pipeline:
 *   esbuild bundle -> sea-config blob -> copy node -> postject inject
 *
 * sea-config.json must set "mainFormat": "module": without it Node runs
 * the ESM bundle as CommonJS and dies with "Cannot use import statement
 * outside a module".
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const exeName = isWin ? "cooper.exe" : "cooper";
const exePath = path.join(root, "dist", exeName);
const blobPath = path.join(root, "dist", "cooper.blob");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function run(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`package: ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

run("bundle", ["scripts/build.mjs"]);
run("sea-config", ["--experimental-sea-config", "scripts/sea-config.json"]);

await copyFile(process.execPath, exePath);
const blob = await readFile(blobPath);
await inject(exePath, "NODE_SEA_BLOB", blob, { sentinelFuse });
await chmod(exePath, 0o755);

console.log(`package: ${path.relative(root, exePath)} ready`);
