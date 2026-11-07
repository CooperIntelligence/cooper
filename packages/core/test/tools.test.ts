import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  editFileTool,
  readFileTool,
  writeFileTool,
} from "../src/tools/fs.js";
import { runCommandTool } from "../src/tools/shell.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cooper-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("caps a single line that would otherwise blow the context window", async () => {
    await fs.writeFile(path.join(root, "minified.js"), "x".repeat(200_000), "utf8");

    const result = await readFileTool.execute({ path: "minified.js" }, { root });

    expect(result.content.length).toBeLessThan(48_100);
    expect(result.content).toContain("output capped at 48000 characters");
  });
});

describe("tool previews", () => {
  it("write_file previews a new file as an empty baseline", async () => {
    const preview = await writeFileTool.preview?.(
      { path: "new.txt", content: "hello\n" },
      { root },
    );
    expect(preview).toEqual({
      kind: "diff",
      path: "new.txt",
      before: "",
      after: "hello\n",
    });
  });

  it("write_file previews the existing content as the baseline", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "old\n", "utf8");
    const preview = await writeFileTool.preview?.(
      { path: "a.txt", content: "new\n" },
      { root },
    );
    expect(preview?.kind === "diff" ? preview.before : "").toBe("old\n");
  });

  it("edit_file previews the applied replacement", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "one two two\n", "utf8");

    const single = await editFileTool.preview?.(
      { path: "a.txt", old_string: "one", new_string: "1" },
      { root },
    );
    expect(single?.kind === "diff" ? single.after : "").toBe("1 two two\n");

    const all = await editFileTool.preview?.(
      { path: "a.txt", old_string: "two", new_string: "2", replace_all: true },
      { root },
    );
    expect(all?.kind === "diff" ? all.after : "").toBe("one 2 2\n");
  });

  it("edit_file preview keeps $ sequences in the replacement literal", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "price\n", "utf8");
    const preview = await editFileTool.preview?.(
      { path: "a.txt", old_string: "price", new_string: "$& and $1" },
      { root },
    );
    expect(preview?.kind === "diff" ? preview.after : "").toBe("$& and $1\n");
  });

  it("skips the preview when the edit itself would fail", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "x\n", "utf8");
    const missing = await editFileTool.preview?.(
      { path: "a.txt", old_string: "nope", new_string: "y" },
      { root },
    );
    expect(missing).toBeUndefined();
  });
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
