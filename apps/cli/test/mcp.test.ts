import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareTools } from "../src/mcp.js";

const dirs: string[] = [];
const originalHome = process.env.COOPER_HOME;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeConfig(file: string, servers: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), "utf8");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.COOPER_HOME;
  } else {
    process.env.COOPER_HOME = originalHome;
  }
});

describe("prepareTools", () => {
  it("returns only built-in tools when no config exists", async () => {
    const home = tempDir("cooper-cli-home-");
    const root = tempDir("cooper-cli-root-");
    process.env.COOPER_HOME = home;

    const prepared = await prepareTools({
      root,
      explicit: [],
      loadProject: false,
    });
    try {
      expect(prepared.tools.some((tool) => tool.name === "read_file")).toBe(
        true,
      );
      expect(prepared.mcp.statuses).toEqual([]);
      expect(prepared.mcp.warnings).toEqual([]);
    } finally {
      await prepared.close();
    }
  });

  it("does not load a project config without --mcp-project", async () => {
    const home = tempDir("cooper-cli-home-");
    const root = tempDir("cooper-cli-root-");
    process.env.COOPER_HOME = home;
    writeConfig(path.join(root, ".cooper", "mcp.json"), {
      project: { command: "should-not-run" },
    });

    const prepared = await prepareTools({
      root,
      explicit: [],
      loadProject: false,
    });
    try {
      expect(prepared.mcp.warnings.join("\n")).toContain("--mcp-project");
      expect(prepared.mcp.statuses).toEqual([]);
      expect(prepared.tools.some((tool) => tool.name === "read_file")).toBe(
        true,
      );
    } finally {
      await prepared.close();
    }
  });

  it("fails on a missing explicit config", async () => {
    const home = tempDir("cooper-cli-home-");
    const root = tempDir("cooper-cli-root-");
    process.env.COOPER_HOME = home;

    await expect(
      prepareTools({
        root,
        explicit: [path.join(root, "missing.json")],
        loadProject: false,
      }),
    ).rejects.toThrow(/MCP config not found/);
  });
});
