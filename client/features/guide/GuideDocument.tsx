import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../../components/Icon.tsx";
import { GUIDE_HEADING, GUIDE_SCROLL_MARGIN, Inlines, MarkdownBlocks, type MarkdownImage } from "../../components/Markdown.tsx";
import type { Block } from "../../components/markdown.ts";
import { theme } from "../../lib/theme.ts";
import { EYEBROW } from "./look.ts";
import { CONTENTS_ID, type GuidePart, type GuideSection } from "./outline.ts";

/*
 * The guide's page below its title (outline.ts): the opening sections,
 * then each part as a chapter, its opener first. Part and section
 * headings carry the number the app gives them, never typed into the
 * heading, so each heading's id stays the one GitHub gives it. The
 * numbers are for the eye: a screen reader hears the heading's own words,
 * as the Guide links name them.
 */

type ImageOf = (src: string) => MarkdownImage | null;

/** An introduction, the guide's own or a part's, a step larger than the body. */
export function GuideLead(props: { blocks: Block[]; image: ImageOf }) {
  return (
    <div style={{ fontSize: LEAD, lineHeight: 1.55, margin: `${theme.space(6)}px 0 0` }}>
      <MarkdownBlocks blocks={props.blocks} guide image={props.image} />
    </div>
  );
}

const LEAD = theme.font.heading;

/** A section under its numbered heading, or an opening one, which has no number. */
export function GuideSectionView(props: { section: GuideSection; image: ImageOf }) {
  return (
    <section>
      <SectionHeading section={props.section} />
      <MarkdownBlocks blocks={props.section.body} guide image={props.image} />
    </section>
  );
}

export function GuidePartView(props: { part: GuidePart; next: GuidePart | null; image: ImageOf }) {
  const { part } = props;
  return (
    <section>
      <header style={{ margin: `${theme.space(24)}px 0 ${theme.space(4)}px`, paddingTop: theme.space(8), borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
        <h2 id={part.id} tabIndex={-1} style={{ margin: 0, scrollMarginTop: GUIDE_SCROLL_MARGIN }}>
          <span aria-hidden="true" style={{ ...EYEBROW, margin: `0 0 ${theme.space(2)}px` }}>
            Part {part.number}
          </span>
          <span style={{ display: "block", fontSize: GUIDE_HEADING.part, fontWeight: theme.weight.bold, lineHeight: 1.15, letterSpacing: "-0.01em" }}>
            <Inlines content={part.title} />
          </span>
        </h2>
        <div aria-hidden="true" style={{ width: theme.space(10), height: theme.line.stripe, margin: `${theme.space(5)}px 0 0`, borderRadius: theme.line.stripe, background: theme.color.accent }} />
        {part.intro.length > 0 ? <GuideLead blocks={part.intro} image={props.image} /> : null}
      </header>
      {part.sections.map((section) =>
        part.examples ? <ExampleSection key={section.id} section={section} image={props.image} /> : <GuideSectionView key={section.id} section={section} image={props.image} />,
      )}
      <PartEnd part={part} next={props.next} />
    </section>
  );
}

function SectionHeading(props: { section: GuideSection }) {
  const { section } = props;
  return (
    <h3
      id={section.id}
      tabIndex={-1}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: theme.space(3),
        margin: `${theme.space(14)}px 0 ${theme.space(4)}px`,
        fontSize: GUIDE_HEADING.section,
        fontWeight: theme.weight.bold,
        lineHeight: theme.leading.tight,
        scrollMarginTop: GUIDE_SCROLL_MARGIN,
      }}
    >
      {section.number ? (
        <span aria-hidden="true" style={{ flex: "none", color: theme.color.accent, fontVariantNumeric: "tabular-nums" }}>
          {section.number}
        </span>
      ) : null}
      <span>
        <Inlines content={section.title} />
      </span>
    </h3>
  );
}

/**
 * A worked example, set apart as a printed guide sets off its examples:
 * its heading and its opening paragraph, the situation, in a banner, and
 * the walk-through after it under its own labels ("Building it").
 */
function ExampleSection(props: { section: GuideSection; image: ImageOf }) {
  const { section } = props;
  const [first, ...rest] = section.body;
  const premise = first?.kind === "paragraph" ? first : null;
  return (
    <section>
      <header
        style={{
          margin: `${theme.space(16)}px 0 ${theme.space(2)}px`,
          padding: `${theme.space(5)}px ${theme.space(5)}px ${theme.space(5)}px`,
          borderRadius: theme.radius.lg,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          borderTop: `${theme.line.stripe}px solid ${theme.color.accent}`,
          background: theme.color.surface,
        }}
      >
        {/* The banner's top edge and padding stay in view above a heading a link lands on. */}
        <h3 id={section.id} tabIndex={-1} style={{ margin: 0, scrollMarginTop: `calc(${GUIDE_SCROLL_MARGIN} + ${theme.space(6)}px)` }}>
          <span aria-hidden="true" style={{ ...EYEBROW, margin: `0 0 ${theme.space(2)}px` }}>
            Example {section.number}
          </span>
          <span style={{ display: "block", fontSize: GUIDE_HEADING.section, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>
            <Inlines content={section.title} />
          </span>
        </h3>
        {premise ? (
          <p style={{ margin: `${theme.space(3)}px 0 0`, fontSize: LEAD, lineHeight: 1.5, color: theme.color.textMuted, fontStyle: "italic" }}>
            <Inlines content={premise.content} />
          </p>
        ) : null}
      </header>
      <MarkdownBlocks blocks={premise ? rest : section.body} guide image={props.image} />
    </section>
  );
}

/** The way on at a part's end: back to the contents, and on to the next part. */
function PartEnd(props: { part: GuidePart; next: GuidePart | null }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: theme.space(3), margin: `${theme.space(12)}px 0 0` }}>
      <EndLink href={`#${CONTENTS_ID}`} label={`End of part ${props.part.number}`} align="start">
        Back to contents
      </EndLink>
      {props.next ? (
        <EndLink href={`#${props.next.id}`} label={`Next: part ${props.next.number}`} align="end">
          <Inlines content={props.next.title} />
        </EndLink>
      ) : null}
    </div>
  );
}

function EndLink(props: { href: string; label: string; align: "start" | "end"; children: ReactNode }) {
  const end = props.align === "end";
  const card: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: end ? "flex-end" : "flex-start",
    gap: theme.space(3),
    minHeight: theme.touch + theme.space(4),
    padding: `${theme.space(3)}px ${theme.space(4)}px`,
    borderRadius: theme.radius.lg,
    border: `${theme.line.border}px solid ${theme.color.border}`,
    background: theme.color.surface,
    color: theme.color.text,
    textDecoration: "none",
    textAlign: end ? "right" : "left",
  };
  return (
    <a href={props.href} style={card}>
      {end ? null : <Icon name="chevronUp" />}
      <span style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{props.label}</span>
        <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold }}>{props.children}</span>
      </span>
      {end ? <Icon name="chevronRight" /> : null}
    </a>
  );
}
