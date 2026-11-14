import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { webUrl } from "./web-http.js";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

function findElement(root: Node, tag: string): Element | undefined {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === tag) return node;
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        pending.push(node.childNodes[index]!);
      }
    }
  }
}

const SKIP = new Set(["script", "style", "template", "head", "nav", "footer", "aside", "svg"]);
const BLOCK = new Set(["p", "section", "div", "article", "main", "blockquote", "ul", "ol", "dl", "dt", "dd"]);

export const MAX_WEB_CONTENT = 16_000;

function render(node: Node, url: URL, depth = 0, preserveWhitespace = false): string {
  if (depth > 128) return " [deeply nested content omitted] ";
  if ("value" in node) return preserveWhitespace ? node.value : node.value.replace(/\s+/g, " ");
  if (!("childNodes" in node)) return "";
  const tag = "tagName" in node ? node.tagName : "";
  if (SKIP.has(tag) || ("attrs" in node && node.attrs.some(({ name }) => name === "hidden"))) return "";
  const raw = preserveWhitespace || tag === "pre" || tag === "code";
  let children = "";
  for (const child of node.childNodes) {
    children += render(child, url, depth + 1, raw);
    if (children.length > MAX_WEB_CONTENT) break;
  }
  if (preserveWhitespace) return tag === "br" ? "\n" : children;
  if (tag === "pre" || tag === "code") {
    // Choose a delimiter longer than runs of backticks in the source.
    let longest = 0;
    for (const match of children.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    const fence = "`".repeat(Math.max(tag === "pre" ? 3 : 1, longest + 1));
    if (tag === "pre") return `\n\n${fence}\n${children.trimEnd()}\n${fence}\n\n`;
    const padding = children.startsWith("`") || children.endsWith("`") ? " " : "";
    return `${fence}${padding}${children}${padding}${fence}`;
  }
  const text = children.trim();
  if (tag === "br") return "\n";
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text}\n\n`;
  if (tag === "li") return `\n- ${text}\n`;
  if (tag === "a" && "attrs" in node) {
    const href = node.attrs.find(({ name }) => name === "href")?.value;
    if (!href || !text) return children;
    try {
      const target = webUrl(new URL(href, url).href, { keepFragment: true });
      return `[${text}](<${target.href.replaceAll(">", "%3E")}>)`;
    } catch {
      return children;
    }
  }
  if (tag === "th" || tag === "td") return ` ${text.replace(/\s*\n\s*/g, " ").replaceAll("|", "\\|")} |`;
  if (tag === "tr") return `\n| ${text}\n`;
  if (tag === "table") {
    const rows = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const columns = findElement(node, "tr")?.childNodes
      .filter((child) => "tagName" in child && ["td", "th"].includes(child.tagName)).length ?? 0;
    if (columns === 0) return `\n\n${text}\n\n`;
    return `\n\n${rows[0]}\n|${" --- |".repeat(Math.min(columns, MAX_WEB_CONTENT))}\n${rows.slice(1).join("\n")}\n\n`;
  }
  return BLOCK.has(tag) ? `\n\n${text}\n\n` : children;
}

export function extractWebHtml(html: string, url: URL): { title: string; content: string } {
  const document = parse(html);
  const title = findElement(document, "title");
  const body = findElement(document, "body") ?? document;
  const main = findElement(body, "main");
  const mainContent = main ? render(main, url).trim() : "";
  return {
    title: title ? render(title, url).trim() : "",
    content: mainContent || render(body, url).trim(),
  };
}
