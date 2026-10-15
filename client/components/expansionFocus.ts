import { useLayoutEffect, useRef, type RefObject } from "react";

const FIELDS = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where focus lands in a part that opened: the part itself when it takes
 * focus from script (a prompt with `tabIndex={-1}`, or a control), else its
 * first field. A radio stands for its group, which a Tab enters at the
 * chosen option, so the chosen one of that group is the field.
 */
function landing(el: HTMLElement): HTMLElement | null {
  if (el.hasAttribute("tabindex") || el.matches(FIELDS)) return el;
  const first = el.querySelector<HTMLElement>(FIELDS);
  if (first instanceof HTMLInputElement && first.type === "radio" && !first.checked) {
    const chosen = [...el.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')].find((r) => r.name === first.name);
    if (chosen) return chosen;
  }
  return first;
}

/**
 * Focus for a part of a panel that opens in place in answer to a button,
 * such as the X-card's card, "Show a handout" or "Export as image". The
 * button that opens it gives way to it, and its Cancel or Close gives way
 * back, so either way focus fell to the page, and a screen reader heard
 * nothing of what changed.
 *
 * - On open, focus goes to `inside`: the part's prompt, or its first field
 *   (`landing`).
 * - On close, focus goes back to `opener`, when it fell to the page with
 *   the part. Focus someone moved elsewhere stays there.
 *
 * Both refs are read after the render that opened or closed the part, so
 * an opener drawn anew in the button's place is the one focused.
 */
export function useExpansionFocus(open: boolean, refs: { inside: RefObject<HTMLElement | null>; opener: RefObject<HTMLElement | null> }): void {
  const was = useRef(open);
  const { inside, opener } = refs;
  useLayoutEffect(() => {
    const before = was.current;
    was.current = open;
    if (before === open) return;
    if (open) {
      const el = inside.current;
      const target = el ? landing(el) : null;
      target?.focus();
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) opener.current?.focus();
  }, [open, inside, opener]);
}
