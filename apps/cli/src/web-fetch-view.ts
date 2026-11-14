import { visiblePreviewText } from "./preview.js";

/** The model receives the full JSON. The terminal shows its outcome first. */
export function webFetchOutput(name: string, output: string): string {
  if (name !== "web_fetch") return output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (!parsed || typeof parsed !== "object") return output;
  const value = parsed as Record<string, unknown>;
  if (!["ok", "no_static_text", "empty_body", "empty_text", "redirect", "error"].some((status) => status === value.status)) {
    return output;
  }
  const status = typeof value.httpStatus === "number" ? `HTTP ${value.httpStatus}` : undefined;
  const type = typeof value.contentType === "string" ? value.contentType : undefined;
  const message = typeof value.message === "string" ? value.message
    : value.status === "ok" ? value.truncated === true ? "Text retrieved (truncated)." : "Text retrieved."
      : undefined;
  if (!message) return output;
  const title = typeof value.title === "string" && value.title ? value.title : undefined;
  const destination = typeof value.redirectUrl === "string" ? `Redirect to ${value.redirectUrl}` : undefined;
  const detail = typeof value.content === "string" && value.status === "ok" ? value.content : undefined;
  const url = typeof value.url === "string" ? value.url : undefined;
  return [
    [status, message].filter(Boolean).join(" · "), title,
    [type, url].filter(Boolean).join(" · "), destination, detail,
  ].filter((line): line is string => Boolean(line)).map(visiblePreviewText).join("\n");
}
