/**
 * Just enough Markdown for shared/srd/NOTICE.md on the About page:
 * headings, paragraphs, `- ` lists, `code`, [links](https://...) and bare
 * https URLs. The notice must appear verbatim (design 20), so the parser
 * only splits the text into blocks and spans and never rewrites a word.
 * It builds data, not HTML, so React escapes every character it renders.
 */

export type Inline = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; items: Inline[][] };

const INLINE = /`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|(https:\/\/[^\s)]+)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (part: Inline) => {
    const prev = out[out.length - 1];
    if (part.kind === "text" && prev?.kind === "text") prev.text += part.text;
    else if (part.kind !== "text" || part.text !== "") out.push(part);
  };
  for (const m of text.matchAll(INLINE)) {
    const at = m.index;
    push({ kind: "text", text: text.slice(last, at) });
    if (m[1] !== undefined) push({ kind: "code", text: m[1] });
    else if (m[2] !== undefined && m[3] !== undefined) push({ kind: "link", text: m[2], href: m[3] });
    else if (m[4] !== undefined) {
      // A sentence that ends in a URL keeps its full stop out of the link.
      const url = m[4].replace(/[.,;:]+$/, "");
      push({ kind: "link", text: url, href: url });
      push({ kind: "text", text: m[4].slice(url.length) });
    }
    last = at + m[0].length;
  }
  push({ kind: "text", text: text.slice(last) });
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join(" ")) });
    if (list.length > 0) blocks.push({ kind: "list", items: list.map(parseInline) });
    paragraph = [];
    list = [];
  };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (line === "") {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, inline: parseInline(heading[2]!) });
    } else if (line.startsWith("- ")) {
      if (paragraph.length > 0) flush();
      list.push(line.slice(2));
    } else if (list.length > 0) {
      // A wrapped list item continues on the next line.
      list[list.length - 1] += ` ${line}`;
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** The plain text of some spans, as a reader would copy it. */
export function plainText(inline: Inline[]): string {
  return inline.map((p) => p.text).join("");
}
