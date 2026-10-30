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

/**
 * A group's folded line of whole parts, inside Group's summary, which
 * clips it to one line (components/Panel.tsx). Where the line cannot hold
 * every part, it ends with "…" after the last part that fits, so a part
 * is never cut and a marked name always shows whole with its mark
 * (D-261030-437). Only a first part too long for the line on its own is
 * cut, by the summary's own ellipsis. The parts past the cut stay for a
 * screen reader, which hears the whole line as the fold's description.
 *
 * It measures after layout and again when its row changes width. The
 * parts it hides carry no style from React, so it sets theirs directly
 * and React never undoes it.
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
      // One part alone still too long keeps the summary's own ellipsis, inside it.
      if (over()) more.hidden = true;
      clip.setAttribute("data-summary-cut", "");
    };
    fit();
    let width = row.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      // Only a new width can change what fits. Hiding parts can move the summary beside or under the name, which a height change would measure again without end.
      const now = row.getBoundingClientRect().width;
      if (now === width) return;
      width = now;
      fit();
    });
    observer.observe(row);
    return () => observer.disconnect();
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
