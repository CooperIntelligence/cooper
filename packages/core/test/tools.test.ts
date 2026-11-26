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
import { createRunCommandTool, resolveCommandShell, runCommandTool } from "../src/tools/shell.js";
import { toToolSpec } from "../src/tools/tool.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cooper-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("uses a 400-line default page and allows an explicit larger range", async () => {
    const pathInRoot = "lines.txt";
    const lines = Array.from({ length: 801 }, (_, index) => `text ${index + 1}`);
    await fs.writeFile(path.join(root, pathInRoot), lines.join("\n"));

    const first = await readFileTool.execute({ path: pathInRoot }, { root });
    const second = await readFileTool.execute({ path: pathInRoot, offset: 400 }, { root });
    const wide = await readFileTool.execute({ path: pathInRoot, limit: 500 }, { root });

    expect(first.content).toContain("400 | text 400\n\n[Showing lines 1-400. Use offset=400");
    expect(second.content).toMatch(/^401 \| text 401\n/);
    expect(second.content).toContain("800 | text 800\n\n[Showing lines 401-800. Use offset=800");
    expect(wide.content).toContain("500 | text 500\n\n[Showing lines 1-500. Use offset=500");
  });

  it("leaves an otherwise complete line for the next page when the page is full", async () => {
    const pathInRoot = "wide.txt";
    const firstLine = "a".repeat(30_000);
    const secondLine = "b".repeat(24_000);
    await fs.writeFile(path.join(root, pathInRoot), `${firstLine}\n${secondLine}\nlast`);

    const first = await readFileTool.execute({ path: pathInRoot }, { root });
    const second = await readFileTool.execute({ path: pathInRoot, offset: 1 }, { root });

    expect(first.content).toBe(
      `1 | ${firstLine}\n\n[Output capped at 48000 characters. Showing lines 1-1. Use offset=1 to continue.]`,
    );
    expect(second.content).toBe(`2 | ${secondLine}\n3 | last`);
  });

  it("resumes a long line in a file over 2 MiB at the reported code point", async () => {
    const pathInRoot = "minified.js";
    const prefix = `x${"😀".repeat(23_997)}`;
    // The output budget lands between the surrogate halves of the apple.
    const longLine = `${prefix}🍎${"😀".repeat(1_100_000)}`;
    await fs.writeFile(path.join(root, pathInRoot), `${longLine}\r\nnext`);

    const result = await readFileTool.execute({ path: pathInRoot }, { root });
    const continuation = result.content.match(/offset=0, limit=1, column_offset=(\d+)/);
    const continued = await readFileTool.execute(readFileTool.inputSchema.parse({
      path: pathInRoot, offset: 0, limit: 1, column_offset: Number(continuation?.[1]),
    }), { root });
    const next = await readFileTool.execute({ path: pathInRoot, offset: 1 }, { root });

    expect(result.content).toBe(
      `1 | ${prefix}\n\n[Line 1 was truncated at the 48000-character output limit. ` +
        "Continue this line with offset=0, limit=1, column_offset=23998. " +
        "To skip to the next line, use offset=1 and omit column_offset.]",
    );
    expect(continued.content).toMatch(/^1 \| 🍎😀/u);
    expect(continued.content).toContain("column_offset=47996");
    expect(next.content).toBe("2 | next");
  });

  it.each([undefined, 2])("rejects a column offset when limit is %s", (limit) => {
    expect(readFileTool.inputSchema.safeParse({
      path: "lines.txt", limit, column_offset: 0,
    }).error?.issues).toMatchObject([{ path: ["column_offset"], message: "column_offset requires limit: 1." }]);
  });

  it("excludes a CRLF split across stream chunks from column offsets", async () => {
    const pathInRoot = "columns.txt";
    await fs.writeFile(path.join(root, pathInRoot), `${"x".repeat(65_535)}\r\nnext`);
    const result = await readFileTool.execute({
      path: pathInRoot, limit: 1, column_offset: 65_534,
    }, { root });
    const pastEnd = await readFileTool.execute({
      path: pathInRoot, limit: 1, column_offset: 65_536,
    }, { root });

    expect(result.content).toBe("1 | x\n\n[Showing lines 1-1. Use offset=1 to continue.]");
    expect(pastEnd.content).toBe("(no content in requested range)");
  });

  it("keeps UTF-8, CRLF and a final line without a newline across stream chunks", async () => {
    const pathInRoot = "encoding.txt";
    await fs.writeFile(path.join(root, pathInRoot), `${"x".repeat(65_532)}\nA😀\r\nB\rC\nlast`);

    const result = await readFileTool.execute({ path: pathInRoot, offset: 1 }, { root });
    const pastEnd = await readFileTool.execute({ path: pathInRoot, offset: 4 }, { root });

    expect(result.content).toBe("2 | A😀\n3 | B\rC\n4 | last");
    expect(pastEnd.content).toBe("(no content in requested range)");
  });

  it("preserves cancellation as an error", async () => {
    const cancellation = new Error("Read cancelled");
    await expect(readFileTool.execute(
      { path: "lines.txt" },
      { root, signal: AbortSignal.abort(cancellation) },
    )).rejects.toThrow(cancellation);
  });
});

describe("tool previews", () => {
  it("write_file previews a new file as an empty baseline", async () => {
    const preview = await writeFileTool.preview?.(
      { path: "new.txt", content: "hello\n" },
      { root },
    );
    expect(preview).toMatchObject({
      kind: "diff",
      path: "new.txt",
      before: "",
      after: "hello\n",
      createsFile: true,
    });
    if (preview?.kind !== "diff" || !preview.revalidate) throw new Error("Missing file validation");
    await expect(preview.revalidate()).resolves.toBe(true);
    await fs.writeFile(path.join(root, "new.txt"), "");
    await expect(preview.revalidate()).resolves.toBe(false);
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

  it("explains why an edit is invalid and why an oversized write cannot be previewed", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "x\n", "utf8");
    const missing = await editFileTool.preview?.(
      { path: "a.txt", old_string: "nope", new_string: "y" },
      { root },
    );
    expect(missing).toMatchObject({ kind: "invalid", reason: expect.stringContaining("old_string was not found") });
    await expect(writeFileTool.preview?.({ path: "large.txt", content: "a".repeat(400_001) }, { root }))
      .resolves.toMatchObject({ kind: "unavailable", reason: expect.stringContaining("preview size limit") });
    await expect(fs.readdir(root)).resolves.toEqual(["a.txt"]);
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

  it("previews and applies a multiline LF edit to a CRLF file", async () => {
    const file = path.join(root, "a.txt");
    const original = "header\r\none\r\ntwo\r\ntrailer\r\n";
    const expected = "header\r\nalpha\r\nbeta\r\ntrailer\r\n";
    await fs.writeFile(file, original, "utf8");

    const input = { path: "a.txt", old_string: "one\ntwo", new_string: "alpha\nbeta" };
    await expect(editFileTool.preview?.(input, { root })).resolves.toMatchObject({
      kind: "diff",
      before: original,
      after: expected,
    });
    await editFileTool.execute(input, { root });
    await expect(fs.readFile(file)).resolves.toEqual(Buffer.from(expected));
  });

  it("treats matches across mixed line endings as ambiguous and preserves local endings with replace_all", async () => {
    const file = path.join(root, "a.txt");
    const original = "header\none\r\ntwo\r\nmiddle\r\none\ntwo\ntrailer";
    await fs.writeFile(file, original, "utf8");

    const input = { path: "a.txt", old_string: "one\r\ntwo", new_string: "alpha\n$&\nbeta" };
    await expect(editFileTool.preview?.(input, { root })).resolves.toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("2 times in a.txt (lines 2, 5)"),
    });
    await expect(editFileTool.execute(input, { root })).rejects.toThrow(/lines 2, 5/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe(original);

    const replaceAll = { ...input, replace_all: true };
    const expected = "header\nalpha\r\n$&\r\nbeta\r\nmiddle\r\nalpha\n$&\nbeta\ntrailer";
    await expect(editFileTool.preview?.(replaceAll, { root })).resolves.toMatchObject({
      kind: "diff",
      after: expected,
    });
    await editFileTool.execute(replaceAll, { root });
    await expect(fs.readFile(file)).resolves.toEqual(Buffer.from(expected));
  });

  it("removes a whole CRLF line when the match ends in LF", async () => {
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "header\r\nremove\r\nlast", "utf8");

    await editFileTool.execute({ path: "a.txt", old_string: "remove\n", new_string: "" }, { root });

    await expect(fs.readFile(file, "utf8")).resolves.toBe("header\r\nlast");
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
  it.each([
    "$home = 'fixture'",
    'echo "$HoMe"',
    "echo '${HOME}'",
    'echo "${HOME:-fixture}"',
    "echo $global:HOME",
    "echo ${env:Home}",
  ])("blocks the entire command when it contains %s", async (reference) => {
    const input = {
      command: `echo started > marker.txt; ${reference}`,
      description: "Check that the shell blocks HOME before any step runs.",
    };
    expect(runCommandTool.inputSchema.safeParse(input).success).toBe(false);
    await expect(runCommandTool.preview?.(input, { root })).resolves.toMatchObject({ kind: "invalid" });
    await expect(runCommandTool.execute(input, { root })).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("No command was started."),
    });
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("requires a nonblank description and carries it into the command preview", async () => {
    const command = "echo hello";
    expect(toToolSpec(runCommandTool).parameters).toMatchObject({
      required: ["command", "description"],
    });
    expect(runCommandTool.inputSchema.safeParse({ command }).success).toBe(false);
    expect(runCommandTool.inputSchema.safeParse({ command, description: " \n " }).success).toBe(false);
    expect(runCommandTool.inputSchema.safeParse({ command: "echo $HOMEWORK", description: "Read a different variable." }).success)
      .toBe(true);

    const description = "Print a greeting to check shell output.";
    const input = runCommandTool.inputSchema.parse({ command, description: `  ${description}  ` });
    expect(runCommandTool.summarize?.(input)).toContain(description);
    await expect(runCommandTool.preview?.(input, { root })).resolves.toMatchObject({
      kind: "command", command, description,
    });
  });

  it.skipIf(process.platform !== "win32")("uses Windows PowerShell by default and preserves Unicode", async () => {
    const input = { command: "Write-Output '中文 shell'", description: "Check Unicode output." };
    expect(runCommandTool.description).toContain("Windows PowerShell 5.1");
    expect(runCommandTool.summarize?.(input)).toContain("Windows PowerShell 5.1");
    const result = await runCommandTool.execute(input, { root });
    expect(result.content).toContain("中文 shell");
    expect(result.isError).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("omits PowerShell progress and keeps errors in plain text", async () => {
    const success = await runCommandTool.execute({
      command: "Get-ChildItem -Force | Select-Object -First 1 Name; Write-Progress -Activity 'fixture progress'; Write-Output 'ready'",
      description: "Inspect the first directory entry and check that progress output is suppressed.",
    }, { root });
    expect(success.isError).toBe(false);
    expect(success.content).toContain("ready");
    expect(success.content).not.toMatch(/CLIXML|\[stderr\]|fixture progress/);

    const failure = await runCommandTool.execute({
      command: "Write-Error '中文诊断'", description: "Check that Unicode errors stay readable.",
    }, { root });
    expect(failure.isError).toBe(true);
    expect(failure.content).toMatch(/exit code: 1/);
    expect(failure.content).toContain("中文诊断");
    expect(failure.content).not.toMatch(/CLIXML|<Objs\b/);
  });

  it("uses the configured shell in execution and tool metadata", async () => {
    const kind = process.platform === "win32" ? "cmd" : "sh";
    const tool = createRunCommandTool(resolveCommandShell({ kind }));
    const input = {
      command: kind === "cmd" ? "echo %COMSPEC%" : "printf '%s' shell-fixture",
      description: "Check that the configured shell runs the command.",
    };
    expect(tool.description).toContain(`using ${kind}`);
    expect(tool.summarize?.(input)).toContain(`[${kind} · cwd: .]`);
    const result = await tool.execute(input, { root });
    expect(result.content).toMatch(kind === "cmd" ? /cmd\.exe/i : /shell-fixture/);
    expect(result.isError).toBe(false);
  });

  it("rejects relative or missing configured executables", () => {
    const kind = resolveCommandShell().kind;
    expect(() => resolveCommandShell({ kind, executable: "./shell" })).toThrow(/absolute/);
    expect(() => resolveCommandShell({ kind, executable: path.join(root, "missing-shell") }))
      .toThrow(/was not found/);
  });

  it("returns output and the exit code", async () => {
    const result = await runCommandTool.execute(
      { command: "echo hello", description: "Check shell output.", timeout_ms: 10_000 },
      { root },
    );
    expect(result.content).toContain("hello");
    expect(result.content).toContain("exit code: 0");
    expect(result.isError).toBeFalsy();
  });

  it("marks non-zero exits as errors", async () => {
    const result = await runCommandTool.execute(
      { command: 'node -e "process.exit(3)"', description: "Check that the exit code is reported.", timeout_ms: 10_000 },
      { root },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exit code: 3");
  });

  it("cancels a running command", async () => {
    const controller = new AbortController();
    const marker = path.join(root, "running.txt");
    const running = runCommandTool.execute({
      command: "node -e \"require('node:fs').writeFileSync('running.txt','running');setTimeout(()=>{},60000)\"",
      description: "Write a marker and keep the process alive until it is cancelled.",
      timeout_ms: 60_000,
    }, { root, signal: controller.signal });

    try {
      await expect.poll(() => fs.readFile(marker, "utf8").catch(() => ""), { timeout: 4_000 }).toBe("running");
    } finally {
      controller.abort();
    }
    await expect(running).resolves.toMatchObject({
      isError: true,
      content: expect.stringContaining("Command cancelled."),
    });
  }, 10_000);

  it("rejects working directories outside the workspace", async () => {
    await expect(
      runCommandTool.execute({ command: "echo x", description: "Check the parent directory restriction.", cwd: ".." }, { root }),
    ).rejects.toThrow(/outside the workspace/);
  });
});

describe("workspace path containment", () => {
  const linkType = process.platform === "win32" ? "junction" : "dir";

  it("refuses to launch a command if its directory changed after preview validation", async () => {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const linked = path.join(root, "linked");
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.symlink(first, linked, linkType);

    const input = { command: "echo approved > marker.txt", description: "Write an approval marker.", cwd: "linked" };
    const ctx = { root };
    const preview = await runCommandTool.preview?.(input, ctx);
    if (preview?.kind !== "command" || !preview.revalidate) throw new Error("Missing command validation");
    await expect(preview.revalidate()).resolves.toBe(true);

    await fs.unlink(linked);
    await fs.symlink(second, linked, linkType);
    await expect(runCommandTool.execute(input, ctx, preview)).rejects.toThrow(/working directory changed/);
    await expect(fs.readdir(first)).resolves.toEqual([]);
    await expect(fs.readdir(second)).resolves.toEqual([]);
  });

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
    await expect(writeFileTool.preview?.(write, ctx)).resolves.toMatchObject({
      kind: "invalid", reason: expect.stringContaining("outside the workspace"),
    });
    await expect(editFileTool.preview?.(edit, ctx)).resolves.toMatchObject({
      kind: "invalid", reason: expect.stringContaining("outside the workspace"),
    });
    await expect(writeFileTool.execute(write, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(editFileTool.execute(edit, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(writeFileTool.execute({ path: "escape/new/file.txt", content: "new" }, ctx))
      .rejects.toThrow(/outside the workspace/);
    await expect(runCommandTool.execute({ cwd: "escape", command: "echo x", description: "Check the linked directory restriction." }, ctx))
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
