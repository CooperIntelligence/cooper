import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileTool, writeFileTool } from "../src/tools/fs.js";
import { runCommandTool } from "../src/tools/shell.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cooper-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("write_file", () => {
  it("creates parent directories and writes content", async () => {
    const result = await writeFileTool.execute(
      { path: "src/hello.txt", content: "hi" },
      { root },
    );
    expect(result.content).toMatch(/^Created src\/hello\.txt/);
    await expect(
      fs.readFile(path.join(root, "src", "hello.txt"), "utf8"),
    ).resolves.toBe("hi");
  });

  it("overwrites an existing file", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "old", "utf8");
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new" },
      { root },
    );
    expect(result.content).toMatch(/^Updated a\.txt/);
    await expect(fs.readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe(
      "new",
    );
  });

  it("rejects paths outside the workspace", async () => {
    await expect(
      writeFileTool.execute({ path: "../escape.txt", content: "x" }, { root }),
    ).rejects.toThrow(/outside the workspace/);
  });
});

describe("edit_file", () => {
  it("replaces a unique occurrence", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hello world", "utf8");
    const result = await editFileTool.execute(
      { path: "a.txt", old_string: "world", new_string: "cooper" },
      { root },
    );
    expect(result.content).toContain("Replaced 1");
    await expect(fs.readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe(
      "hello cooper",
    );
  });

  it("refuses ambiguous edits unless replace_all is set", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "foo foo", "utf8");
    await expect(
      editFileTool.execute(
        { path: "a.txt", old_string: "foo", new_string: "bar" },
        { root },
      ),
    ).rejects.toThrow(/2 times/);

    await editFileTool.execute(
      {
        path: "a.txt",
        old_string: "foo",
        new_string: "bar",
        replace_all: true,
      },
      { root },
    );
    await expect(fs.readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe(
      "bar bar",
    );
  });

  it("fails when the old string is missing", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "abc", "utf8");
    await expect(
      editFileTool.execute(
        { path: "a.txt", old_string: "zzz", new_string: "y" },
        { root },
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe("run_command", () => {
  it("returns output and the exit code", async () => {
    const result = await runCommandTool.execute(
      { command: "echo hello", timeout_ms: 10_000 },
      { root },
    );
    expect(result.content).toContain("hello");
    expect(result.content).toContain("exit code: 0");
    expect(result.isError).toBeFalsy();
  });

  it("marks non-zero exits as errors", async () => {
    const result = await runCommandTool.execute(
      { command: 'node -e "process.exit(3)"', timeout_ms: 10_000 },
      { root },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exit code: 3");
  });

  it("rejects working directories outside the workspace", async () => {
    await expect(
      runCommandTool.execute({ command: "echo x", cwd: ".." }, { root }),
    ).rejects.toThrow(/outside the workspace/);
  });
});
