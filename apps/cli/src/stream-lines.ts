export type LineSplit = {
  /** The unfinished trailing line, kept in the live region. */
  buffer: string;
  /** Complete lines that can be committed to <Static> exactly once. */
  lines: string[];
};

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Feed a streamed text delta into a buffer and return every line that is now
 * complete. The remainder stays buffered until the next delta or flush.
 */
export function splitCompletedLines(buffer: string, delta: string): LineSplit {
  const segments = (buffer + delta).split("\n");
  const remaining = segments.pop() ?? "";
  return {
    buffer: remaining,
    lines: segments.map(stripCarriageReturn),
  };
}

/**
 * Split a final message body into lines, dropping the empty trailing segment
 * produced by a terminating newline (it is not a real blank line).
 */
export function splitContent(content: string): string[] {
  const lines = content.split(/\r?\n/).map(stripCarriageReturn);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
