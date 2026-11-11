import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  editFileTool,
  grepTool,
  listDirTool,
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

describe("workspace path containment", () => {
  const linkType = process.platform === "win32" ? "junction" : "dir";

  it("blocks outside links for reads, previews, writes, and command cwd", async () => {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside fixture");
    await fs.symlink(outside, path.join(workspace, "escape"), linkType);
    const ctx = { root: workspace };
    const file = "escape/secret.txt";
    const write = { path: file, content: "changed" };
    const edit = { path: file, old_string: "fixture", new_string: "changed" };

    await expect(listDirTool.execute({ path: "escape" }, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(readFileTool.execute({ path: file }, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(grepTool.execute({ path: "escape", pattern: "fixture" }, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(grepTool.execute({ pattern: "outside fixture" }, ctx)).resolves.toMatchObject({
      content: expect.stringMatching(/^No matches/),
    });
    await expect(writeFileTool.preview?.(write, ctx)).resolves.toBeUndefined();
    await expect(editFileTool.preview?.(edit, ctx)).resolves.toBeUndefined();
    await expect(writeFileTool.execute(write, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(editFileTool.execute(edit, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(writeFileTool.execute({ path: "escape/new/file.txt", content: "new" }, ctx))
      .rejects.toThrow(/outside the workspace/);
    await expect(runCommandTool.execute({ cwd: "escape", command: "echo x" }, ctx))
      .rejects.toThrow(/outside the workspace/);
    expect(await fs.readdir(outside)).toEqual(["secret.txt"]);
    expect(await fs.readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside fixture");
  });

  it("supports existing and new files through an internal link", async () => {
    const target = path.join(root, "target");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(root, "alias"), linkType);
    const ctx = { root };
    const file = "alias/new/file.txt";
    await writeFileTool.execute({ path: file, content: "inside fixture" }, ctx);
    await expect(readFileTool.execute({ path: file }, ctx)).resolves.toMatchObject({
      content: "1 | inside fixture",
    });
    await expect(grepTool.execute({ path: "alias", pattern: "fixture" }, ctx))
      .resolves.toMatchObject({ content: "alias/new/file.txt:1: inside fixture" });
  });

  it("refuses to create files through a dangling link", async () => {
    const workspace = path.join(root, "workspace");
    const missing = path.join(root, "missing");
    await fs.mkdir(workspace);
    await fs.symlink(missing, path.join(workspace, "dangling"), linkType);
    await expect(
      writeFileTool.execute({ path: "dangling/new.txt", content: "new" }, { root: workspace }),
    ).rejects.toThrow(/dangling link/);
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
