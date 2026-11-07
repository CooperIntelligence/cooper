import { diffText } from "@cooper/core";

export const MAX_PREVIEW_ROWS = 18;

export type PreviewTone = "add" | "remove" | "context" | "hunk";

export type PreviewRow = {
  text: string;
  tone: PreviewTone;
};

export type PreviewRows = {
  rows: PreviewRow[];
  /** Diff rows that did not fit and were collapsed into a counter. */
  hidden: number;
  added: number;
  removed: number;
};

/**
 * Flattens a diff into rows for the approval panel. Rendering is capped so a
 * large rewrite cannot push the approval keys off the screen.
 */
export function buildPreviewRows(
  preview: { before: string; after: string },
  maxRows: number = MAX_PREVIEW_ROWS,
): PreviewRows {
  const result = diffText(preview.before, preview.after);
  const rows: PreviewRow[] = [];

  for (const hunk of result.hunks) {
    rows.push({
      text: `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
      tone: "hunk",
    });
    for (const line of hunk.lines) {
      const marker =
        line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
      const text =
        line.text.length > 200 ? `${line.text.slice(0, 199)}…` : line.text;
      rows.push({ text: `${marker}${text}`, tone: line.kind });
    }
  }

  return {
    rows: rows.slice(0, maxRows),
    hidden: Math.max(0, rows.length - maxRows),
    added: result.added,
    removed: result.removed,
  };
}
