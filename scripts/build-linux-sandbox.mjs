import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("Build the Linux sandbox on Linux.");
const manifest = fileURLToPath(new URL("../packages/shell-sandbox/Cargo.toml", import.meta.url));
const target = fileURLToPath(new URL("../packages/shell-sandbox/target", import.meta.url));
execFileSync("cargo", ["build", "--locked", "--release", "--manifest-path", manifest, "--target-dir", target], {
  stdio: "inherit",
});
const name = "cooper-shell-sandbox";
const source = new URL(`../packages/shell-sandbox/target/release/${name}`, import.meta.url);
for (const output of [
  new URL(`../apps/cli/dist/sandbox/linux-${process.arch}/`, import.meta.url),
  new URL("../apps/desktop/dist/", import.meta.url),
]) {
  await mkdir(output, { recursive: true });
  const destination = new URL(name, output);
  await copyFile(source, destination);
  await chmod(destination, 0o755);
}
