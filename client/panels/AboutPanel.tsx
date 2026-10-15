import type { ReactNode } from "react";
import NOTICE from "../../shared/srd/NOTICE.md?raw";
import { creditSections, type CreditRow } from "../features/about/credits.ts";
import { parseMarkdown, type Block, type Inline } from "../features/about/notice.ts";
import { TokenIconsCredit } from "../features/about/TokenIconsCredit.tsx";
import type { PanelProps } from "../features/panels.ts";
import { theme } from "../lib/theme.ts";

/**
 * About (design section 20): the app, Wizards' SRD 5.2.1 notice verbatim
 * from shared/srd/NOTICE.md, and every credit from shared/credits.ts. CC BY
 * works must be credited where people can see them, which is here.
 */
export default function AboutPanel(_props: PanelProps) {
  return (
    <div style={{ display: "grid", gap: theme.space(4), fontSize: theme.font.body14, lineHeight: 1.5 }}>
      <header style={{ display: "flex", alignItems: "center", gap: theme.space(3) }}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <div>
          <h3 style={{ margin: 0, fontSize: theme.font.title, fontWeight: theme.weight.bold }}>RaccoonVTT</h3>
          <p style={{ margin: 0, color: theme.color.textMuted }}>A virtual tabletop for one group, compatible with fifth edition.</p>
        </div>
      </header>
      <p style={{ margin: 0 }}>
        Apart from the raccoon icon, which was drawn for this app, every image it ships is existing art under an open
        license. None of it is AI generated.
      </p>
      <section aria-label="SRD 5.2.1 notice" style={{ display: "grid", gap: theme.space(2) }}>
        {parseMarkdown(NOTICE).map((block, i) => (
          <NoticeBlock key={i} block={block} />
        ))}
      </section>
      <section style={{ display: "grid", gap: theme.space(3) }}>
        <h3 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>Credits</h3>
        {creditSections().map((section) => [
          <div key={section.id} style={{ display: "grid", gap: theme.space(1) }}>
            <h4 style={{ margin: 0, fontSize: theme.font.input, fontWeight: theme.weight.bold }}>{section.heading}</h4>
            {section.changes ? <p style={{ margin: 0, color: theme.color.textMuted }}>Changes: {section.changes}</p> : null}
            <ul style={{ margin: 0, paddingLeft: theme.space(5), display: "grid", gap: theme.space(1) }}>
              {section.rows.map((row) => (
                <CreditItem key={row.key} row={row} />
              ))}
            </ul>
          </div>,
          section.id === "icons" ? <TokenIconsCredit key="token-icons" /> : null,
        ])}
      </section>
    </div>
  );
}

/** A bare URL breaks anywhere, so a long one fills its line and keeps the full stop after it on the same line. */
function ExternalLink(props: { href: string; children: ReactNode }) {
  const bare = props.children === props.href;
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer" style={{ color: theme.color.accent, wordBreak: bare ? "break-all" : "normal", overflowWrap: "anywhere" }}>
      {props.children}
    </a>
  );
}

function CreditItem(props: { row: CreditRow }) {
  const { row } = props;
  return (
    <li>
      {row.sourceUrl ? <ExternalLink href={row.sourceUrl}>{row.title}</ExternalLink> : row.title} by{" "}
      {row.authorUrl ? <ExternalLink href={row.authorUrl}>{row.author}</ExternalLink> : row.author},{" "}
      {row.license.url ? <ExternalLink href={row.license.url}>{row.license.name}</ExternalLink> : row.license.name}.
      {row.changes ? <span style={{ color: theme.color.textMuted }}> {row.changes}</span> : null}
    </li>
  );
}

function Spans(props: { inline: Inline[] }) {
  return (
    <>
      {props.inline.map((part, i) => {
        switch (part.kind) {
          case "text":
            return <span key={i}>{part.text}</span>;
          case "code":
            return (
              <code key={i} style={{ fontFamily: theme.font.mono, fontSize: "0.92em" }}>
                {part.text}
              </code>
            );
          case "link":
            return (
              <ExternalLink key={i} href={part.href}>
                {part.text}
              </ExternalLink>
            );
        }
      })}
    </>
  );
}

function NoticeBlock(props: { block: Block }) {
  const { block } = props;
  switch (block.kind) {
    case "heading":
      return block.level <= 1 ? (
        <h3 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>
          <Spans inline={block.inline} />
        </h3>
      ) : (
        <h4 style={{ margin: 0, fontSize: theme.font.input, fontWeight: theme.weight.bold }}>
          <Spans inline={block.inline} />
        </h4>
      );
    case "paragraph":
      return (
        <p style={{ margin: 0 }}>
          <Spans inline={block.inline} />
        </p>
      );
    case "list":
      return (
        <ul style={{ margin: 0, paddingLeft: theme.space(5) }}>
          {block.items.map((item, i) => (
            <li key={i}>
              <Spans inline={item} />
            </li>
          ))}
        </ul>
      );
  }
}
