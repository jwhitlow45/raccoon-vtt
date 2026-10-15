/**
 * A parser for the small Markdown subset of the SRD text in shared/srd
 * (documented in shared/srd/monsters.ts): `## ` and `### ` headings,
 * paragraphs, `- ` lists, one pipe table, `**bold**`, `*italic*`, and a
 * backslash escaping `*`, `_`, `` ` `` or `\`.
 *
 * Journal pages (docs/design-v1-dm-tools.md 3.7) are written by hand, so
 * they ask for a little more, behind the `journal` option the stat blocks
 * never set: single line breaks kept as breaks, numbered lists, quotes
 * (`> `), a `# ` heading, and links `[text](https://…)`. A link must be
 * https: anything else, an `http:` or `javascript:` one included, stays
 * as the literal text. No images, since handouts already show pictures.
 *
 * It produces a tree, never HTML, so Markdown.tsx renders it as React
 * elements and nothing in the text can become markup. Anything outside the
 * subset is shown as the literal characters.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  /** A single line break inside a paragraph (journal only). */
  | { kind: "break" }
  /** An https link (journal only). Its text never holds another link. */
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  /** `start` marks a numbered list (journal only), counting from that number. */
  | { kind: "list"; items: Inline[][]; start?: number }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  /** Lines that start with `>` (journal only), parsed again as blocks of their own. */
  | { kind: "quote"; blocks: Block[] };

export type MarkdownOptions = {
  /** The journal's additions (see above). */
  journal?: boolean;
};

const ESCAPABLE = new Set(["*", "_", "`", "\\"]);
/** A journal may also escape what would start a link, a heading, a quote or a list. */
const JOURNAL_ESCAPABLE = new Set([...ESCAPABLE, "[", "]", "#", ">", "-", "."]);

/** Quotes inside quotes stop nesting here, so a page of `>` cannot build a tower of boxes. */
const MAX_QUOTE_DEPTH = 3;

/**
 * `[text](https://…)` at the start of a string. The text holds no
 * brackets or line breaks, and the address no spaces, brackets or quotes,
 * so a link always ends where a reader expects.
 */
const LINK = /^\[([^[\]\n]{1,300})\]\((https:\/\/[^\s()<>"'`]{1,2000})\)/;

/** An address a link may open: https, with a host, as the browser itself reads it. Null for anything else. */
export function safeLinkHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname !== "" ? url.href : null;
  } catch {
    return null;
  }
}

type Token =
  | { kind: "text"; text: string }
  | { kind: "marker"; marker: "*" | "**" }
  | { kind: "break" }
  | { kind: "link"; href: string; text: string };

function tokenize(s: string, journal: boolean, links: boolean): Token[] {
  const out: Token[] = [];
  const escapable = journal ? JOURNAL_ESCAPABLE : ESCAPABLE;
  let text = "";
  const flush = () => {
    if (text) out.push({ kind: "text", text });
    text = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const next = s[i + 1];
    if (c === "\\" && next !== undefined && escapable.has(next)) {
      text += next;
      i++;
    } else if (c === "*" && next === "*") {
      flush();
      out.push({ kind: "marker", marker: "**" });
      i++;
    } else if (c === "*") {
      flush();
      out.push({ kind: "marker", marker: "*" });
    } else if (c === "\n" && journal) {
      flush();
      out.push({ kind: "break" });
    } else if (c === "[" && links) {
      const m = LINK.exec(s.slice(i, i + 2_400));
      const href = m ? safeLinkHref(m[2]!) : null;
      if (m && href) {
        flush();
        out.push({ kind: "link", href, text: m[1]! });
        i += m[0].length - 1;
      } else {
        text += c;
      }
    } else {
      text += c;
    }
  }
  flush();
  return out;
}

function pushText(list: Inline[], text: string): void {
  const last = list[list.length - 1];
  if (last?.kind === "text") last.text += text;
  else list.push({ kind: "text", text });
}

/** Inline emphasis, and with the journal option line breaks and links. A marker with no partner stays as the literal asterisks. */
export function parseInline(s: string, options: MarkdownOptions = {}): Inline[] {
  const journal = options.journal === true;
  return parseTokens(tokenize(s, journal, journal), journal);
}

function parseTokens(tokens: Token[], journal: boolean): Inline[] {
  type Frame = { marker: "*" | "**" | null; children: Inline[] };
  const stack: Frame[] = [{ marker: null, children: [] }];
  for (const token of tokens) {
    const top = stack[stack.length - 1]!;
    if (token.kind === "text") {
      pushText(top.children, token.text);
    } else if (token.kind === "break") {
      top.children.push({ kind: "break" });
    } else if (token.kind === "link") {
      // A link's own text is parsed for emphasis, never for another link.
      top.children.push({ kind: "link", href: token.href, children: parseTokens(tokenize(token.text, journal, false), journal) });
    } else if (top.marker === token.marker) {
      stack.pop();
      const parent = stack[stack.length - 1]!;
      if (top.children.length > 0) parent.children.push({ kind: token.marker === "**" ? "bold" : "italic", children: top.children });
      else pushText(parent.children, token.marker + token.marker);
    } else {
      stack.push({ marker: token.marker, children: [] });
    }
  }
  // Unclosed markers fold back into their parent as plain text.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    const parent = stack[stack.length - 1]!;
    pushText(parent.children, frame.marker ?? "");
    for (const child of frame.children) {
      if (child.kind === "text") pushText(parent.children, child.text);
      else parent.children.push(child);
    }
  }
  return stack[0]!.children;
}

function cells(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((c) => c.trim());
}

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
const NUMBERED = /^(\d{1,9})[.)] (.*)$/;
const QUOTED = /^>\s?(.*)$/;

export function parseMarkdown(text: string, options: MarkdownOptions = {}): Block[] {
  return parseBlocks(text, options, 0);
}

function parseBlocks(text: string, options: MarkdownOptions, depth: number): Block[] {
  const journal = options.journal === true;
  const blocks: Block[] = [];
  let paragraph: string[] | null = null;
  let list: { items: Inline[][]; start?: number } | null = null;
  let table: { header: Inline[][]; rows: Inline[][][] } | null = null;
  let quote: string[] | null = null;
  const inline = (s: string) => parseInline(s, options);

  const flush = () => {
    // A journal keeps a paragraph's single line breaks. The SRD's text wraps lines that belong together.
    if (paragraph) blocks.push({ kind: "paragraph", content: inline(paragraph.join(journal ? "\n" : " ")) });
    if (list) blocks.push(list.start === undefined ? { kind: "list", items: list.items } : { kind: "list", items: list.items, start: list.start });
    if (table) blocks.push({ kind: "table", header: table.header, rows: table.rows });
    if (quote) blocks.push({ kind: "quote", blocks: parseBlocks(quote.join("\n"), options, depth + 1) });
    paragraph = null;
    list = null;
    table = null;
    quote = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const quoted = journal && depth < MAX_QUOTE_DEPTH ? QUOTED.exec(line) : null;
    const numbered = journal ? NUMBERED.exec(line) : null;
    if (quoted) {
      if (!quote) {
        flush();
        quote = [];
      }
      quote.push(quoted[1]!);
    } else if (line.trim() === "") {
      flush();
    } else if (line.startsWith("### ") || line.startsWith("## ") || (journal && line.startsWith("# "))) {
      flush();
      const level = line.startsWith("### ") ? 3 : line.startsWith("## ") ? 2 : 1;
      blocks.push({ kind: "heading", level, content: inline(line.slice(level + 1).trim()) });
    } else if (line.startsWith("- ")) {
      if (!list || list.start !== undefined) {
        flush();
        list = { items: [] };
      }
      list.items.push(inline(line.slice(2).trim()));
    } else if (numbered) {
      if (!list || list.start === undefined) {
        flush();
        list = { items: [], start: Number(numbered[1]) };
      }
      list.items.push(inline(numbered[2]!.trim()));
    } else if (line.trimStart().startsWith("|")) {
      if (!table) {
        flush();
        table = { header: cells(line).map(inline), rows: [] };
      } else if (!SEPARATOR.test(line.trim())) {
        table.rows.push(cells(line).map(inline));
      }
    } else {
      if (!paragraph) {
        flush();
        paragraph = [];
      }
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}

/** The plain text of inline content, for labels and tests. A break reads as a space. */
export function inlineText(content: Inline[]): string {
  return content.map((n) => (n.kind === "text" ? n.text : n.kind === "break" ? " " : inlineText(n.children))).join("");
}
