export type DiffKind = "context" | "add" | "remove";

export type DiffLine = {
  kind: DiffKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

export type DiffResult = {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the change was too large to align line by line. */
  coarsened: boolean;
};

/** Beyond this, an exact line alignment costs more than a preview is worth. */
const LCS_LINE_LIMIT = 1500;
const DEFAULT_CONTEXT = 3;

function splitLines(text: string, preserveLineEndings: boolean): string[] {
  if (preserveLineEndings) return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  // A trailing newline is not an extra empty line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type RawLine = DiffLine;

/** Longest-common-subsequence walk over the trimmed middle of the two files. */
function alignMiddle(
  a: string[],
  b: string[],
  offset: number,
): RawLine[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * width;
    const nextRow = (i + 1) * width;
    for (let j = m - 1; j >= 0; j -= 1) {
      table[row + j] =
        a[i] === b[j]
          ? (table[nextRow + j + 1] ?? 0) + 1
          : Math.max(table[nextRow + j] ?? 0, table[row + j + 1] ?? 0);
    }
  }

  const out: RawLine[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({
        kind: "context",
        text: a[i] ?? "",
        oldLine: offset + i + 1,
        newLine: offset + j + 1,
      });
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)
    ) {
      out.push({
        kind: "remove",
        text: a[i] ?? "",
        oldLine: offset + i + 1,
        newLine: null,
      });
      i += 1;
    } else {
      out.push({
        kind: "add",
        text: b[j] ?? "",
        oldLine: null,
        newLine: offset + j + 1,
      });
      j += 1;
    }
  }

  while (i < n) {
    out.push({
      kind: "remove",
      text: a[i] ?? "",
      oldLine: offset + i + 1,
      newLine: null,
    });
    i += 1;
  }
  while (j < m) {
    out.push({
      kind: "add",
      text: b[j] ?? "",
      oldLine: null,
      newLine: offset + j + 1,
    });
    j += 1;
  }

  return out;
}

function buildHunks(lines: RawLine[], context: number): DiffHunk[] {
  const ranges: Array<[number, number]> = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.kind === "context") continue;
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  return ranges.map(([start, end]) => {
    const slice = lines.slice(start, end);
    const oldLines = slice.filter((line) => line.oldLine !== null);
    const newLines = slice.filter((line) => line.newLine !== null);
    return {
      oldStart: oldLines[0]?.oldLine ?? 0,
      oldCount: oldLines.length,
      newStart: newLines[0]?.newLine ?? 0,
      newCount: newLines.length,
      lines: slice,
    };
  });
}

/**
 * Line diff for previews: trims the common prefix/suffix first, then aligns
 * the middle and keeps only hunks with a few lines of surrounding context.
 * Large rewrites degrade to "everything removed, everything added" rather
 * than spending seconds on a quadratic alignment.
 */
export function diffText(
  before: string,
  after: string,
  options: { context?: number; preserveLineEndings?: boolean } = {},
): DiffResult {
  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT);
  const a = splitLines(before, options.preserveLineEndings === true);
  const b = splitLines(after, options.preserveLineEndings === true);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);

  let middle: RawLine[];
  let coarsened = false;

  if (middleA.length + middleB.length > LCS_LINE_LIMIT * 2) {
    coarsened = true;
    middle = [
      ...middleA.map((text, index) => ({
        kind: "remove" as const,
        text,
        oldLine: prefix + index + 1,
        newLine: null,
      })),
      ...middleB.map((text, index) => ({
        kind: "add" as const,
        text,
        oldLine: null,
        newLine: prefix + index + 1,
      })),
    ];
  } else {
    middle = alignMiddle(middleA, middleB, prefix);
  }

  const prefixContext: RawLine[] = [];
  for (let index = Math.max(0, prefix - context); index < prefix; index += 1) {
    prefixContext.push({
      kind: "context",
      text: a[index] ?? "",
      oldLine: index + 1,
      newLine: index + 1,
    });
  }

  const suffixContext: RawLine[] = [];
  for (let k = 0; k < Math.min(context, suffix); k += 1) {
    suffixContext.push({
      kind: "context",
      text: a[a.length - suffix + k] ?? "",
      oldLine: a.length - suffix + k + 1,
      newLine: b.length - suffix + k + 1,
    });
  }

  const lines = [...prefixContext, ...middle, ...suffixContext];
  let added = 0;
  let removed = 0;
  for (const line of middle) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "remove") removed += 1;
  }

  return {
    hunks: buildHunks(lines, context),
    added,
    removed,
    coarsened,
  };
}
