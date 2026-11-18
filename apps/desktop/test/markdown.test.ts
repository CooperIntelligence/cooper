import { expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown.js";

it("renders structural Markdown and handles wide tables without inline styles", () => {
  const result = renderMarkdown([
    "## Result", "", "- **Ready**", "", "```ts", "const value = 3;", "```", "",
    "| Name | Size |", "| --- | ---: |", "| Item | 3 |", "", "[Docs](https://example.com/)",
  ].join("\n"));
  expect(result).toContain("<h2>Result</h2>");
  expect(result).toContain("<li><strong>Ready</strong></li>");
  expect(result).toContain('<pre><code class="language-ts">const value = 3;');
  expect(result).toContain('<div class="markdown-table"><table>');
  expect(result).toContain('<td class="align-right">3</td>');
  expect(result).toContain('<a href="https://example.com/">Docs</a>');
  expect(result).not.toContain("style=");
});

it("escapes raw HTML and displays image labels without fetching them", () => {
  const result = renderMarkdown(
    '<script>alert(1)</script>\n\n![Preview](https://example.com/image.png)\n\n[Run](javascript:alert%281%29)\n\n[File](file:///tmp/example)',
  );
  expect(result).toContain("&lt;script&gt;");
  expect(result).toContain("Preview");
  expect(result).not.toMatch(/<script|<img|<a /);
});
