import { diffText } from "@cooper/core";
import stringWidth from "string-width";

export type PreviewTone = "add" | "remove" | "context" | "hunk";
export type PreviewRow = { text: string; tone: PreviewTone };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Make terminal controls visible before measuring or writing a preview. */
export function visiblePreviewText(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (char) => {
    if (char === "\t") return "\\t";
    if (char === "\r") return "\\r";
    const code = char.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16)}`;
  });
}

export function wrapPreviewText(text: string, columns: number): string[] {
  const rows: string[] = [];
  for (const line of visiblePreviewText(text).split("\n")) {
    if (stringWidth(line) <= columns) {
      rows.push(line);
      continue;
    }
    let row = "";
    let width = 0;
    for (const { segment } of graphemes.segment(line)) {
      const cells = stringWidth(segment);
      if (width > 0 && width + cells > columns) {
        rows.push(row);
        row = "";
        width = 0;
      }
      row += segment;
      width += cells;
    }
    rows.push(row);
  }
  return rows;
}

export function buildPreviewRows(preview: {
  before: string;
  after: string;
  createsFile?: boolean;
}): { rows: PreviewRow[]; added: number; removed: number } {
  const { hunks, added, removed } = diffText(preview.before, preview.after, { preserveLineEndings: true });
  const rows: PreviewRow[] = [];
  const hasCrLf = preview.before.includes("\r\n") || preview.after.includes("\r\n");

  for (const hunk of hunks) {
    rows.push({
      text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      tone: "hunk",
    });
    for (const line of hunk.lines) {
      const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
      const ended = line.text.endsWith("\n");
      const crlf = line.text.endsWith("\r\n");
      const content = ended ? line.text.slice(0, crlf ? -2 : -1) : line.text;
      const ending = ended ? (hasCrLf ? (crlf ? " [CRLF]" : " [LF]") : "") : " [no final newline]";
      rows.push({ text: `${marker}${content}${ending}`, tone: line.kind });
    }
  }

  if (rows.length === 0) {
    rows.push({ text: preview.createsFile ? "Creates an empty file." : "No changes.", tone: "context" });
  }
  return { rows, added, removed };
}
