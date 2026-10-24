// INSTRUCTIONS.md → HTML for the Instructions screen (BUILD_PLAN §10.5). Pure.
// Values are bound first (escaped), raw HTML in the source is shown as text, headings get the stable ids
// other screens link to (#assumptions, #what-to-do-when, …), and each ⚙ says where the value comes from.
import { Marked, type Tokens } from "marked";
import { bindInstructions, headingId } from "./bind";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderInstructions(markdown: string, params: unknown): { html: string; errors: string[] } {
  const bound = bindInstructions(markdown, params);
  const marked = new Marked({ gfm: true, async: false });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth, text }: Tokens.Heading) {
        return `<h${depth} id="${headingId(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
    },
  });
  const html = (marked.parse(bound.text) as string).replace(/⚙/g, '<span class="gear" title="Read live from Settings › Rules">⚙</span>');
  return { html, errors: bound.errors };
}
