import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { GUIDE_HEADING, GUIDE_SCROLL_MARGIN, Inlines } from "../../components/Markdown.tsx";
import { isFinePointer } from "../../lib/device.ts";
import { theme } from "../../lib/theme.ts";
import { EYEBROW } from "./look.ts";
import { CONTENTS_ID, firstSentence, partOf, type GuideOutline, type GuideSection } from "./outline.ts";

/**
 * A row's height in the contents and the outline: a finger's 44 px, or a
 * mouse's tighter rows on a computer, where 44 px rows would stretch a
 * part's sections past the window's height.
 */
function rowHeight(): number {
  return isFinePointer() ? 32 : theme.touch;
}

/**
 * The guide's contents, laid out like a printed book's: the opening
 * sections to start with, then each part with its number, the first
 * sentence of its introduction, and its numbered sections. It takes the
 * markdown contents list's place and its id, so a link to #contents and
 * the floating Contents button still land here.
 */
export function GuideContents(props: { outline: GuideOutline }) {
  const { outline } = props;
  const row = rowHeight();
  return (
    <nav aria-labelledby={CONTENTS_ID} style={{ margin: `${theme.space(12)}px 0 0` }}>
      <h2 id={CONTENTS_ID} tabIndex={-1} style={{ margin: `0 0 ${theme.space(5)}px`, fontSize: GUIDE_HEADING.section, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, scrollMarginTop: GUIDE_SCROLL_MARGIN }}>
        Contents
      </h2>
      {outline.opening.length > 0 ? (
        <div style={{ margin: `0 0 ${theme.space(4)}px` }}>
          <p style={{ ...EYEBROW, margin: `0 0 ${theme.space(2)}px` }}>Start here</p>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: theme.space(3) }}>
            {outline.opening.map((section) => (
              <li key={section.id} style={{ display: "grid" }}>
                <a href={`#${section.id}`} style={{ ...CARD, display: "grid", alignContent: "start", gap: theme.space(1), padding: `${theme.space(3)}px ${theme.space(4)}px`, textDecoration: "none", color: theme.color.text }}>
                  <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>
                    <Inlines content={section.title} />
                  </span>
                  <SectionSummary section={section} />
                </a>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: theme.space(3) }}>
        {outline.parts.map((part) => (
          <li key={part.id} style={{ ...CARD, padding: `${theme.space(4)}px ${theme.space(4)}px ${theme.space(3)}px`, display: "grid", alignContent: "start" }}>
            <a href={`#${part.id}`} style={{ display: "grid", gap: theme.space(1), textDecoration: "none", color: theme.color.text, minHeight: row }}>
              <span style={EYEBROW}>Part {part.number}</span>
              <span style={{ fontSize: theme.font.title, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>
                <Inlines content={part.title} />
              </span>
            </a>
            {part.summary ? <p style={{ margin: `${theme.space(1)}px 0 0`, fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.textMuted }}>{part.summary}</p> : null}
            <ol style={{ listStyle: "none", margin: `${theme.space(3)}px 0 0`, padding: `${theme.space(2)}px 0 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
              {part.sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} style={{ display: "grid", gridTemplateColumns: "2.6em minmax(0, 1fr)", alignItems: "center", minHeight: row, color: theme.color.text, textDecoration: "none", fontSize: theme.font.body14, lineHeight: theme.leading.tight }}>
                    <span style={NUMBER}>{section.number}</span>
                    <span>
                      <Inlines content={section.title} />
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const CARD: CSSProperties = {
  borderRadius: theme.radius.lg,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  background: theme.color.surface,
};

/** A section's number, in the column of numbers. */
const NUMBER: CSSProperties = { color: theme.color.textMuted, fontVariantNumeric: "tabular-nums", fontWeight: theme.weight.strong, fontSize: theme.font.small };

function SectionSummary(props: { section: GuideSection }) {
  const summary = firstSentence(props.section.body);
  return summary ? <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>{summary}</span> : null;
}

/**
 * The outline of the guide: its opening sections and its parts, with the
 * place being read marked (`aria-current`). Beside the page on a wide
 * screen, it opens only the part being read, so it fits the window. In
 * the phone's sheet (`all`), every part is open. `onPick` takes a tap on
 * a row instead of the browser's jump, for the sheet, which closes first.
 */
export function GuideOutlineNav(props: { outline: GuideOutline; current: string | null; all: boolean; onPick?(id: string): void; header?: ReactNode }) {
  const { outline, current } = props;
  const nav = useRef<HTMLElement>(null);
  const reading = partOf(outline, current);
  const row = props.all ? theme.touch : rowHeight();

  // The row being read stays in view as the reader moves on, scrolling the outline alone, never the page.
  useLayoutEffect(() => {
    const box = nav.current;
    const mark = box?.querySelector<HTMLElement>("[aria-current]");
    if (!box || !mark) return;
    const scroller = scrollParent(box);
    if (!scroller) return;
    const view = scroller.getBoundingClientRect();
    const at = mark.getBoundingClientRect();
    if (at.top < view.top || at.bottom > view.bottom) scroller.scrollTop += at.top - view.top - (view.height - at.height) / 2;
  }, [current]);

  const pick = (id: string) =>
    props.onPick
      ? (e: MouseEvent) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          props.onPick!(id);
        }
      : undefined;

  const link = (id: string, content: ReactNode, level: "part" | "section", number: string | null) => {
    const here = current === id;
    return (
      <a
        href={`#${id}`}
        onClick={pick(id)}
        aria-current={here ? "location" : undefined}
        style={{
          display: "grid",
          gridTemplateColumns: number === null ? "minmax(0, 1fr)" : `${level === "part" ? 1.8 : 2.8}em minmax(0, 1fr)`,
          alignItems: "center",
          minHeight: row,
          padding: `${theme.space(1)}px ${theme.space(3)}px`,
          marginLeft: -theme.line.border,
          borderLeft: `${theme.line.strong}px solid ${here ? theme.color.accent : "transparent"}`,
          background: here ? theme.color.surfaceRaised : "transparent",
          borderRadius: `0 ${theme.radius.sm}px ${theme.radius.sm}px 0`,
          color: here || level === "part" ? theme.color.text : theme.color.textMuted,
          fontWeight: here || level === "part" ? theme.weight.strong : theme.weight.regular,
          fontSize: theme.font.body14,
          lineHeight: theme.leading.tight,
          textDecoration: "none",
        }}
      >
        {number === null ? null : <span style={{ ...NUMBER, color: here ? theme.color.text : theme.color.textMuted }}>{number}</span>}
        <span>{content}</span>
      </a>
    );
  };

  const rail: CSSProperties = { listStyle: "none", margin: 0, padding: 0, borderLeft: `${theme.line.border}px solid ${theme.color.border}` };
  return (
    <nav ref={nav} aria-label="Guide outline" style={{ display: "grid", gap: theme.space(3) }}>
      {props.header}
      {outline.opening.length > 0 ? (
        <ol style={rail}>
          {outline.opening.map((s) => (
            <li key={s.id}>{link(s.id, <Inlines content={s.title} />, "section", null)}</li>
          ))}
        </ol>
      ) : null}
      <ol style={rail}>
        {outline.parts.map((part) => (
          <li key={part.id}>
            {link(part.id, <Inlines content={part.title} />, "part", String(part.number))}
            {props.all || reading?.id === part.id ? (
              <ol style={{ listStyle: "none", margin: `0 0 ${theme.space(2)}px`, padding: `0 0 0 ${theme.space(4)}px` }}>
                {part.sections.map((s) => (
                  <li key={s.id}>{link(s.id, <Inlines content={s.title} />, "section", s.number)}</li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The nearest box that scrolls its content up and down, or null for the page itself. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}
