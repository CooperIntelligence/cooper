import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/mcp/config.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeConfig(file: string, servers: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), "utf8");
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const stdio = (command: string) => ({ command, args: ["--test"] });

describe("loadMcpConfig", () => {
  it("loads the user config and ignores project config by default", () => {
    const home = tempDir("cooper-mcp-home-");
    const root = tempDir("cooper-mcp-root-");
    const userFile = path.join(home, "mcp.json");
    const projectFile = path.join(root, ".cooper", "mcp.json");
    writeConfig(userFile, { user: stdio("user-cmd") });
    writeConfig(projectFile, { project: stdio("project-cmd") });

    const loaded = loadMcpConfig({ root, home });

    expect(Object.keys(loaded.servers)).toEqual(["user"]);
    expect(loaded.sources).toEqual([userFile]);
    expect(loaded.warnings.join("\n")).toContain("--mcp-project");
  });

  it("loads project config only with an explicit opt-in", () => {
    const home = tempDir("cooper-mcp-home-");
    const root = tempDir("cooper-mcp-root-");
    writeConfig(path.join(home, "mcp.json"), {
      user: stdio("user-cmd"),
    });
    writeConfig(path.join(root, ".cooper", "mcp.json"), {
      project: stdio("project-cmd"),
    });

    const loaded = loadMcpConfig({ root, home, loadProject: true });

    expect(Object.keys(loaded.servers).sort()).toEqual(["project", "user"]);
    expect(loaded.sources).toHaveLength(2);
    expect(loaded.warnings).toEqual([]);
  });

  it("lets an explicit config override a user server and resolves cwd", () => {
    const home = tempDir("cooper-mcp-home-");
    const root = tempDir("cooper-mcp-root-");
    writeConfig(path.join(home, "mcp.json"), {
      shared: stdio("user-cmd"),
    });
    const explicit = path.join(root, "custom", "mcp.json");
    writeConfig(explicit, {
      shared: { command: "explicit-cmd", args: [], cwd: "work" },
    });

    const loaded = loadMcpConfig({
      root,
      home,
      explicit: [explicit],
    });

    expect(loaded.servers["shared"]).toMatchObject({
      type: "stdio",
      command: "explicit-cmd",
      cwd: path.resolve(root, "custom", "work"),
    });
  });

  it("parses http and sse servers", () => {
    const home = tempDir("cooper-mcp-home-");
    const root = tempDir("cooper-mcp-root-");
    writeConfig(path.join(home, "mcp.json"), {
      remote: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer token" },
      },
      legacy: { type: "sse", url: "https://example.com/sse" },
    });

    const loaded = loadMcpConfig({ root, home });

    expect(loaded.servers["remote"]).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });
    expect(loaded.servers["legacy"]).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      headers: {},
    });
  });

  it("warns about invalid entries instead of starting a bad server", () => {
    const home = tempDir("cooper-mcp-home-");
    const root = tempDir("cooper-mcp-root-");
    writeConfig(path.join(home, "mcp.json"), {
      "bad name": stdio("cmd"),
      missing: { type: "stdio", args: [] },
      unknown: { type: "carrier-pigeon", url: "https://example.com" },
      wrongUrl: { type: "http", url: "not a url" },
    });

    const loaded = loadMcpConfig({ root, home });

    expect(loaded.servers).toEqual({});
    expect(loaded.warnings).toHaveLength(4);
  });

  it("resolves the user config under COOPER_HOME by default", () => {
    const home = tempDir("cooper-mcp-home-");
    const root = tempDir("cooper-mcp-root-");
    writeConfig(path.join(home, "mcp.json"), { user: stdio("user-cmd") });

    const previous = process.env.COOPER_HOME;
    process.env.COOPER_HOME = home;
    try {
      const loaded = loadMcpConfig({ root });
      expect(Object.keys(loaded.servers)).toEqual(["user"]);
      expect(loaded.sources).toEqual([path.join(home, "mcp.json")]);
    } finally {
      if (previous === undefined) {
        delete process.env.COOPER_HOME;
      } else {
        process.env.COOPER_HOME = previous;
      }
    }
  });

  it("rejects invalid JSON and missing explicit files", () => {
    const home = tempDir("cooper-mcp-home-");
    const root = tempDir("cooper-mcp-root-");
    const file = path.join(home, "mcp.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ nope", "utf8");

    expect(() => loadMcpConfig({ root, home })).toThrow(/Invalid JSON/);
    expect(() =>
      loadMcpConfig({
        root,
        home: tempDir("cooper-mcp-empty-"),
        explicit: [path.join(root, "missing.json")],
      }),
    ).toThrow(/MCP config not found/);
  });
});
