import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";
import { resolveInRoot } from "./paths.js";
import type { Tool, ToolContext, ToolPreview } from "./tool.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".class", ".jar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv",
  ".lockb", ".db", ".sqlite", ".pyc",
]);

const MAX_LIST_ENTRIES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 48_000;
const DEFAULT_READ_LINES = 200;
/** Above this, an approval preview is skipped rather than rendered. */
const MAX_PREVIEW_CHARS = 400_000;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 5000;

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function walkDirectory(
  root: string,
  base: string,
  dir: string,
  depthLeft: number,
  entries: string[],
): Promise<void> {
  if (entries.length >= MAX_LIST_ENTRIES) return;

  let dirents;
  try {
    if (await resolveInRoot(root, dir) !== dir) return;
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  dirents.sort(
    (a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) ||
      a.name.localeCompare(b.name),
  );

  for (const dirent of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    if (dirent.isDirectory() && IGNORED_DIRS.has(dirent.name)) continue;

    const fullPath = path.join(dir, dirent.name);
    const rel = toPosix(path.relative(base, fullPath));
    entries.push(dirent.isDirectory() ? `${rel}/` : rel);

    if (dirent.isDirectory() && depthLeft > 1) {
      await walkDirectory(root, base, fullPath, depthLeft - 1, entries);
    }
  }
}

async function collectFiles(
  root: string,
  base: string,
  dir: string,
  include: string | undefined,
  files: string[],
): Promise<void> {
  if (files.length >= MAX_SEARCH_FILES) return;

  let dirents;
  try {
    if (await resolveInRoot(root, dir) !== dir) return;
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (files.length >= MAX_SEARCH_FILES) return;

    if (dirent.isDirectory()) {
      if (IGNORED_DIRS.has(dirent.name)) continue;
      await collectFiles(root, base, path.join(dir, dirent.name), include, files);
      continue;
    }

    if (!dirent.isFile()) continue;
    if (BINARY_EXTS.has(path.extname(dirent.name).toLowerCase())) continue;

    const fullPath = path.join(dir, dirent.name);
    if (include) {
      const rel = toPosix(path.relative(base, fullPath));
      if (!minimatch(rel, include, { dot: true })) continue;
    }
    files.push(fullPath);
  }
}

const listDirSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Directory relative to the workspace root. Defaults to the root."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("How many directory levels to recurse. Defaults to 2."),
});

export const listDirTool: Tool<typeof listDirSchema> = {
  name: "list_dir",
  description:
    "List files and directories in the workspace. Directories end with '/'. Common build and dependency directories are skipped.",
  inputSchema: listDirSchema,
  capabilities: ["read"],
  summarize(input) {
    return `List ${input.path ?? "."} (depth ${input.depth ?? 2})`;
  },
  async execute(input, ctx) {
    const base = await resolveInRoot(ctx.root, input.path ?? ".");
    const depth = input.depth ?? 2;
    const entries: string[] = [];
    await walkDirectory(await fs.realpath(ctx.root), base, base, depth, entries);

    if (entries.length === 0) return { content: "(empty directory)" };

    const suffix =
      entries.length >= MAX_LIST_ENTRIES
        ? `\n\n[truncated at ${MAX_LIST_ENTRIES} entries]`
        : "";
    return { content: entries.join("\n") + suffix };
  },
};

const readFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based line offset to start from. Defaults to 0."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe(`Maximum number of lines to return. Defaults to ${DEFAULT_READ_LINES}.`),
  column_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based Unicode code point offset within the line. Requires limit: 1."),
}).refine(({ column_offset, limit }) => column_offset === undefined || limit === 1, {
  path: ["column_offset"],
  message: "column_offset requires limit: 1.",
});

async function* readTextLines(
  absolute: string,
  offset: number,
  columnOffset: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const stream = createReadStream(absolute, { encoding: "utf8", signal });
  const prefixLimit = MAX_OUTPUT_CHARS + 1;
  let skipped = 0;
  let columnsToSkip = columnOffset;
  let line = "";
  let trailingCR = "";

  for await (const chunk of stream) {
    const text: string = trailingCR + chunk;
    // Wait for the next chunk to tell whether a trailing CR is part of CRLF.
    trailingCR = text.endsWith("\r") ? "\r" : "";
    const chunkEnd = text.length - trailingCR.length;
    let start = 0;
    while (start < chunkEnd) {
      const newline = text.indexOf("\n", start);
      if (skipped === offset) {
        const end = newline === -1 ? chunkEnd : newline - Number(text[newline - 1] === "\r");
        while (columnsToSkip > 0 && start < end) {
          start += (text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
          columnsToSkip -= 1;
        }
        line += text.slice(start, Math.min(end, start + prefixLimit - line.length));
        if (line.length === prefixLimit) {
          // The caller can finish the page without scanning the rest of this line.
          yield line;
          return;
        }
      }
      if (newline === -1) break;

      if (skipped < offset) {
        skipped += 1;
      } else {
        if (columnsToSkip > 0) return;
        yield line;
        line = "";
      }
      start = newline + 1;
    }
  }

  if (skipped === offset && columnsToSkip <= trailingCR.length) {
    yield line + trailingCR.slice(columnsToSkip);
  }
}

export const readFileTool: Tool<typeof readFileSchema> = {
  name: "read_file",
  description:
    "Read a text file from the workspace with 1-based output line numbers. " +
    "Set offset and limit for a known range, or use grep to locate a symbol first. " +
    "Follow the offsets in the result to continue a partial read, including column_offset for a long line.",
  inputSchema: readFileSchema,
  capabilities: ["read"],
  summarize(input) {
    const from = input.offset ? ` from line ${input.offset + 1}` : "";
    if (input.column_offset !== undefined) {
      return `Read ${input.path} from line ${(input.offset ?? 0) + 1}, column ${input.column_offset + 1}`;
    }
    return `Read ${input.path}${from}`;
  },
  async execute(input, ctx) {
    ctx.signal?.throwIfAborted();
    const absolute = await resolveInRoot(ctx.root, input.path);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${input.path}`);
    }
    const start = input.offset ?? 0;
    const limit = input.limit ?? DEFAULT_READ_LINES;
    const columnOffset = input.column_offset ?? 0;
    const lines: string[] = [];
    let textChars = 0;
    let stop: "line-limit" | "character-limit" | "long-line" | undefined;

    for await (const line of readTextLines(absolute, start, columnOffset, ctx.signal)) {
      if (lines.length === limit) {
        stop = "line-limit";
        break;
      }

      // A wider line number increases the prefix width for every line on the page.
      const width = String(start + lines.length + 1).length;
      const room = MAX_OUTPUT_CHARS - textChars - (lines.length + 1) * (width + 3) - lines.length;
      if (line.length > room) {
        stop = "character-limit";
        if (lines.length === 0) {
          lines.push(line.slice(0, room).replace(/[\uD800-\uDBFF]$/u, ""));
          stop = "long-line";
        }
        break;
      }
      lines.push(line);
      textChars += line.length;
    }

    if (lines.length === 0) return { content: "(no content in requested range)" };

    const end = start + lines.length;
    const width = String(end).length;
    const body = lines
      .map(
        (line, index) =>
          `${String(start + index + 1).padStart(width, " ")} | ${line}`,
      )
      .join("\n");

    if (stop === undefined) return { content: body };
    if (stop === "long-line") {
      const nextColumn = columnOffset + Array.from(lines[0] ?? "").length;
      return {
        content: `${body}\n\n[Line ${end} was truncated at the ${MAX_OUTPUT_CHARS}-character output limit. ` +
          `Continue this line with offset=${start}, limit=1, column_offset=${nextColumn}. ` +
          `To skip to the next line, use offset=${end} and omit column_offset.]`,
      };
    }

    const reason = stop === "character-limit" ? `Output capped at ${MAX_OUTPUT_CHARS} characters. ` : "";
    return {
      content: `${body}\n\n[${reason}Showing lines ${start + 1}-${end}. Use offset=${end} to continue.]`,
    };
  },
};

const grepSchema = z.object({
  pattern: z.string().describe("JavaScript regular expression to search for."),
  path: z
    .string()
    .optional()
    .describe("Directory or file to search. Defaults to the workspace root."),
  include: z
    .string()
    .optional()
    .describe("Glob filter for file paths, e.g. \"**/*.ts\"."),
  caseSensitive: z
    .boolean()
    .optional()
    .describe("Whether matching is case sensitive. Defaults to true."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum number of matching lines to return. Defaults to 100."),
});

export const grepTool: Tool<typeof grepSchema> = {
  name: "grep",
  description:
    "Search file contents in the workspace with a regular expression. Returns file:line: content matches.",
  inputSchema: grepSchema,
  capabilities: ["read"],
  summarize(input) {
    const scope = input.include ? ` in ${input.include}` : "";
    return `Search /${input.pattern}/${scope}`;
  },
  async execute(input, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, input.caseSensitive === false ? "i" : "");
    } catch (error) {
      throw new Error(
        `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const target = await resolveInRoot(ctx.root, input.path ?? ".");
    const root = await fs.realpath(ctx.root);
    const requestedPath = path.resolve(ctx.root, input.path ?? ".");
    const stat = await fs.stat(target);
    const files: string[] = [];

    if (stat.isDirectory()) {
      await collectFiles(root, target, target, input.include, files);
    } else if (stat.isFile()) {
      files.push(target);
    } else {
      throw new Error(`Not a file or directory: ${input.path}`);
    }

    const maxResults = input.maxResults ?? 100;
    const matches: string[] = [];

    for (const file of files) {
      if (matches.length >= maxResults) break;

      let text: string;
      try {
        if (await resolveInRoot(root, file) !== file) continue;
        const fileStat = await fs.stat(file);
        if (!fileStat.isFile() || fileStat.size > MAX_SEARCH_FILE_BYTES) continue;
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }

      const displayedFile = path.join(requestedPath, path.relative(target, file));
      const rel = toPosix(path.relative(ctx.root, displayedFile));
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!regex.test(line)) continue;
        matches.push(`${rel}:${index + 1}: ${line.trim().slice(0, 300)}`);
        if (matches.length >= maxResults) break;
      }
    }

    if (matches.length === 0) {
      return {
        content: `No matches for /${input.pattern}/ in ${toPosix(
          path.relative(ctx.root, requestedPath) || ".",
        )} (${files.length} file(s) searched)`,
      };
    }

    const suffix =
      matches.length >= maxResults
        ? `\n\n[truncated at ${maxResults} matches]`
        : "";
    return { content: matches.join("\n") + suffix };
  },
};

type FilePreviewSnapshot = {
  kind: "file";
  absolute: string;
  bytes: Buffer | null;
  text: string;
};

async function readPreviewFile(relative: string, root: string): Promise<
  FilePreviewSnapshot | Extract<ToolPreview, { kind: "invalid" | "unavailable" }>
> {
  let absolute: string;
  try {
    absolute = await resolveInRoot(root, relative);
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const stat = await fs.stat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat === null) return { kind: "file", absolute, bytes: null, text: "" };
    if (!stat.isFile()) return { kind: "invalid", reason: `Not a file: ${relative}` };
    if (stat.size <= MAX_PREVIEW_CHARS) {
      const bytes = await fs.readFile(absolute);
      if (bytes.length <= MAX_PREVIEW_CHARS) {
        const text = bytes.toString("utf8");
        if (Buffer.from(text, "utf8").equals(bytes)) {
          return { kind: "file", absolute, bytes, text };
        }
        return { kind: "unavailable", reason: "The existing file is not valid UTF-8." };
      }
    }
    return { kind: "unavailable", reason: "The existing file exceeds the preview size limit." };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function previewFileChange(
  relative: string,
  context: ToolContext,
  snapshot: FilePreviewSnapshot,
  after: string,
): ToolPreview {
  return {
    kind: "diff",
    path: relative,
    before: snapshot.text,
    after,
    createsFile: snapshot.bytes === null,
    async revalidate() {
      const current = await readPreviewFile(relative, context.root);
      if (current.kind !== "file" || current.absolute !== snapshot.absolute) return false;
      if (snapshot.bytes === null || current.bytes === null) return current.bytes === snapshot.bytes;
      return snapshot.bytes.equals(current.bytes);
    },
  };
}

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  content: z
    .string()
    .describe("Complete file content. This overwrites the file if it exists."),
});

export const writeFileTool: Tool<typeof writeFileSchema> = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Parent directories are created automatically. Prefer edit_file for small changes to existing files.",
  inputSchema: writeFileSchema,
  capabilities: ["write"],
  summarize(input) {
    const lines = input.content.split(/\r?\n/);
    const preview = lines.slice(0, 3).join("\n");
    const suffix = lines.length > 3 ? "\n…" : "";
    return `Write ${input.path} (${input.content.length} chars)\n${preview}${suffix}`;
  },
  async preview(input, ctx) {
    if (Buffer.byteLength(input.content, "utf8") > MAX_PREVIEW_CHARS) {
      return { kind: "unavailable", reason: "The new content exceeds the preview size limit." };
    }
    const snapshot = await readPreviewFile(input.path, ctx.root);
    return snapshot.kind === "file" ? previewFileChange(input.path, ctx, snapshot, input.content) : snapshot;
  },
  async execute(input, ctx) {
    const absolute = await resolveInRoot(ctx.root, input.path);
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`Content is too large (${bytes} bytes, limit ${MAX_FILE_BYTES}).`);
    }

    const existing = await fs.stat(absolute).catch(() => null);
    if (existing && !existing.isFile()) {
      throw new Error(`Not a file: ${input.path}`);
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    if (await resolveInRoot(ctx.root, input.path) !== absolute) {
      throw new Error(`Path "${input.path}" changed while preparing the write`);
    }
    await fs.writeFile(absolute, input.content, "utf8");
    return {
      content: `${existing ? "Updated" : "Created"} ${input.path} (${bytes} bytes)`,
    };
  },
};

const editFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  old_string: z
    .string()
    .describe("Exact text to replace. Must match the file byte-for-byte."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence. Defaults to false, in which case old_string must be unique.",
    ),
});

function applyEdit(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  // A function replacement keeps `$&`-style sequences in newString literal.
  return replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, () => newString);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function editMatchError(file: string, count: number, replaceAll: boolean): string | undefined {
  if (count === 0) {
    return `old_string was not found in ${file}. Read the file and provide the exact text, including whitespace.`;
  }
  if (count > 1 && !replaceAll) {
    return `old_string appears ${count} times in ${file}. Add more surrounding context to make it unique, or set replace_all to true.`;
  }
}

export const editFileTool: Tool<typeof editFileSchema> = {
  name: "edit_file",
  description:
    "Replace an exact string in an existing file. old_string must match exactly and be unique unless replace_all is true. Prefer this over write_file for targeted changes.",
  inputSchema: editFileSchema,
  capabilities: ["write"],
  summarize(input) {
    const flag = input.replace_all ? " (all occurrences)" : "";
    return [
      `Edit ${input.path}${flag}`,
      `- ${oneLine(input.old_string)}`,
      `+ ${oneLine(input.new_string)}`,
    ].join("\n");
  },
  async preview(input, ctx) {
    if (!input.old_string) return { kind: "invalid", reason: "old_string must not be empty" };
    const snapshot = await readPreviewFile(input.path, ctx.root);
    if (snapshot.kind !== "file") return snapshot;
    if (snapshot.bytes === null) return { kind: "invalid", reason: `File not found: ${input.path}` };
    const replaceAll = input.replace_all === true;
    const count = countOccurrences(snapshot.text, input.old_string);
    const reason = editMatchError(input.path, count, replaceAll);
    if (reason) return { kind: "invalid", reason };
    if (snapshot.text.length + count * (input.new_string.length - input.old_string.length) > MAX_PREVIEW_CHARS) {
      return { kind: "unavailable", reason: "The new content exceeds the preview size limit." };
    }
    const after = applyEdit(snapshot.text, input.old_string, input.new_string, replaceAll);
    if (Buffer.byteLength(after, "utf8") > MAX_PREVIEW_CHARS) {
      return { kind: "unavailable", reason: "The new content exceeds the preview size limit." };
    }
    return previewFileChange(input.path, ctx, snapshot, after);
  },
  async execute(input, ctx) {
    if (input.old_string.length === 0) {
      throw new Error("old_string must not be empty");
    }

    const absolute = await resolveInRoot(ctx.root, input.path);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(`File not found: ${input.path}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large (${stat.size} bytes, limit ${MAX_FILE_BYTES}).`);
    }

    const original = await fs.readFile(absolute, "utf8");
    const count = countOccurrences(original, input.old_string);

    const reason = editMatchError(input.path, count, input.replace_all === true);
    if (reason) throw new Error(reason);

    const updated = applyEdit(
      original,
      input.old_string,
      input.new_string,
      input.replace_all === true,
    );

    if (await resolveInRoot(ctx.root, input.path) !== absolute) {
      throw new Error(`Path "${input.path}" changed while preparing the edit`);
    }
    await fs.writeFile(absolute, updated, "utf8");
    return { content: `Replaced ${count} occurrence(s) in ${input.path}` };
  },
};

export const fileTools: Tool[] = [
  listDirTool,
  readFileTool,
  grepTool,
  writeFileTool,
  editFileTool,
];
