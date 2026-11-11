type InlineSpan = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
};

export type MarkdownLine =
  | { kind: "text" | "heading"; spans: InlineSpan[] }
  | { kind: "list"; prefix: string; spans: InlineSpan[] }
  | { kind: "code"; text: string }
  | { kind: "code-label"; text: string };

// Each alternative consumes one complete inline construct on the current line.
const inlineTokens = new RegExp(
  [
    /\\(?<escaped>[!"#$%&'()*+,\-./:;<=>?@[\]\\^`_{|}~])/.source,
    /(?<!`)(?<ticks>`+)(?!`)(?<code>.+?)(?<!`)\k<ticks>(?!`)/.source,
    /(?<!\*)(?<stars>\*\*|\*)(?![\s*])(?<starText>.+?)(?<![\s*])\k<stars>(?!\*)/.source,
    /(?<![\p{L}\p{N}_])(?<underscores>__|_)(?![\s_])(?<underscoreText>.+?)(?<![\s_])\k<underscores>(?![\p{L}\p{N}_])/u.source,
  ].join("|"),
  "gu",
);

function inlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let offset = 0;

  for (const match of text.matchAll(inlineTokens)) {
    if (match.index > offset) {
      spans.push({ text: text.slice(offset, match.index) });
    }
    const { escaped, code, stars, starText, underscores, underscoreText } =
      match.groups ?? {};
    if (escaped !== undefined) {
      spans.push({ text: escaped });
    } else if (code !== undefined) {
      const trimPadding =
        code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0;
      spans.push({ text: trimPadding ? code.slice(1, -1) : code, code: true });
    } else {
      const style = (stars ?? underscores)?.length === 2 ? "bold" : "italic";
      for (const span of inlineSpans(starText ?? underscoreText ?? "")) {
        spans.push({ ...span, [style]: true });
      }
    }
    offset = match.index + match[0].length;
  }

  if (offset < text.length) spans.push({ text: text.slice(offset) });
  return spans;
}

/**
 * Format complete lines without revisiting scrollback. A new formatter starts
 * each assistant message so an unclosed fence cannot affect the next reply.
 */
export function createMarkdownFormatter(): (line: string) => MarkdownLine | null {
  let fence: string | undefined;

  return (line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);

    if (fence !== undefined) {
      const delimiter = marker?.[1];
      if (
        delimiter !== undefined &&
        delimiter.startsWith(fence) &&
        marker?.[2]?.trim() === ""
      ) {
        fence = undefined;
        return null;
      }
      return { kind: "code", text: line };
    }

    if (marker?.[1] !== undefined) {
      const info = (marker[2] ?? "").trim();
      if (!marker[1].startsWith("`") || !info.includes("`")) {
        fence = marker[1];
        const language = info.split(/\s+/, 1)[0];
        return { kind: "code-label", text: language || "Code" };
      }
    }

    const heading = /^ {0,3}#{1,6}[\t ]+(.*)$/.exec(line);
    if (heading?.[1] !== undefined) {
      const content = heading[1].replace(/[\t ]+#+[\t ]*$/, "");
      return { kind: "heading", spans: inlineSpans(content) };
    }

    const list = /^( {0,3})([-+*]|\d{1,9}[.)])[\t ]+/.exec(line);
    if (list?.[2] !== undefined) {
      const marker = list[2].length === 1 ? "•" : list[2];
      const prefix = `${list[1]}${marker} `;
      return {
        kind: "list",
        prefix,
        spans: inlineSpans(line.slice(list[0].length)),
      };
    }
    return { kind: "text", spans: inlineSpans(line) };
  };
}
