import type { CSSProperties, ReactNode } from "react";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";

/** The mark's tooltip and the name a screen reader hears, or null for neither. */
export function proficiencyWord(level: Proficiency): "Proficient" | "Expertise" | null {
  return level === "expert" ? "Expertise" : level === "prof" ? "Proficient" : null;
}

/** What a button's or a row's own accessible name adds after a marked test: ", proficient", ", expertise", or nothing (FL7-R1-08). */
export function spokenProficiency(level: Proficiency): string {
  const word = proficiencyWord(level);
  return word ? `, ${word.toLowerCase()}` : "";
}

/*
 * The mark is a border around the roll it names, in the roll's own color
 * (D-261030-527). It takes no room, so no line, row or grid moves for it.
 *
 * A roll that is text ("DEX +5", "Perception check") is a unit whose box is
 * trimmed to its capitals and baseline (text-box), then padded 0.05 em up
 * and 0.214 em down to just clear Inter's tallest marks (the parentheses,
 * 0.77 em) and its deepest (g, 0.216 em). Its line is a shadow 1 px
 * outside that box, so it hugs the words' ink and runs 1 px past each
 * side. Vertical padding on an inline box lays nothing out, and a shadow
 * scrolls nothing. The frame is 0.99 em and its two lines tall, so frames
 * on two lines at Inter's own spacing (1.21 em) keep 1 px apart.
 *
 * Expertise fills its frame with a tint of the same color. A second line
 * would need 2 px more on every side, and there is none: one space leaves
 * 1.6 px between two frames at 13 px, and the next line 1 px.
 * Punctuation right after a roll joins its unit (MarkedText), so no frame
 * runs into a comma or a colon. A unit cut over two lines draws a whole
 * frame on each.
 *
 * A browser that cannot trim the box frames the line's whole box, with no
 * padding, which there would push the frame past the line.
 *
 * Neither looks like a focus ring or a chosen control: those take the
 * accent's color, a 2 px ring 2 px out and an accent fill. These keep the
 * text's color and a 1 px line.
 */
const TRIMS = globalThis.CSS?.supports?.("text-box", "trim-both cap alphabetic") ?? true;
const UNIT: CSSProperties = {
  ...(TRIMS ? { textBox: "trim-both cap alphabetic", padding: "0.05em 0 0.214em" } : {}),
  borderRadius: theme.radius.xs,
  boxShadow: theme.shadow.mark,
  boxDecorationBreak: "clone",
  WebkitBoxDecorationBreak: "clone",
};
const UNIT_MARK: Record<"prof" | "expert", CSSProperties> = {
  prof: UNIT,
  expert: { ...UNIT, backgroundColor: "color-mix(in srgb, currentColor 16%, transparent)" },
};

/**
 * A roll button's border for its test's level. Proficient turns the border
 * the text's color and doubles its weight with a 1 px line inside it.
 * Expertise keeps the 1 px border in the text's color and draws a second
 * 1 px line 2 px inside it, over a band of the button's `background`. Only
 * colors and shadows change, so the button keeps its size, padding and
 * words where they were.
 */
export function proficiencyBox(level: Proficiency | undefined, background: string): CSSProperties {
  if (level === "prof") return { borderColor: "currentColor", boxShadow: theme.shadow.markInside };
  if (level === "expert") return { borderColor: "currentColor", boxShadow: theme.shadow.markDouble(background) };
  return {};
}

/**
 * The mark for a box that cuts its words with "…" and so would cut a frame
 * drawn outside them, such as the sticky result's label: the box frames
 * its words from inside, its padding holding the lines. Proficient is one
 * line at its edge, expertise a second 2 px in. The padding moves its words
 * 4 px in and grows it 6 px, which the boxes around the sticky result leave
 * room for.
 */
export function proficiencyFrame(level: Proficiency | undefined): CSSProperties {
  if (level !== "prof" && level !== "expert") return {};
  const line: CSSProperties = { padding: "3px 4px", borderRadius: theme.radius.sm, boxShadow: theme.shadow.markInside };
  return level === "expert" ? { ...line, outline: "1px solid currentColor", outlineOffset: -3 } : line;
}

/**
 * The attributes a box drawing a mark carries (`proficiencyBox`,
 * `proficiencyFrame`): the level it draws, and the form, which says what
 * of its style is the mark. A "unit" takes no room at all, a "frame" holds
 * its lines in its own padding, and a "box" is a button's own border.
 */
export function markedBy(level: Proficiency | undefined, form: "unit" | "frame" | "box"): Record<string, string> {
  return level === "prof" || level === "expert" ? { "data-proficiency-mark": level, "data-proficiency-form": form } : {};
}

/** A roll's words, "DEX +5", with the mark for its level, `data-proficiency-mark` naming it. Neither leaves the words as they are. */
export function ProficiencyUnit(props: { level: Proficiency; children: ReactNode }) {
  if (props.level === "none") return <>{props.children}</>;
  return <span data-proficiency-mark={props.level} data-proficiency-form="unit" style={UNIT_MARK[props.level]}>{props.children}</span>;
}

/**
 * A test's name with its level. Neither keeps a bare span, so every place
 * that names a test says which level it found. A marked name holds an
 * unseen picture named "Proficient" or "Expertise" after its words, so a
 * screen reader hears it where it stands while the words copied or matched
 * stay the same. The name draws its own mark unless `bare`: then a unit
 * around it with its bonus, or the button it names, draws it.
 */
export function ProficiencyLabel(props: { level: Proficiency; bare?: boolean; children: ReactNode }) {
  const word = proficiencyWord(props.level);
  if (props.level === "none" || !word) return <span data-proficiency-label="" data-proficiency-level={props.level}>{props.children}</span>;
  const own = props.bare ? {} : { "data-proficiency-mark": props.level, "data-proficiency-form": "unit", style: UNIT_MARK[props.level] };
  return (
    <span data-proficiency-label="" data-proficiency-level={props.level} title={word} {...own}>
      {props.children}
      <span data-proficiency-marker={props.level} role="img" aria-label={word} style={VISUALLY_HIDDEN} />
    </span>
  );
}

/** The rest of a word a test's name ends inside, "checks", which the name takes in so its frame never cuts a word. */
const WORD_END = /^[A-Za-z]+/;

type Marks = readonly { at: number; length: number; level: Proficiency }[];

/** A line's words as an accessible name holds them, each marked test followed by ", proficient" or ", expertise" after the word it ends in. */
export function spokenText(text: string, marks: Marks): string {
  let out = "";
  let from = 0;
  for (const mark of marks) {
    const end = mark.at + mark.length + (WORD_END.exec(text.slice(mark.at + mark.length))?.[0].length ?? 0);
    out += text.slice(from, end) + spokenProficiency(mark.level);
    from = end;
  }
  return out + text.slice(from);
}

/** A bonus right after a test's name ("Perception +7"), which the mark takes in with the name. */
const BONUS = /^ [+−-]\d+/;
/** Punctuation right after a roll, which its frame takes in rather than touch. */
const STOP = /^[,.:;]/;

/**
 * A line of text with some of its words marked, at the ranges
 * proficiencyPresentation.ts findMarks found. A name ending inside a word
 * takes the word's end, and a bonus and then punctuation right after it
 * join its unit, so "Perception checks", "Perception +7," and "Perception
 * check:" are framed whole and no frame touches a character outside it.
 */
export function MarkedText(props: { text: string; marks: Marks }) {
  if (props.marks.length === 0) return <>{props.text}</>;
  const out: ReactNode[] = [];
  let from = 0;
  for (const [i, mark] of props.marks.entries()) {
    let end = mark.at + mark.length;
    end += WORD_END.exec(props.text.slice(end))?.[0].length ?? 0;
    const words = props.text.slice(mark.at, end);
    const bonus = BONUS.exec(props.text.slice(end))?.[0] ?? "";
    const stop = STOP.exec(props.text.slice(end + bonus.length))?.[0] ?? "";
    out.push(props.text.slice(from, mark.at));
    if ((bonus || stop) && mark.level !== "none") {
      out.push(
        <ProficiencyUnit key={i} level={mark.level}>
          <ProficiencyLabel level={mark.level} bare>{words}</ProficiencyLabel>
          {bonus + stop}
        </ProficiencyUnit>,
      );
      from = end + bonus.length + stop.length;
    } else {
      out.push(<ProficiencyLabel key={i} level={mark.level}>{words}</ProficiencyLabel>);
      from = end;
    }
  }
  out.push(props.text.slice(from));
  return <>{out}</>;
}
