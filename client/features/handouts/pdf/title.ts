import { MAX_NAME, textSchemas } from "#shared/protocol.ts";
import { titleFromFileName } from "../handouts.ts";

/**
 * A PDF handout's title (docs/design-v1-pdf-handouts.md 4.1.3). Every source
 * goes through one cleaner, so a generated title always passes the
 * protocol's `name` rules, and what the DM types is checked against those
 * rules as they type.
 */

/** What the `name` schema refuses: control characters and line or paragraph separators, which become spaces. */
const BREAKS = /[\p{Cc}\u2028\u2029]/gu;
/** Text direction marks, which could make one name pass for another, dropped. */
const DIRECTION = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
/** Half a surrogate pair, as a title cut short elsewhere may end with. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** What Office's PDF export puts before a document's name. */
const OFFICE_PREFIX = /^Microsoft (Word|PowerPoint|Excel) -( |$)/i;
/** A file extension left at the end of a title, as an export from a word processor leaves it. */
const DOCUMENT_EXTENSION = /\.(docx?|pdf|odt|pages)$/i;

/**
 * A title the `name` schema takes, or "" when nothing is left: the
 * characters it refuses gone, whitespace collapsed, an Office prefix and a
 * document's extension dropped, and at most MAX_NAME UTF-16 units, never
 * ending in half a character.
 */
export function cleanTitle(raw: string): string {
  let text = raw.replace(BREAKS, " ").replace(DIRECTION, "").replace(LONE_SURROGATE, "").replace(/\s+/g, " ").trim();
  text = text.replace(OFFICE_PREFIX, "").replace(DOCUMENT_EXTENSION, "").trim();
  if (text.length > MAX_NAME) {
    const cut = text.charCodeAt(MAX_NAME - 1);
    // A high surrogate as the last unit kept would be half a character.
    text = text.slice(0, cut >= 0xd800 && cut <= 0xdbff ? MAX_NAME - 1 : MAX_NAME).trim();
  }
  return text;
}

/** A PDF's own title worth keeping: not empty, not a placeholder, and not a file path. */
function usable(title: string): boolean {
  return title !== "" && !/^untitled( document)?$/i.test(title) && !/[/\\]/.test(title);
}

/**
 * The title a PDF's upload starts with: its XMP `dc:title`, else its Info
 * `Title`, else the file's name, else "Handout".
 */
export function pdfTitle(found: { xmp: string | null; info: string | null }, fileName: string): string {
  for (const source of [found.xmp, found.info]) {
    if (source === null) continue;
    const title = cleanTitle(source);
    if (usable(title)) return title;
  }
  return cleanTitle(titleFromFileName(fileName)) || "Handout";
}

/** Why a typed title cannot be saved yet, in words for beside the field, or null when it can. */
export function titleProblem(title: string): string | null {
  if (title.trim() === "") return "Give the handout a title.";
  const parsed = textSchemas.name.safeParse(title.trim());
  if (parsed.success) return null;
  if (parsed.error.issues.some((issue) => issue.code === "too_big")) return `A title is at most ${MAX_NAME} characters.`;
  return "A title cannot hold line breaks, control or text direction characters.";
}
