import { inlineText, type Block, type Inline } from "../../components/markdown.ts";

/**
 * The DM guide as a book: its opening, its contents, and its parts with
 * their sections, read from the headings of the parsed guide, so the
 * page's contents and outline never drift from the text.
 *
 * docs/dm-guide.md reads on GitHub as a page of `#` parts and `##`
 * sections under a markdown `## Contents` list. The app draws its own
 * contents from this outline in that list's place, numbers the parts and
 * their sections, and keeps every heading's id, the anchor a Guide link
 * opens.
 */
export type GuideOutline = {
  /** What comes before the contents: the guide's introduction. */
  intro: Block[];
  /** The `##` sections between the contents and the first part, such as the Quick start. They take no number. */
  opening: GuideSection[];
  parts: GuidePart[];
};

export type GuidePart = {
  id: string;
  /** From 1, in the guide's order. */
  number: number;
  title: Inline[];
  /** The paragraphs under the part's heading, before its first section. */
  intro: Block[];
  /** The intro's first sentence, which the contents shows under the part's name. Null when the part has no intro. */
  summary: string | null;
  /** The part of worked examples, drawn as examples. */
  examples: boolean;
  sections: GuideSection[];
};

export type GuideSection = {
  id: string;
  /** "2.5" for a part's fifth section, null for an opening one. */
  number: string | null;
  title: Inline[];
  /** Everything under the heading up to the next section or part, its own `###` subsections included. */
  body: Block[];
};

/** The heading id of the guide's markdown contents list, which the page replaces with its own. Its id stays the target of the page's Contents links. */
export const CONTENTS_ID = "contents";

/** The heading id of the part of worked examples. Heading ids are fixed, since Guide links open them. */
export const EXAMPLES_ID = "scenarios";

export function guideOutline(blocks: readonly Block[]): GuideOutline {
  const outline: GuideOutline = { intro: [], opening: [], parts: [] };
  let part: GuidePart | null = null;
  let section: GuideSection | null = null;
  let inContents = false;
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === 1 && block.id) {
      inContents = false;
      section = null;
      part = { id: block.id, number: outline.parts.length + 1, title: block.content, intro: [], summary: null, examples: block.id === EXAMPLES_ID, sections: [] };
      outline.parts.push(part);
    } else if (block.kind === "heading" && block.level === 2 && block.id === CONTENTS_ID && !part) {
      inContents = true;
      section = null;
    } else if (block.kind === "heading" && block.level === 2 && block.id) {
      inContents = false;
      const list: GuideSection[] = part ? part.sections : outline.opening;
      section = { id: block.id, number: part ? `${part.number}.${list.length + 1}` : null, title: block.content, body: [] };
      list.push(section);
    } else if (inContents) {
      // The markdown contents list, for GitHub's readers. The page draws its own.
    } else if (section) {
      section.body.push(block);
    } else if (part) {
      part.intro.push(block);
    } else {
      outline.intro.push(block);
    }
  }
  for (const p of outline.parts) p.summary = firstSentence(p.intro);
  return outline;
}

/** The first sentence of the first paragraph, as plain text. */
export function firstSentence(blocks: readonly Block[]): string | null {
  const first = blocks.find((b) => b.kind === "paragraph");
  if (!first || first.kind !== "paragraph") return null;
  const text = inlineText(first.content).trim();
  const end = /[.!?](?=\s|$)/.exec(text);
  return end ? text.slice(0, end.index + 1) : text || null;
}

/** Every heading the outline can mark as the place being read, in the page's order. */
export function outlineIds(outline: GuideOutline): string[] {
  return [...outline.opening.map((s) => s.id), ...outline.parts.flatMap((p) => [p.id, ...p.sections.map((s) => s.id)])];
}

/** The part a heading belongs to, or null for an opening section or none. */
export function partOf(outline: GuideOutline, id: string | null): GuidePart | null {
  if (id === null) return null;
  return outline.parts.find((p) => p.id === id || p.sections.some((s) => s.id === id)) ?? null;
}
