import MarkdownIt from "markdown-it";
import { webLink } from "./links.js";

const markdown = new MarkdownIt({ html: false });
markdown.validateLink = (value) => webLink(value) !== undefined;
// Use the alt text and keep external content out of the conversation view.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]!.content);
markdown.renderer.rules.table_open = () => '<div class="markdown-table"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";
for (const tag of ["th_open", "td_open"] as const) {
  markdown.renderer.rules[tag] = (tokens, index, options, _env, renderer) => {
    const token = tokens[index]!;
    const style = token.attrIndex("style");
    if (style !== -1) {
      const value = token.attrs?.splice(style, 1)[0]?.[1];
      const alignment = typeof value === "string" ? /^text-align:(left|center|right)$/.exec(value)?.[1] : undefined;
      if (alignment) token.attrSet("class", `align-${alignment}`);
    }
    return renderer.renderToken(tokens, index, options);
  };
}

export function renderMarkdown(source: string): string {
  return markdown.render(source);
}
