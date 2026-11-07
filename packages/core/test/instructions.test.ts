import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectInstructions } from "../src/instructions.js";

let base: string;
let root: string;
let home: string;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "cooper-instructions-"));
  root = path.join(base, "project");
  home = path.join(base, "home");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(home, { recursive: true });
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe("loadProjectInstructions", () => {
  it("returns nothing when no instruction files exist", async () => {
    const loaded = await loadProjectInstructions(root, { home });
    expect(loaded).toEqual({ text: "", sources: [] });
  });

  it("loads AGENTS.md from the workspace root", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "Use tabs.\n", "utf8");

    const loaded = await loadProjectInstructions(root, { home });

    expect(loaded.text).toContain("Use tabs.");
    expect(loaded.text).toContain(path.join(root, "AGENTS.md"));
    expect(loaded.sources).toEqual([
      { path: path.join(root, "AGENTS.md"), chars: 9, truncated: false },
    ]);
  });

  it("prefers COOPER.md over AGENTS.md", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "generic", "utf8");
    await fs.writeFile(path.join(root, "COOPER.md"), "specific", "utf8");

    const loaded = await loadProjectInstructions(root, { home });

    expect(loaded.sources).toHaveLength(1);
    expect(loaded.text).toContain("specific");
    expect(loaded.text).not.toContain("generic");
  });

  it("puts user preferences before and project rules after", async () => {
    await fs.mkdir(path.join(home, ".cooper"));
    await fs.writeFile(
      path.join(home, ".cooper", "AGENTS.md"),
      "global preference",
      "utf8",
    );
    await fs.writeFile(path.join(root, "AGENTS.md"), "project rule", "utf8");

    const loaded = await loadProjectInstructions(root, { home });

    expect(loaded.sources).toHaveLength(2);
    expect(loaded.text.indexOf("global preference")).toBeLessThan(
      loaded.text.indexOf("project rule"),
    );
  });

  it("truncates oversized instructions instead of eating the budget", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(5000), "utf8");

    const loaded = await loadProjectInstructions(root, {
      home,
      maxChars: 200,
    });

    expect(loaded.sources[0]?.truncated).toBe(true);
    expect(loaded.sources[0]?.chars).toBe(5000);
    expect(loaded.text).toContain("[truncated to fit the instructions budget]");
    expect(loaded.text.length).toBeLessThan(400);
  });

  it("ignores a directory that happens to share the name", async () => {
    await fs.mkdir(path.join(root, "AGENTS.md"));
    const loaded = await loadProjectInstructions(root, { home });
    expect(loaded.sources).toEqual([]);
  });
});
