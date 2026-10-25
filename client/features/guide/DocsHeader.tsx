import type { ReactNode } from "react";
import { theme } from "../../lib/theme.ts";
import { DOC_TITLE_SIZE, EYEBROW } from "./look.ts";

/**
 * The bar over a docs page: the crest and where you are, with the way
 * back at the right. The page's own title follows in DocTitle, so the bar
 * holds no heading.
 */
export function DocsTopBar(props: { actions: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(3),
        flexWrap: "wrap",
        paddingBottom: theme.space(3),
        borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    >
      <img src="/icon.svg" alt="" width={32} height={32} />
      {/* Its own width first, so on a phone the buttons wrap under the name instead of squeezing it. */}
      <p style={{ flex: "1 1 auto", margin: 0, fontSize: theme.font.body14, fontWeight: theme.weight.bold }}>
        RaccoonVTT <span style={{ color: theme.color.textMuted, fontWeight: theme.weight.regular }}>Docs</span>
      </p>
      {/*
       * Wrapped under the name, the buttons fill that line and keep to its
       * right, where they stand beside the name on a wider screen, rather
       * than sit alone at its start (the alignment check's lone part).
       */}
      <div style={{ display: "flex", flex: "1 0 auto", justifyContent: "flex-end", gap: theme.space(2), flexWrap: "wrap" }}>{props.actions}</div>
    </div>
  );
}

/** A docs page's title block: a label over the title, the title, and a line on what the page is for. */
export function DocTitle(props: { label: string; title: string; subtitle: string; children?: ReactNode }) {
  return (
    <header style={{ padding: `${theme.space(10)}px 0 ${theme.space(2)}px` }}>
      <p style={{ ...EYEBROW, margin: `0 0 ${theme.space(3)}px` }}>{props.label}</p>
      <h1 style={{ margin: 0, fontSize: DOC_TITLE_SIZE, fontWeight: theme.weight.bold, lineHeight: 1.1, letterSpacing: "-0.01em" }}>{props.title}</h1>
      <p style={{ margin: `${theme.space(3)}px 0 0`, fontSize: theme.font.title, lineHeight: 1.35, color: theme.color.textMuted }}>{props.subtitle}</p>
      {props.children}
    </header>
  );
}
