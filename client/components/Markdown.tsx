import { useMemo, type CSSProperties, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { keyChord, parseMarkdown, type Block, type GuideAlert, type Inline } from "./markdown.ts";

/** A bundled image for a guide's relative path, with its size, so the page keeps its layout while images load. */
export type MarkdownImage = { url: string; width: number; height: number };

/**
 * SRD rules text and stat blocks (shared/srd), rendered from the parsed
 * tree as React elements. No HTML string is ever built, so the text cannot
 * inject markup, and the strict CSP needs no exception.
 *
 * `journal` turns on the journal's additions (markdown.ts): line breaks,
 * numbered lists, quotes, a `# ` heading and https links, which open in a
 * new tab with no opener and no referrer.
 *
 * `guide` turns on the DM guide's (markdown.ts) too, and its look, a
 * printed guide's rather than a note's (docs/design-v1-guide-look.md):
 * body text kept to a reading measure, numbered lists drawn as steps, keys
 * as keycaps, screenshots framed as figures with their captions, alerts as
 * callouts, and a paragraph of bold alone as a label. `image` maps an
 * image's relative path to a file the build bundled, and an image it does
 * not know is left out. A link to a heading stays on the page.
 */
export function Markdown(props: { text: string; style?: CSSProperties; journal?: boolean; guide?: boolean; image?(src: string): MarkdownImage | null }) {
  const journal = props.journal === true;
  const guide = props.guide === true;
  const blocks = useMemo(() => parseMarkdown(props.text, { journal, guide }), [props.text, journal, guide]);
  return (
    <div style={{ fontSize: theme.font.body14, lineHeight: 1.45, overflowWrap: "anywhere", ...props.style }}>
      <MarkdownBlocks blocks={blocks} guide={guide} {...(props.image ? { image: props.image } : {})} />
    </div>
  );
}

/**
 * Blocks already parsed, for a page that lays out the parts of a document
 * itself, as the DM guide's page does. `subheading` is the element a
 * guide's `###` takes: one level under the heading the page drew for the
 * blocks' section, so a screen reader's outline nests them under it.
 */
export function MarkdownBlocks(props: { blocks: Block[]; guide?: boolean; image?(src: string): MarkdownImage | null; subheading?: SubheadingTag }) {
  const image = props.image ?? noImage;
  const guide = props.guide === true;
  const subheading = props.subheading ?? "h4";
  return props.blocks.map((block, i) => <BlockView key={i} block={block} image={image} guide={guide} boxed={false} subheading={subheading} />);
}

export type SubheadingTag = "h3" | "h4";

function noImage(): null {
  return null;
}

/**
 * Headings in text color, each with a 1 px rule under it
 * (docs/design-v1-visual.md F4). In the accent they changed color with
 * each member, pink for a pink player, and looked like links.
 */
function headingStyle(fontSize: number, top: number): CSSProperties {
  return {
    margin: `${theme.space(top)}px 0 ${theme.space(1)}px`,
    paddingBottom: theme.space(0.5),
    fontSize,
    fontWeight: theme.weight.bold,
    lineHeight: theme.leading.tight,
    color: theme.color.text,
    borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
    // A link to a guide's section lands with a little room above the heading, clear of a notch.
    scrollMarginTop: `calc(${theme.safe.top} + ${theme.space(3)}px)`,
  };
}

/**
 * The guide's measure: a line of body text holds about 70 characters,
 * the comfortable length for reading. Figures take the column's whole
 * width, so their small print stays legible.
 */
const MEASURE = "34em";

/** A phone's screenshot in the guide, narrower than the column, so one fits a window's height. */
const PORTRAIT_MAX = 300;

/**
 * `guide` draws the guide's look. `boxed` is a block inside a callout,
 * which spaces its blocks itself, so they take no margins of their own.
 */
function BlockView(props: { block: Block; image(src: string): MarkdownImage | null; guide: boolean; boxed: boolean; subheading: SubheadingTag }) {
  const { block } = props;
  if (props.guide) {
    const view = guideBlock(props);
    if (view !== undefined) return view;
  }
  switch (block.kind) {
    case "heading":
      if (block.level === 1) {
        return (
          <h2 id={block.id} style={headingStyle(theme.font.title, 3)}>
            <Inlines content={block.content} />
          </h2>
        );
      }
      return block.level === 2 ? (
        <h3 id={block.id} style={headingStyle(theme.font.heading, 3)}>
          <Inlines content={block.content} />
        </h3>
      ) : (
        <h4 id={block.id} style={headingStyle(theme.font.input, 4)}>
          <Inlines content={block.content} />
        </h4>
      );
    case "image": {
      const found = props.image(block.src);
      if (!found) return null;
      return (
        <img
          src={found.url}
          alt={block.alt}
          width={found.width}
          height={found.height}
          loading="lazy"
          decoding="async"
          style={{
            display: "block",
            // The width and height set the ratio, so the page keeps its place while images load: a link to a section lands on it.
            width: "100%",
            maxWidth: found.width,
            height: "auto",
            margin: `${theme.space(3)}px 0`,
            borderRadius: theme.radius.md,
            border: `${theme.line.border}px solid ${theme.color.border}`,
          }}
        />
      );
    }
    case "paragraph":
      return (
        <p style={{ margin: `${theme.space(2)}px 0` }}>
          <Inlines content={block.content} />
        </p>
      );
    case "list": {
      const items = block.items.map((item, i) => {
        const sub = block.sub?.[i] ?? [];
        return (
          <li key={i} style={{ margin: "2px 0" }}>
            <Inlines content={item} />
            {sub.length > 0 ? (
              <ul style={{ margin: "2px 0", paddingLeft: theme.space(5) }}>
                {sub.map((child, j) => (
                  <li key={j} style={{ margin: "2px 0" }}>
                    <Inlines content={child} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      });
      const style = { margin: `${theme.space(2)}px 0`, paddingLeft: theme.space(5) };
      return block.start === undefined ? (
        <ul style={style}>{items}</ul>
      ) : (
        <ol start={block.start} style={style}>
          {items}
        </ol>
      );
    }
    case "quote":
      return (
        <blockquote style={{ margin: `${theme.space(2)}px 0`, padding: `0 ${theme.space(3)}px`, borderLeft: `${theme.line.stripe}px solid ${theme.color.border}`, color: theme.color.textMuted }}>
          {block.blocks.map((inner, i) => (
            <BlockView key={i} block={inner} image={props.image} guide={props.guide} boxed={false} subheading={props.subheading} />
          ))}
        </blockquote>
      );
    case "table":
      return (
        <div style={{ overflowX: "auto", margin: `${theme.space(2)}px 0` }}>
          <table style={{ borderCollapse: "collapse", fontSize: theme.font.small, minWidth: "100%" }}>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} style={cellStyle(true)}>
                    <Inlines content={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={cellStyle(false)}>
                      <Inlines content={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** The guide's own drawing of a block, or undefined for one it draws as the journal does (tables). */
function guideBlock(props: { block: Block; image(src: string): MarkdownImage | null; boxed: boolean; subheading: SubheadingTag }): ReactNode | undefined {
  const { block, boxed } = props;
  const flow = (bottom: number): CSSProperties => ({ margin: boxed ? 0 : `0 0 ${theme.space(bottom)}px`, maxWidth: MEASURE });
  switch (block.kind) {
    case "heading": {
      // The page draws the parts and sections itself (features/guide), so what reaches here is mostly a section's own subheadings.
      const size = block.level === 1 ? GUIDE_HEADING.part : block.level === 2 ? GUIDE_HEADING.section : GUIDE_HEADING.sub;
      const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : props.subheading;
      return (
        <Tag
          id={block.id}
          style={{
            margin: `${theme.space(block.level === 3 ? 8 : 12)}px 0 ${theme.space(3)}px`,
            fontSize: size,
            fontWeight: theme.weight.bold,
            lineHeight: theme.leading.tight,
            color: theme.color.text,
            scrollMarginTop: GUIDE_SCROLL_MARGIN,
          }}
        >
          <Inlines content={block.content} />
        </Tag>
      );
    }
    case "paragraph": {
      const only = block.content.length === 1 ? block.content[0] : undefined;
      if (only?.kind === "bold") {
        // A paragraph that is only bold text is a label over what follows, such as a scenario's "Building it".
        return (
          <p
            style={{
              margin: boxed ? 0 : `${theme.space(8)}px 0 ${theme.space(3)}px`,
              fontSize: theme.font.small,
              fontWeight: theme.weight.bold,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: theme.color.accent,
            }}
          >
            <Inlines content={only.children} />
          </p>
        );
      }
      return (
        <p style={flow(4)}>
          <Inlines content={block.content} />
        </p>
      );
    }
    case "list":
      return block.start === undefined ? (
        <ul style={{ ...flow(4), paddingLeft: theme.space(5) }}>
          {block.items.map((item, i) => (
            <li key={i} style={{ margin: `0 0 ${theme.space(2)}px`, paddingLeft: theme.space(1) }}>
              <Inlines content={item} />
              <SubItems items={block.sub?.[i]} />
            </li>
          ))}
        </ul>
      ) : (
        <Steps items={block.items} start={block.start} sub={block.sub} style={flow(5)} />
      );
    case "image": {
      const found = props.image(block.src);
      if (!found) return null;
      const portrait = found.height > found.width;
      return (
        <figure style={{ margin: boxed ? 0 : `${theme.space(6)}px 0 ${theme.space(7)}px` }}>
          <div
            style={{
              padding: theme.space(portrait ? 4 : 2),
              borderRadius: theme.radius.lg,
              border: `${theme.line.border}px solid ${theme.color.border}`,
              background: theme.color.surface,
            }}
          >
            <img
              src={found.url}
              alt={block.alt}
              width={found.width}
              height={found.height}
              loading="lazy"
              decoding="async"
              style={{
                display: "block",
                // The width and height set the ratio, so the page keeps its place while images load: a link to a section lands on it.
                width: "100%",
                maxWidth: portrait ? PORTRAIT_MAX : found.width,
                height: "auto",
                margin: "0 auto",
                borderRadius: theme.radius.sm,
              }}
            />
          </div>
          {block.alt ? (
            // The image's alt text already says this to a screen reader, so the caption is for the eye alone.
            <figcaption aria-hidden="true" style={{ margin: `${theme.space(2)}px ${theme.space(1)}px 0`, maxWidth: MEASURE, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>
              {block.alt}
            </figcaption>
          ) : null}
        </figure>
      );
    }
    case "quote":
      if (block.alert) return <Callout alert={block.alert} blocks={block.blocks} image={props.image} style={flow(5)} subheading={props.subheading} />;
      return (
        <blockquote style={{ ...flow(4), padding: `0 ${theme.space(4)}px`, borderLeft: `${theme.line.stripe}px solid ${theme.color.border}`, color: theme.color.textMuted }}>
          {block.blocks.map((inner, i) => (
            <BlockView key={i} block={inner} image={props.image} guide boxed={false} subheading={props.subheading} />
          ))}
        </blockquote>
      );
    case "table":
      return undefined;
  }
}

/** The guide's heading sizes, larger than the interface's: a long page read top to bottom needs a clearer ladder than a panel does. */
export const GUIDE_HEADING = { part: 32, section: theme.font.display, sub: theme.font.heading } as const;

/** A link to a heading lands with a little room above it, clear of a notch. */
export const GUIDE_SCROLL_MARGIN = `calc(${theme.safe.top} + ${theme.space(4)}px)`;

const ALERT_LOOK: Record<GuideAlert, { label: string; color: string }> = {
  tip: { label: "Tip", color: theme.color.accent },
  note: { label: "Note", color: theme.color.ally },
};

/** An alert: a tinted box with its kind as a label, as GitHub draws the same quote. */
function Callout(props: { alert: GuideAlert; blocks: Block[]; image(src: string): MarkdownImage | null; style: CSSProperties; subheading: SubheadingTag }) {
  const look = ALERT_LOOK[props.alert];
  return (
    <div
      role="note"
      style={{
        ...props.style,
        display: "grid",
        gap: theme.space(2),
        padding: `${theme.space(3)}px ${theme.space(4)}px ${theme.space(4)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderLeft: `${theme.line.stripe}px solid ${look.color}`,
        background: theme.color.surface,
      }}
    >
      <p style={{ margin: 0, fontSize: theme.font.small, fontWeight: theme.weight.bold, letterSpacing: "0.08em", textTransform: "uppercase", color: look.color }}>{look.label}</p>
      {props.blocks.map((inner, i) => (
        <BlockView key={i} block={inner} image={props.image} guide boxed subheading={props.subheading} />
      ))}
    </div>
  );
}

/**
 * A numbered list as a procedure: each step's number in a disc, joined to
 * the next by a line, so the eye follows the order. The list keeps its
 * role, which a list without markers loses in Safari, and each number is
 * text, so a screen reader still says it.
 */
function Steps(props: { items: Inline[][]; start: number; sub: Inline[][][] | undefined; style: CSSProperties }) {
  const last = props.items.length - 1;
  return (
    <ol role="list" start={props.start} style={{ ...props.style, listStyle: "none", padding: 0 }}>
      {props.items.map((item, i) => (
        <li
          key={i}
          style={{ position: "relative", display: "grid", gridTemplateColumns: `${STEP_DISC}px minmax(0, 1fr)`, columnGap: theme.space(3), paddingBottom: i === last ? 0 : theme.space(3) }}
        >
          {i === last ? null : (
            <span aria-hidden="true" style={{ position: "absolute", left: (STEP_DISC - theme.line.strong) / 2, top: STEP_DISC + theme.space(1), bottom: theme.space(1), width: theme.line.strong, background: theme.color.border }} />
          )}
          <span
            style={{
              width: STEP_DISC,
              height: STEP_DISC,
              display: "grid",
              placeItems: "center",
              borderRadius: theme.radius.round,
              border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
              background: theme.color.surfaceRaised,
              fontSize: theme.font.small,
              fontWeight: theme.weight.bold,
              fontVariantNumeric: "tabular-nums",
              lineHeight: 1,
            }}
          >
            {props.start + i}
          </span>
          <div style={{ minWidth: 0, paddingTop: 1 }}>
            <Inlines content={item} />
            <SubItems items={props.sub?.[i]} />
          </div>
        </li>
      ))}
    </ol>
  );
}

const STEP_DISC = 26;

function SubItems(props: { items: Inline[][] | undefined }) {
  if (!props.items || props.items.length === 0) return null;
  return (
    <ul style={{ margin: `${theme.space(2)}px 0 0`, paddingLeft: theme.space(5) }}>
      {props.items.map((child, j) => (
        <li key={j} style={{ margin: `0 0 ${theme.space(1)}px` }}>
          <Inlines content={child} />
        </li>
      ))}
    </ul>
  );
}

/** A key as the keyboard shows it, for the guide's keys in code (markdown.ts keyChord). */
const KEYCAP: CSSProperties = {
  display: "inline-block",
  minWidth: "1.75em",
  padding: "0 0.4em",
  fontFamily: theme.font.body,
  fontSize: "0.82em",
  fontWeight: theme.weight.strong,
  lineHeight: 1.55,
  textAlign: "center",
  color: theme.color.text,
  background: theme.color.surfaceRaised,
  border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
  borderBottomWidth: theme.line.strong,
  borderRadius: theme.radius.sm - 1,
  whiteSpace: "nowrap",
};

function cellStyle(head: boolean): CSSProperties {
  return {
    padding: "3px 8px",
    textAlign: "center",
    borderBottom: `1px solid ${theme.color.border}`,
    color: head ? theme.color.textMuted : theme.color.text,
    fontWeight: head ? theme.weight.strong : theme.weight.regular,
    whiteSpace: "nowrap",
  };
}

export function Inlines(props: { content: Inline[] }): ReactNode {
  return props.content.map((node, i) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "break") return <br key={i} />;
    if (node.kind === "code") {
      const keys = keyChord(node.text);
      if (keys) {
        // A chord is one key element of keys, as HTML spells Ctrl+Z.
        return keys.length === 1 ? (
          <kbd key={i} style={KEYCAP}>
            {keys[0]}
          </kbd>
        ) : (
          <kbd key={i} style={{ fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {keys.map((k, j) => (
              <span key={j}>
                {j > 0 ? "+" : null}
                <kbd style={KEYCAP}>{k}</kbd>
              </span>
            ))}
          </kbd>
        );
      }
      return (
        <code key={i} style={{ fontFamily: theme.font.mono, fontSize: "0.92em", padding: "1px 4px", borderRadius: theme.radius.xs, background: theme.color.surfaceRaised, overflowWrap: "anywhere" }}>
          {node.text}
        </code>
      );
    }
    if (node.kind === "link" && node.href.startsWith("#")) {
      // A heading on this page: the browser scrolls to it and the address keeps the section, so Back returns.
      return (
        <a key={i} href={node.href} style={{ color: theme.color.accent, textDecoration: "underline" }}>
          <Inlines content={node.children} />
        </a>
      );
    }
    if (node.kind === "link") {
      // markdown.ts lets only https addresses through. The page never learns who opened it, and it cannot reach back.
      return (
        <a key={i} href={node.href} target="_blank" rel="noopener noreferrer" style={{ color: theme.color.accent, textDecoration: "underline" }}>
          <Inlines content={node.children} />
        </a>
      );
    }
    if (node.kind === "bold") {
      return (
        <strong key={i}>
          <Inlines content={node.children} />
        </strong>
      );
    }
    return (
      <em key={i}>
        <Inlines content={node.children} />
      </em>
    );
  });
}
