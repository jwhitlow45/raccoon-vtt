import { useEffect, useState } from "react";

/**
 * The heading of the place being read: the last of `ids`, in the page's
 * order, whose top has passed a line a third of the way down the window.
 * Null above the first. At the page's foot the last heading in view wins,
 * since a short last section never reaches the line.
 *
 * It reads the headings' places on scroll, at most once a frame, and
 * renders only when the answer changes, so a page at rest does nothing.
 */
export function useCurrentSection(ids: readonly string[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setCurrent(currentOf(ids, (id) => document.getElementById(id)?.getBoundingClientRect().top ?? null, innerHeight, atFoot()));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    return () => {
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [ids]);
  return current;
}

function atFoot(): boolean {
  const doc = document.documentElement;
  return scrollY + innerHeight >= doc.scrollHeight - 2;
}

/** The pure rule behind useCurrentSection, given each heading's top in the window (null for one not drawn). */
export function currentOf(ids: readonly string[], topOf: (id: string) => number | null, windowHeight: number, foot: boolean): string | null {
  const line = Math.min(windowHeight / 3, 240);
  let found: string | null = null;
  for (const id of ids) {
    const top = topOf(id);
    if (top === null) continue;
    if (top <= line || (foot && top < windowHeight)) found = id;
    else if (!foot) break;
  }
  return found;
}
