/**
 * Bringing a control into view inside the box that scrolls it, before
 * focus moves there. The fight alerts column scrolls as a whole
 * (features/encounter/InitiativeStrip.tsx), and keeps its scroll position
 * while a sheet folds it. Focus moved with `preventScroll`, which every
 * caller uses so the page itself never jumps, left a card that had
 * scrolled out of the column focused but out of sight, and out of a
 * finger's reach.
 *
 * Only the nearest box that scrolls up and down moves: scrollIntoView
 * would also scroll any `overflow: hidden` ancestor that clips the
 * target, the room's own frame among them. Positions come from the
 * offset chain, in the box's own pixels, so the interface size's CSS zoom
 * needs no sums of its own.
 */

/** The parts of an element these read. The DOM's types in a test's fake elements. */
type Node = {
  parentElement: Node | null;
  offsetParent: Node | null;
  offsetTop: number;
  offsetHeight: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number };
  scrollTo?(options: { top: number; behavior: "smooth" | "auto" }): void;
};

type StyleOf = (el: Node) => { overflowY: string; scrollPaddingTop: string; scrollPaddingBottom: string };

const styleOf: StyleOf = (el) => getComputedStyle(el as unknown as Element);

/** The nearest ancestor that scrolls up and down and has more than it shows. */
export function scrollBox(el: Node, style: StyleOf = styleOf): Node | null {
  for (let box = el.parentElement; box; box = box.parentElement) {
    const overflow = style(box).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && box.scrollHeight > box.clientHeight) return box;
  }
  return null;
}

/** Where `el` starts in `box`'s scrolled content, or null when `box` is not on its offset chain. */
function topIn(el: Node, box: Node): number | null {
  let top = 0;
  let node: Node | null = el;
  while (node && node !== box) {
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return node === box ? top : null;
}

/**
 * Scrolls `el`'s scroll box just enough that `el` shows inside it, clear
 * of the box's scroll-padding: down to its foot when it lies below, up to
 * its head when it lies above or is taller than the room.
 */
export function revealInScrollBox(el: Node, style: StyleOf = styleOf): void {
  const box = scrollBox(el, style);
  if (!box) return;
  const top = topIn(el, box);
  if (top === null) return;
  const s = style(box);
  const padTop = parseFloat(s.scrollPaddingTop) || 0;
  const padBottom = parseFloat(s.scrollPaddingBottom) || 0;
  const viewTop = box.scrollTop + padTop;
  const viewBottom = box.scrollTop + box.clientHeight - padBottom;
  const bottom = top + el.offsetHeight;
  if (top < viewTop || bottom - top > viewBottom - viewTop) box.scrollTop = top - padTop;
  else if (bottom > viewBottom) box.scrollTop = bottom - box.clientHeight + padBottom;
}

/**
 * Scrolls `el`'s scroll box so that `el` starts `margin` px below the box's
 * head, as far as the box goes, and moves nothing else: a panel opened on
 * one of its sections. scrollIntoView would also scroll the sheet's own
 * frame when the box cannot go that far, taking the sheet's header out of
 * sight. The box need not be on `el`'s offset chain, so the distance comes
 * from the screen, divided by the interface size's zoom, which the box's
 * drawn height over its own gives.
 */
export function startInScrollBox(target: HTMLElement | Node, margin: number, smooth = false, style: StyleOf = styleOf): void {
  const el = target as Node;
  const box = scrollBox(el, style);
  if (!box) return;
  const b = box.getBoundingClientRect();
  const zoom = box.offsetHeight > 0 ? (b.bottom - b.top) / box.offsetHeight : 1;
  const wanted = box.scrollTop + (el.getBoundingClientRect().top - b.top) / zoom - margin;
  const top = Math.max(0, Math.min(wanted, box.scrollHeight - box.clientHeight));
  if (box.scrollTo) box.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
  else box.scrollTop = top;
}

/** Whether some of `el` shows inside its scroll box, or it has none. */
export function visibleInScrollBox(el: Node, style: StyleOf = styleOf): boolean {
  const box = scrollBox(el, style);
  if (!box) return true;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return r.bottom > b.top && r.top < b.bottom;
}

/**
 * Brings `el` into view in its scroll box, then focuses it without moving
 * anything else. True when focus landed on it and it shows.
 */
export function revealAndFocus(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  const node = el as unknown as Node;
  revealInScrollBox(node);
  if (!visibleInScrollBox(node)) return false;
  el.focus({ preventScroll: true });
  return el.ownerDocument.activeElement === el;
}
