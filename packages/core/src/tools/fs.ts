import { promises as fs } from "node:fs";
import path from "node:path";
import { minimatch } from "minimatch";
import { z } from "zod";
import { resolveInRoot } from "./paths.js";
import type { Tool } from "./tool.js";

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
  base: string,
  dir: string,
  depthLeft: number,
  entries: string[],
): Promise<void> {
  if (entries.length >= MAX_LIST_ENTRIES) return;

  let dirents;
  try {
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
      await walkDirectory(base, fullPath, depthLeft - 1, entries);
    }
  }
}

async function collectFiles(
  base: string,
  dir: string,
  include: string | undefined,
  files: string[],
): Promise<void> {
  if (files.length >= MAX_SEARCH_FILES) return;

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    if (files.length >= MAX_SEARCH_FILES) return;

    if (dirent.isDirectory()) {
      if (IGNORED_DIRS.has(dirent.name)) continue;
      await collectFiles(base, path.join(dir, dirent.name), include, files);
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
  summarize(input) {
    return `List ${input.path ?? "."} (depth ${input.depth ?? 2})`;
  },
  async execute(input, ctx) {
    const base = resolveInRoot(ctx.root, input.path ?? ".");
    const depth = input.depth ?? 2;
    const entries: string[] = [];
    await walkDirectory(base, base, depth, entries);

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
    .describe("Maximum number of lines to return. Defaults to 400."),
});

export const readFileTool: Tool<typeof readFileSchema> = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Output lines are prefixed with their 1-based line number.",
  inputSchema: readFileSchema,
  summarize(input) {
    const from = input.offset ? ` from line ${input.offset + 1}` : "";
    return `Read ${input.path}${from}`;
  },
  async execute(input, ctx) {
    const absolute = resolveInRoot(ctx.root, input.path);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${input.path}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is too large (${stat.size} bytes, limit ${MAX_FILE_BYTES}). Read it in chunks with offset/limit.`,
      );
    }

    const text = await fs.readFile(absolute, "utf8");
    const lines = text.split(/\r?\n/);
    const start = input.offset ?? 0;
    const limit = input.limit ?? 400;
    const slice = lines.slice(start, start + limit);

    const width = String(start + slice.length).length;
    const body = slice
      .map(
        (line, index) =>
          `${String(start + index + 1).padStart(width, " ")} | ${line}`,
      )
      .join("\n");

    if (slice.length === 0) return { content: "(no content in requested range)" };

    const end = start + slice.length;
    const notes: string[] = [];
    if (end < lines.length) {
      notes.push(`[truncated: lines ${start + 1}-${end} of ${lines.length}]`);
    }

    // A few "lines" can still be megabytes (minified output, long data lines),
    // and one oversized tool result can exceed the whole context window. Cap
    // the rendered output so a single call can never dominate the budget.
    let content = body;
    if (content.length > MAX_OUTPUT_CHARS) {
      const boundary = content.lastIndexOf("\n", MAX_OUTPUT_CHARS);
      content = content.slice(0, boundary > 0 ? boundary : MAX_OUTPUT_CHARS);
      notes.push(
        `[output capped at ${MAX_OUTPUT_CHARS} characters; use offset/limit to read further]`,
      );
    }

    return {
      content: notes.length > 0 ? `${content}\n\n${notes.join("\n")}` : content,
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

    const target = resolveInRoot(ctx.root, input.path ?? ".");
    const stat = await fs.stat(target);
    const files: string[] = [];

    if (stat.isDirectory()) {
      await collectFiles(target, target, input.include, files);
    } else if (stat.isFile()) {
      files.push(target);
    } else {
      throw new Error(`Not a file or directory: ${input.path}`);
    }

    const maxResults = input.maxResults ?? 100;
    const matches: string[] = [];

    for (const file of files) {
      if (matches.length >= maxResults) break;

      const fileStat = await fs.stat(file);
      if (fileStat.size > MAX_SEARCH_FILE_BYTES) continue;

      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }

      const rel = toPosix(path.relative(ctx.root, file));
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
          path.relative(ctx.root, target) || ".",
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
  requiresApproval: true,
  summarize(input) {
    const lines = input.content.split(/\r?\n/);
    const preview = lines.slice(0, 3).join("\n");
    const suffix = lines.length > 3 ? "\n…" : "";
    return `Write ${input.path} (${input.content.length} chars)\n${preview}${suffix}`;
  },
  async execute(input, ctx) {
    const absolute = resolveInRoot(ctx.root, input.path);
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`Content is too large (${bytes} bytes, limit ${MAX_FILE_BYTES}).`);
    }

    const existing = await fs.stat(absolute).catch(() => null);
    if (existing && !existing.isFile()) {
      throw new Error(`Not a file: ${input.path}`);
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });
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

export const editFileTool: Tool<typeof editFileSchema> = {
  name: "edit_file",
  description:
    "Replace an exact string in an existing file. old_string must match exactly and be unique unless replace_all is true. Prefer this over write_file for targeted changes.",
  inputSchema: editFileSchema,
  requiresApproval: true,
  summarize(input) {
    const flag = input.replace_all ? " (all occurrences)" : "";
    return [
      `Edit ${input.path}${flag}`,
      `- ${oneLine(input.old_string)}`,
      `+ ${oneLine(input.new_string)}`,
    ].join("\n");
  },
  async execute(input, ctx) {
    if (input.old_string.length === 0) {
      throw new Error("old_string must not be empty");
    }

    const absolute = resolveInRoot(ctx.root, input.path);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(`File not found: ${input.path}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large (${stat.size} bytes, limit ${MAX_FILE_BYTES}).`);
    }

    const original = await fs.readFile(absolute, "utf8");
    const count = countOccurrences(original, input.old_string);

    if (count === 0) {
      throw new Error(
        `old_string was not found in ${input.path}. Read the file and provide the exact text, including whitespace.`,
      );
    }
    if (count > 1 && input.replace_all !== true) {
      throw new Error(
        `old_string appears ${count} times in ${input.path}. Add more surrounding context to make it unique, or set replace_all to true.`,
      );
    }

    const updated =
      input.replace_all === true
        ? original.split(input.old_string).join(input.new_string)
        : original.replace(input.old_string, input.new_string);

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
