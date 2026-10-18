import { useMemo, type CSSProperties, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";
import { parseMarkdown, type Block, type Inline } from "./markdown.ts";

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
 * `guide` turns on the DM guide's (markdown.ts) too. `image` maps an
 * image's relative path to a file the build bundled, and an image it does
 * not know is left out. A link to a heading stays on the page.
 */
export function Markdown(props: { text: string; style?: CSSProperties; journal?: boolean; guide?: boolean; image?(src: string): MarkdownImage | null }) {
  const journal = props.journal === true;
  const guide = props.guide === true;
  const blocks = useMemo(() => parseMarkdown(props.text, { journal, guide }), [props.text, journal, guide]);
  const image = props.image ?? noImage;
  return (
    <div style={{ fontSize: theme.font.body14, lineHeight: 1.45, overflowWrap: "anywhere", ...props.style }}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} image={image} />
      ))}
    </div>
  );
}

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

function BlockView(props: { block: Block; image(src: string): MarkdownImage | null }) {
  const { block } = props;
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
            <BlockView key={i} block={inner} image={props.image} />
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

function Inlines(props: { content: Inline[] }): ReactNode {
  return props.content.map((node, i) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "break") return <br key={i} />;
    if (node.kind === "code") {
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
