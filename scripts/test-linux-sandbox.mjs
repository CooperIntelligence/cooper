import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createRunCommandTool, resolveCommandShell } from "../packages/core/src/index.js";
import { linuxWorkspaceNetwork, localShellSandbox } from "../packages/host/src/index.js";

assert.equal(process.platform, "linux", "This check requires the Linux kernel");
const runtime = process.argv[2];
assert.ok(runtime, "Pass the directory containing the Linux sandbox helper.");
const sandbox = localShellSandbox(runtime);
assert.ok(sandbox, "The Linux sandbox helper must be executable.");

const directory = await mkdtemp(path.join(os.tmpdir(), "cooper-linux-test-"));
const root = path.join(directory, "workspace");
const outsideDirectory = await mkdtemp(path.join(os.tmpdir(), "cooper-linux-outside-"));
const outside = path.join(outsideDirectory, "sentinel");
const shellTool = createRunCommandTool(resolveCommandShell({ kind: "bash" }));
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const exists = async (file) => access(file).then(() => true, () => false);

async function execute(command, options = {}) {
  return shellTool.execute(
    { command, description: "Test Linux sandbox policy", timeout_ms: options.timeout ?? 30000 },
    { root, requireShellSandbox: true, shellSandbox: sandbox, shellNetwork: options.network, signal: options.signal },
  );
}

async function allow(command, options) {
  const result = await execute(command, options);
  assert.equal(result.isError, false, result.content);
  return result.content;
}

try {
  await mkdir(root);
  await writeFile(outside, "outside");
  await writeFile(path.join(root, ".env"), "test-marker");
  await symlink(outside, path.join(root, "external-link"));
  const alias = path.join(directory, "workspace-alias");
  await symlink(root, alias);
  assert.equal(linuxWorkspaceNetwork(root), false);
  assert.equal(linuxWorkspaceNetwork(root, [directory]), false);
  assert.equal(linuxWorkspaceNetwork(root, [root]), true);
  assert.equal(linuxWorkspaceNetwork(alias, [root]), true);
  assert.equal(linuxWorkspaceNetwork(root, [alias]), false);

  await allow("set -e; mkdir -p build/server; printf '%s\\n' \"it's working\" > build/server/check; touch \"$HOME/cache-probe\"");
  assert.match(await allow("node --version"), /v\d+\.\d+/);
  assert.equal(await readFile(path.join(root, "build/server/check"), "utf8"), "it's working\n");
  const denied = await execute("printf changed > " + quote(outside));
  assert.equal(denied.isError, true, denied.content);
  assert.equal((await execute("printf changed > external-link")).isError, true);
  assert.equal(await readFile(outside, "utf8"), "outside");
  const secret = await execute("cat .env");
  assert.ok(!secret.content.includes("test-marker"), secret.content);
  console.log("Offline workspace, private temp, protected file and outside writes verified.");

  const controller = new AbortController();
  const running = execute("(sleep 3; touch leaked) & touch started; wait", { signal: controller.signal });
  try {
    for (let attempt = 0; attempt < 100 && !await exists(path.join(root, "started")); attempt++) {
      await wait(20);
    }
    assert.ok(await exists(path.join(root, "started")), "The background process was not started.");
  } finally {
    controller.abort();
    assert.match((await running).content, /cancelled/i);
  }
  await wait(3200);
  assert.equal(await exists(path.join(root, "leaked")), false);
  console.log("Cancellation reaped background descendants.");

  const networkProbe = "node -e " + quote("fetch('https://registry.npmjs.org/is-number',{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)process.exitCode=1},()=>process.exitCode=1)");
  assert.equal((await execute(networkProbe)).isError, true, "Default namespace reached the public internet");
  console.log("Default shell network blocked.");
  if (process.argv.includes("--online")) {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "cooper-linux-test", private: true, dependencies: { "is-number": "7.0.0" },
    }));
    assert.equal((await execute("printf changed > " + quote(outside), { network: true })).isError, true);
    await allow("npm install --ignore-scripts --no-fund --no-audit --fetch-retries=0 --fetch-timeout=12000", { network: true });
    assert.ok(await exists(path.join(root, "node_modules/is-number/package.json")));
    assert.equal(await readFile(outside, "utf8"), "outside");
    console.log("Outbound grant installed a real npm dependency with the filesystem boundary intact.");
  }
  if (process.argv.includes("--next")) {
    await Promise.all([unlink(path.join(root, "external-link")), unlink(path.join(root, ".env"))]);
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "cooper-linux-next-test", private: true, scripts: { build: "next build" },
      dependencies: { next: "15.5.29", react: "19.1.0", "react-dom": "19.1.0" },
    }));
    await mkdir(path.join(root, "app/contact"), { recursive: true });
    await writeFile(path.join(root, "app/layout.jsx"), "export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n");
    await writeFile(path.join(root, "app/contact/page.jsx"), "export default function Page() { return <h1>Contact</h1>; }\n");
    await writeFile(path.join(root, "next.config.mjs"), "export default { experimental: { cpus: 2 } };\n");
    // Prepare the fixture outside confinement. The separate --online case
    // verifies package downloads inside the sandbox.
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=2"], {
      cwd: root,
      stdio: "inherit",
      timeout: 150000,
    });
    await allow("NEXT_TELEMETRY_DISABLED=1 npm run build", { timeout: 120000 });
    assert.ok(await exists(path.join(root, ".next/server/app/contact/page.js")));
    await allow("NEXT_TELEMETRY_DISABLED=1 npm run build", { timeout: 120000 });
    console.log("Next.js 15.5.29 built twice in the offline sandbox.");
  }
} finally {
  await Promise.all([directory, outsideDirectory].map((entry) => rm(entry, { recursive: true, force: true })));
}
