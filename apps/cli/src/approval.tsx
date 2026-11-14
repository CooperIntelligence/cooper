import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { supportsProcessGrant, type ApprovalOutcome, type ApprovalRequest } from "@cooper/core";
import { buildPreviewRows, visiblePreviewText, wrapPreviewText, type PreviewRow } from "./preview.js";

const colors = { add: "green", remove: "red", hunk: "cyan", context: "gray" } as const;

function describePreview(request: ApprovalRequest) {
  const { preview, summary, toolName } = request;
  if (preview?.kind === "diff") {
    const diff = buildPreviewRows(preview);
    return {
      title: preview.createsFile ? "Create file" : toolName === "write_file" ? "Overwrite file" : "Edit file",
      target: `${preview.path} · +${diff.added} −${diff.removed}`,
      rows: diff.rows,
    };
  }
  if (preview?.kind === "command") {
    return {
      title: "Run command",
      target: `${preview.shell} · cwd: ${preview.cwd}`,
      rows: [
        { text: `Shell executable: ${preview.executable}`, tone: "context" },
        { text: preview.command, tone: "hunk" },
      ] satisfies PreviewRow[],
    };
  }
  if (preview?.kind === "text") {
    return { title: preview.title, target: toolName, rows: [{ text: preview.text, tone: "context" }] satisfies PreviewRow[] };
  }
  const reason = preview?.kind === "unavailable" ? ` ${preview.reason}` : "";
  const title = toolName === "write_file" ? "Write file"
    : toolName === "edit_file" ? "Edit file"
    : toolName.startsWith("mcp__") ? "MCP tool" : "Run tool";
  const [headline, ...details] = summary.split(/\r?\n/);
  return {
    title,
    target: headline || toolName,
    rows: [
      { text: `Effect preview unavailable.${reason}`, tone: "hunk" },
      ...details.map((text) => ({ text, tone: "context" as const })),
    ] satisfies PreviewRow[],
  };
}

export function ApprovalPanel({ request, onDecision, onInterrupt }: {
  request: ApprovalRequest;
  onDecision: (decision: ApprovalOutcome) => void;
  onInterrupt: () => void;
}) {
  const { columns, rows } = useWindowSize();
  const width = Math.max(2, columns - 4);
  const [page, setPage] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [confirmPage, setConfirmPage] = useState(0);
  const canGrantProcess = supportsProcessGrant(request.capabilities);
  const preview = useMemo(() => describePreview(request), [request]);
  const fullTarget = useMemo(() => wrapPreviewText(preview.target, width), [preview.target, width]);

  const wrappedRows = useMemo(() => {
    const source: PreviewRow[] = confirming
      ? [
          { text: `Allow this call and future ${request.toolName} calls until Cooper exits. Future calls in Ask mode may use different arguments.`, tone: "context" },
        ]
      : preview.rows;
    const body = source.flatMap((row) => wrapPreviewText(row.text, width).map((text) => ({ ...row, text })));
    return fullTarget.length > 1 && !confirming
      ? [...fullTarget.map((text) => ({ text, tone: "context" as const })), ...body]
      : body;
  }, [confirming, fullTarget, preview.rows, request.toolName, width]);
  const grantControl = canGrantProcess ? " · a Allow this tool until exit…" : "";
  const controls = wrapPreviewText(confirming
    ? "y Confirm · Esc Back · n Deny"
    : `y Allow once${grantControl} · n/Esc Deny`, width);
  const changed = request.previewChanged && !confirming;
  const changedTarget = request.preview?.kind === "command" ? "Working directory" : "File";
  // Borders, heading, target, page label and keys stay visible. Keep a spare
  // row so Ink can redraw the live panel without clearing the scrollback.
  const pageSize = Math.max(1, rows - 6 - controls.length - (changed ? 1 : 0));
  const pages = Math.max(1, Math.ceil(wrappedRows.length / pageSize));
  const current = Math.min(confirming ? confirmPage : page, pages - 1);

  useInput((input, key) => {
    const choice = input.toLowerCase();
    if (key.ctrl && choice === "c") {
      onInterrupt();
      return;
    }
    if ((key.ctrl || key.meta) && !key.escape) return;
    if (key.leftArrow || key.rightArrow) {
      const next = Math.max(0, Math.min(current + (key.leftArrow ? -1 : 1), pages - 1));
      (confirming ? setConfirmPage : setPage)(next);
    } else if (key.escape && confirming) {
      setConfirming(false);
    } else if (key.escape || choice === "n") {
      onDecision("deny");
    } else if (choice === "y") {
      onDecision(confirming ? "allow-session" : "allow");
    } else if (choice === "a" && canGrantProcess && !confirming) {
      setConfirmPage(0);
      setConfirming(true);
    }
  });

  return (
    <Box width="100%" flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow" wrap="truncate-end">
        {confirming ? "Confirm tool permission" : `Waiting for approval · ${visiblePreviewText(preview.title)}`}
      </Text>
      <Text wrap="truncate-middle">{visiblePreviewText(preview.target).replace(/\n/g, "\\n")}</Text>
      {changed ? <Text color="yellow" wrap="truncate-end">{changedTarget} changed. Review the updated preview.</Text> : null}
      {wrappedRows.slice(current * pageSize, (current + 1) * pageSize).map((row, index) => (
        <Text key={index} color={colors[row.tone]} wrap="truncate-end">{row.text || " "}</Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {`Page ${current + 1}/${pages}${pages > 1 ? " · ←/→ Browse" : ""}`}
      </Text>
      {controls.map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line}</Text>)}
    </Box>
  );
}
