import type { CSSProperties, ReactNode } from "react";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";

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
 * The mark is an underline under the test's name, in the text's own color:
 * dotted for proficient, double for expertise (D-261030-436). It takes no
 * inline room, so no line grows or wraps for it, in flowing text and fixed
 * grids alike. The app's links take a solid underline, so neither reads as
 * one. Each ends 3 px under the baseline, the 2 px dots 1 px down and the
 * 3 px double (two lines and their gap) right under the letters, so both
 * stay inside a line's descent from 13 px text at its font's own line
 * height up. A box that clips its line for an ellipsis, such as the
 * sticky result's label, would otherwise cut the double's lower line and
 * leave what reads as a link's underline.
 */
const UNDERLINE: Record<"prof" | "expert", CSSProperties> = {
  prof: { textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationThickness: "2px", textUnderlineOffset: "1px", textDecorationSkipInk: "none" },
  expert: { textDecorationLine: "underline", textDecorationStyle: "double", textDecorationThickness: "1px", textUnderlineOffset: "0px", textDecorationSkipInk: "none" },
};

/**
 * A test's name with its mark. Neither keeps a bare span, so every place
 * that names a test says which level it found. A marked name holds an
 * unseen picture named "Proficient" or "Expertise", so a screen reader
 * hears it where it stands while the words copied or matched stay the same.
 */
export function ProficiencyLabel(props: { level: Proficiency; children: ReactNode }) {
  const word = proficiencyWord(props.level);
  return (
    <span data-proficiency-label="" data-proficiency-level={props.level} title={word ?? undefined} style={props.level === "none" ? undefined : UNDERLINE[props.level]}>
      {props.children}
      {word ? <span data-proficiency-marker={props.level} role="img" aria-label={word} style={VISUALLY_HIDDEN} /> : null}
    </span>
  );
}

type Marks = readonly { at: number; length: number; level: Proficiency }[];

/** A line's words as an accessible name holds them, each marked test followed by ", proficient" or ", expertise". */
export function spokenText(text: string, marks: Marks): string {
  let out = "";
  let from = 0;
  for (const mark of marks) {
    out += text.slice(from, mark.at + mark.length) + spokenProficiency(mark.level);
    from = mark.at + mark.length;
  }
  return out + text.slice(from);
}

/** A line of text with some of its words marked, at the ranges proficiencyPresentation.ts findMarks found. */
export function MarkedText(props: { text: string; marks: Marks }) {
  if (props.marks.length === 0) return <>{props.text}</>;
  const out: ReactNode[] = [];
  let from = 0;
  for (const [i, mark] of props.marks.entries()) {
    out.push(props.text.slice(from, mark.at), <ProficiencyLabel key={i} level={mark.level}>{props.text.slice(mark.at, mark.at + mark.length)}</ProficiencyLabel>);
    from = mark.at + mark.length;
  }
  out.push(props.text.slice(from));
  return <>{out}</>;
}
