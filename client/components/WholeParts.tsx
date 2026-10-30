import { useLayoutEffect, useRef, type ReactNode } from "react";

/** How a part past the cut is kept from sight but not from a screen reader (lib/a11y.ts VISUALLY_HIDDEN). */
const HIDE: readonly [string, string][] = [
  ["position", "absolute"],
  ["width", "1px"],
  ["height", "1px"],
  ["overflow", "hidden"],
  ["clip", "rect(0 0 0 0)"],
  ["white-space", "nowrap"],
];

/** The part of document.fonts a fit listens to, so a test can stand in for it. */
type FontLoads = { ready: Promise<unknown>; addEventListener(type: "loadingdone", listener: () => void): void; removeEventListener(type: "loadingdone", listener: () => void): void };

/**
 * Calls `fit` again whenever what fits may have changed after the first
 * fit: a new width of the row, or a web font that loaded since. Inter
 * loads with font-display swap, so a line first fitted in the fallback
 * font would otherwise keep a cut its own font no longer needs, or overflow
 * (FL7-R2-OPUS-01). Returns the cleanup.
 */
export function refitOn(row: Pick<HTMLElement, "clientWidth">, fit: () => void, env: { Observer?: typeof ResizeObserver; fonts?: FontLoads | undefined } = {}): () => void {
  const Observer = env.Observer ?? ResizeObserver;
  const fonts = "fonts" in env ? env.fonts : globalThis.document?.fonts;
  let stopped = false;
  let width = row.clientWidth;
  const observer = new Observer(() => {
    // Only a new width can change what fits. Hiding parts can move the summary beside or under the name, which a height change would measure again without end.
    const now = row.clientWidth;
    if (now === width) return;
    width = now;
    fit();
  });
  observer.observe(row as Element);
  const onFonts = () => {
    if (!stopped) fit();
  };
  void fonts?.ready.then(onFonts);
  fonts?.addEventListener("loadingdone", onFonts);
  return () => {
    stopped = true;
    observer.disconnect();
    fonts?.removeEventListener("loadingdone", onFonts);
  };
}

/**
 * A group's folded line of whole parts, inside Group's summary, which
 * clips it to one line (components/Panel.tsx). Where the line cannot hold
 * every part, it ends with "…" after the last part that fits, so a part
 * is never cut and a marked name always shows whole with its mark
 * (D-261030-437). Only a first part too long for the line with "…" after
 * it is cut, by the summary's own ellipsis. The parts past the cut stay for a
 * screen reader, which hears the whole line as the fold's description.
 *
 * It measures after layout and again when its row changes width or a web
 * font loads (refitOn). The parts it hides carry no style from React, so
 * it sets theirs directly and React never undoes it.
 */
export function WholeParts(props: { parts: readonly { join: string; node: ReactNode }[]; words: string }) {
  const line = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const own = line.current;
    const clip = own?.parentElement;
    const row = clip?.parentElement;
    if (!own || !clip || !row) return;
    const fit = () => {
      const parts = Array.from(own.querySelectorAll<HTMLElement>(":scope > [data-summary-part]"));
      const more = own.querySelector<HTMLElement>(":scope > [data-summary-more]");
      const join = more?.firstElementChild;
      if (!more || !join) return;
      for (const part of parts) for (const [name] of HIDE) part.style.removeProperty(name);
      more.hidden = true;
      clip.removeAttribute("data-summary-cut");
      const over = () => clip.scrollWidth > clip.clientWidth;
      if (!over()) return;
      more.hidden = false;
      let shown = parts.length;
      while (shown > 1 && over()) {
        shown--;
        const part = parts[shown]!;
        for (const [name, value] of HIDE) part.style.setProperty(name, value);
        // "…" follows what would have joined the first hidden part: ", …" in a list, " · …" between kinds.
        join.textContent = part.getAttribute("data-summary-join") ?? "";
      }
      // A first part too long to keep "…" after it keeps "…" anyway: the summary's own ellipsis then cuts the part, so a cut line always ends with "…" (FL-12).
      clip.setAttribute("data-summary-cut", "");
    };
    fit();
    return refitOn(row, fit);
  }, [props.words]);
  return (
    <span ref={line}>
      {props.parts.map((part, i) => (
        <span key={i} data-summary-part="" data-summary-join={part.join}>
          {part.join}
          {part.node}
        </span>
      ))}
      <span data-summary-more="" aria-hidden="true" hidden>
        <span />…
      </span>
    </span>
  );
}
