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
 * The DM guide (docs/dm-guide.md, served at /docs/dm-guide) is written
 * for GitHub and the app alike, so the `guide` option adds what it uses on
 * top of the journal's: `` `code` ``, an image alone on its line
 * (`![alt](dm-guide/x.webp)`, a relative path the page maps to a bundled
 * file), links to the page's own headings (`[Areas](#areas)`), headings
 * with ids spelled the way GitHub spells them, bullets one level under a
 * list item, and GitHub's alerts: a quote whose first line is `[!TIP]` or
 * `[!NOTE]` alone, which GitHub draws as a callout and so does the app. A
 * link to any other relative address keeps only its text, since the files
 * it names are not part of the app.
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
  /** An https link (journal only), or `#id` to a heading on the page (guide only). Its text never holds another link. */
  | { kind: "link"; href: string; children: Inline[] }
  /** A key, a formula or anything else typed as it is (guide only). */
  | { kind: "code"; text: string };

export type Block =
  /** `id` is the heading's anchor (guide only). */
  | { kind: "heading"; level: 1 | 2 | 3; content: Inline[]; id?: string }
  | { kind: "paragraph"; content: Inline[] }
  /**
   * `start` marks a numbered list (journal only), counting from that
   * number. `sub` holds each item's own bullets by the item's index (guide
   * only), an empty list where an item has none.
   */
  | { kind: "list"; items: Inline[][]; start?: number; sub?: Inline[][][] }
  /** An image on a line of its own (guide only). `src` is the relative path as written, for the page to map. */
  | { kind: "image"; src: string; alt: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  /** Lines that start with `>` (journal only), parsed again as blocks of their own. `alert` marks GitHub's alert syntax (guide only). */
  | { kind: "quote"; blocks: Block[]; alert?: GuideAlert };

/** The kinds of GitHub alert the guide uses: a tip that saves the reader time, and a note of something easy to miss. */
export type GuideAlert = "tip" | "note";

export type MarkdownOptions = {
  /** The journal's additions (see above). */
  journal?: boolean;
  /** The DM guide's additions (see above), which take in the journal's. */
  guide?: boolean;
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

/** The guide's links: the same shape with any address, which guideHref then sorts out. */
const GUIDE_LINK = /^\[([^[\]\n]{1,300})\]\(([^\s()<>"'`]{1,2000})\)/;

/** A heading's anchor on the same page, as headingSlug spells one. */
const ANCHOR = /^#[\p{L}\p{M}\p{N}_-]{1,200}$/u;

/** An image on its own line. The path is relative, with no scheme and no query, so it can only name a file the page bundles. */
const IMAGE = /^!\[([^[\]\n]{0,300})\]\(([A-Za-z0-9_./-]{1,300})\)$/;

/**
 * The first line of a quote that makes it an alert, as GitHub reads it:
 * the marker alone, in any case. GitHub has three more kinds, which the
 * guide does not use, so they stay plain quotes that show the marker.
 */
const ALERT = /^\[!(TIP|NOTE)\]$/i;

/** A bullet under a list item, indented two spaces or more (guide only). */
const NESTED = /^ {2,}- (.*)$/;

/** Where a guide link may go: a heading on the page, or an https address. Null keeps only the text. */
function guideHref(raw: string): string | null {
  return ANCHOR.test(raw) ? raw : safeLinkHref(raw);
}

/**
 * A heading's anchor as GitHub spells it, so a link to a section works on
 * GitHub and in the app alike: lower case, punctuation dropped, spaces
 * turned to hyphens. A second heading with the same text gets "-1", a
 * third "-2". `seen` counts the anchors so far on the page.
 */
export function headingSlug(text: string, seen: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

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
  | { kind: "link"; href: string; text: string }
  | { kind: "code"; text: string };

function tokenize(s: string, journal: boolean, links: boolean, guide: boolean): Token[] {
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
    } else if (c === "`" && guide && codeEnd(s, i) !== -1) {
      const end = codeEnd(s, i);
      flush();
      out.push({ kind: "code", text: s.slice(i + 1, end) });
      i = end;
    } else if (c === "[" && links) {
      const m = (guide ? GUIDE_LINK : LINK).exec(s.slice(i, i + 2_400));
      const href = m ? (guide ? guideHref(m[2]!) : safeLinkHref(m[2]!)) : null;
      if (m && href) {
        flush();
        out.push({ kind: "link", href, text: m[1]! });
        i += m[0].length - 1;
      } else if (m && guide) {
        // A link to a file of the repository: its text stays, and nothing links.
        flush();
        out.push(...tokenize(m[1]!, journal, false, guide));
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

/** Where the code span opened by the backtick at `open` closes, on the same line and not empty, or -1 for a lone backtick, which stays literal. */
function codeEnd(s: string, open: number): number {
  const end = s.indexOf("`", open + 1);
  return end > open + 1 && !s.slice(open + 1, end).includes("\n") ? end : -1;
}

function pushText(list: Inline[], text: string): void {
  const last = list[list.length - 1];
  if (last?.kind === "text") last.text += text;
  else list.push({ kind: "text", text });
}

/** Inline emphasis, and with the journal option line breaks and links. A marker with no partner stays as the literal asterisks. */
export function parseInline(s: string, options: MarkdownOptions = {}): Inline[] {
  const guide = options.guide === true;
  const journal = options.journal === true || guide;
  return parseTokens(tokenize(s, journal, journal, guide), journal, guide);
}

function parseTokens(tokens: Token[], journal: boolean, guide: boolean): Inline[] {
  type Frame = { marker: "*" | "**" | null; children: Inline[] };
  const stack: Frame[] = [{ marker: null, children: [] }];
  for (const token of tokens) {
    const top = stack[stack.length - 1]!;
    if (token.kind === "text") {
      pushText(top.children, token.text);
    } else if (token.kind === "break") {
      top.children.push({ kind: "break" });
    } else if (token.kind === "code") {
      top.children.push({ kind: "code", text: token.text });
    } else if (token.kind === "link") {
      // A link's own text is parsed for emphasis, never for another link.
      top.children.push({ kind: "link", href: token.href, children: parseTokens(tokenize(token.text, journal, false, guide), journal, guide) });
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
  return parseBlocks(text, options, 0, new Map());
}

function parseBlocks(text: string, options: MarkdownOptions, depth: number, slugs: Map<string, number>): Block[] {
  const guide = options.guide === true;
  const journal = options.journal === true || guide;
  const blocks: Block[] = [];
  let paragraph: string[] | null = null;
  let list: { items: Inline[][]; start?: number; sub: Inline[][][] } | null = null;
  let table: { header: Inline[][]; rows: Inline[][][] } | null = null;
  let quote: string[] | null = null;
  const inline = (s: string) => parseInline(s, options);

  const flush = () => {
    // A journal keeps a paragraph's single line breaks. The SRD's text wraps lines that belong together.
    if (paragraph) blocks.push({ kind: "paragraph", content: inline(paragraph.join(journal ? "\n" : " ")) });
    if (list) {
      const sub = list.sub.some((items) => items.length > 0) ? { sub: list.sub } : null;
      blocks.push(list.start === undefined ? { kind: "list", items: list.items, ...sub } : { kind: "list", items: list.items, start: list.start, ...sub });
    }
    if (table) blocks.push({ kind: "table", header: table.header, rows: table.rows });
    if (quote) blocks.push(quoteBlock(quote, options, depth, slugs));
    paragraph = null;
    list = null;
    table = null;
    quote = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const quoted = journal && depth < MAX_QUOTE_DEPTH ? QUOTED.exec(line) : null;
    const numbered = journal ? NUMBERED.exec(line) : null;
    const nested = guide && list && list.items.length > 0 ? NESTED.exec(line) : null;
    const image = guide ? IMAGE.exec(line) : null;
    if (quoted) {
      if (!quote) {
        flush();
        quote = [];
      }
      quote.push(quoted[1]!);
    } else if (line.trim() === "") {
      flush();
    } else if (nested && list) {
      list.sub[list.items.length - 1]!.push(inline(nested[1]!.trim()));
    } else if (image) {
      flush();
      blocks.push({ kind: "image", src: image[2]!, alt: image[1]! });
    } else if (line.startsWith("### ") || line.startsWith("## ") || (journal && line.startsWith("# "))) {
      flush();
      const level = line.startsWith("### ") ? 3 : line.startsWith("## ") ? 2 : 1;
      const content = inline(line.slice(level + 1).trim());
      blocks.push(guide ? { kind: "heading", level, content, id: headingSlug(inlineText(content), slugs) } : { kind: "heading", level, content });
    } else if (line.startsWith("- ")) {
      if (!list || list.start !== undefined) {
        flush();
        list = { items: [], sub: [] };
      }
      list.items.push(inline(line.slice(2).trim()));
      list.sub.push([]);
    } else if (numbered) {
      if (!list || list.start === undefined) {
        flush();
        list = { items: [], start: Number(numbered[1]), sub: [] };
      }
      list.items.push(inline(numbered[2]!.trim()));
      list.sub.push([]);
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

/** A quote, or a guide's alert when its first line is the marker and more follows. GitHub reads no alert inside another quote, so neither does this. */
function quoteBlock(lines: string[], options: MarkdownOptions, depth: number, slugs: Map<string, number>): Block {
  const alert = options.guide === true && depth === 0 ? ALERT.exec(lines[0]!.trim()) : null;
  const body = lines.slice(1);
  if (alert && body.some((line) => line.trim() !== "")) {
    return { kind: "quote", blocks: parseBlocks(body.join("\n"), options, depth + 1, slugs), alert: alert[1]!.toLowerCase() as GuideAlert };
  }
  return { kind: "quote", blocks: parseBlocks(lines.join("\n"), options, depth + 1, slugs) };
}

const MODIFIER_KEYS = new Set(["Ctrl", "Cmd", "Shift", "Alt", "Option"]);
const NAMED_KEYS = new Set([...MODIFIER_KEYS, "Esc", "Escape", "Enter", "Return", "Tab", "Space", "Delete", "Backspace", "Home", "End", "Page Up", "Page Down"]);

/**
 * The keys a guide's code span names, drawn as keycaps: a single character
 * (`N`, `?`, `0`), a key's name (`Escape`), or a chord of modifiers and a
 * key (`Ctrl+Shift+Z`). Null for anything else, which stays code: a search
 * (`goblin`), a formula (`8d6 fire`), an entry (`-7`), a file name. The
 * guide writes keys this way already, so it needs no markup of its own.
 */
export function keyChord(text: string): string[] | null {
  if (isKey(text)) return [text];
  const parts = text.split("+");
  const key = parts.pop()!;
  return parts.length > 0 && parts.every((p) => MODIFIER_KEYS.has(p)) && isKey(key) ? [...parts, key] : null;
}

function isKey(s: string): boolean {
  return ([...s].length === 1 && s.trim() !== "") || NAMED_KEYS.has(s);
}

/** The plain text of inline content, for labels and tests. A break reads as a space. */
export function inlineText(content: Inline[]): string {
  return content.map((n) => (n.kind === "text" || n.kind === "code" ? n.text : n.kind === "break" ? " " : inlineText(n.children))).join("");
}
