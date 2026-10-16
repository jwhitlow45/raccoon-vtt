import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useUiScale } from "../features/device/settings.ts";

/**
 * A `<dialog>` opened with showModal(), for anything that declares itself
 * modal over the room. The browser then makes everything behind it inert,
 * so neither Tab nor a screen reader reaches the room's controls, which
 * `aria-modal` alone only promises. The monster filters sheet, the image
 * picker's Modal, the handout popup, "view as a player", the scene menu's
 * sheets, the stamp sheets and the stamp picker use it.
 *
 * What the hook adds to showModal():
 * - Escape asks the owner to close instead of closing the element itself,
 *   so the owner's state decides, and could keep a dialog with unsaved work
 *   open.
 * - Tab and Shift+Tab wrap inside the dialog. Past the last control the
 *   browser would otherwise move focus out to its own toolbar.
 * - Closing gives focus back to the control that opened it, which the
 *   browser cannot do itself while that control is still inert.
 *
 * The dialog element keeps `aria-modal="true"` too: the room's Escape
 * handlers look for that attribute to leave their own sheets alone while a
 * dialog is open (useEscape in pages/RoomChrome.tsx, and the label pane in
 * features/builder/LabelPane.tsx). Give it `tabIndex={-1}`, since it takes
 * the first focus so a screen reader starts at its label, unless a field
 * inside has autoFocus.
 *
 * The dialog takes this device's interface size (features/device/layout.ts)
 * with the rest of the chrome. A dialog that holds its own pointer math, a
 * zoomable image or a whole Room page, passes `zoom: false`, since a zoomed
 * box would put its pointer and its pixels in different units. `zoom`
 * multiplies viewport units too, so a card inside sizes itself by shares
 * of the dialog, which covers the screen, never by `vw` or `dvh`.
 */
export function useModalDialog(
  dialog: RefObject<HTMLDialogElement | null>,
  options: {
    onClose(): void;
    /** Where focus returns on close. By default, whatever had focus when the dialog opened. */
    returnFocus?: RefObject<HTMLElement | null>;
    /** False keeps the dialog at 100% whatever the interface size. */
    zoom?: boolean;
  },
): void {
  const latest = useRef(options);
  latest.current = options;
  // Read during the first render, before React commits the dialog: a field inside it with autoFocus takes focus in the commit (openingFocus).
  const [beforeCommit] = useState(() => focusedElement());
  const opening = useRef<OpeningFocus<HTMLElement> | null>(null);
  const deviceScale = useUiScale();
  const scale = options.zoom === false ? 1 : deviceScale;
  // A layout effect, so the dialog is modal before the first paint and never shows as a plain element.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    opening.current = openingFocus(opening.current, focusedElement(), (node) => el.contains(node), beforeCommit);
    const { opener, first } = opening.current;
    if (!el.open) el.showModal();
    (first ?? el).focus({ preventScroll: true });
    const onCancel = (e: Event) => {
      e.preventDefault();
      latest.current.onClose();
    };
    // Chrome closes without a cancel event when Escape repeats with no tap or click in between.
    // A close event left over from an earlier cleanup, such as React's development double mount, finds the dialog open again and is ignored.
    const onNativeClose = () => {
      if (!el.open) latest.current.onClose();
    };
    const onKey = (e: KeyboardEvent) => containTab(el, e);
    el.addEventListener("cancel", onCancel);
    el.addEventListener("close", onNativeClose);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("cancel", onCancel);
      el.removeEventListener("close", onNativeClose);
      el.removeEventListener("keydown", onKey);
      // Closed before focus moves: the control to focus is inert while the dialog is modal.
      if (el.open) el.close();
      const target = latest.current.returnFocus?.current ?? opener;
      if (!target?.isConnected) return;
      target.focus({ preventScroll: true });
      /*
       * An opener disabled while its dialog is open, such as the file
       * picker that starts a map import, is enabled again in the commit
       * that unmounts the dialog, but after this cleanup runs. Its focus()
       * did nothing and focus fell to the page. Once the commit is done it
       * can take focus, unless something else took it meanwhile.
       */
      if (document.activeElement === target) return;
      queueMicrotask(() => {
        const now = document.activeElement;
        if (target.isConnected && (now === null || now === document.body)) target.focus({ preventScroll: true });
      });
    };
  }, [dialog, beforeCommit]);

  // Through the DOM rather than the dialog's own style, so every dialog takes it without passing it along.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.style.setProperty("zoom", scale === 1 ? "" : String(scale));
    el.style.setProperty("--rvtt-ui", scale === 1 ? "" : String(scale));
    el.toggleAttribute("data-rvtt-small-ui", scale < 1);
  }, [dialog, scale]);
}

/**
 * Keeps Tab and Shift+Tab inside `root`: from its last control to its
 * first, and back. useModalDialog's `<dialog>` does it, and so does a modal
 * layer that cannot be one, such as the fight's alerts opened over the
 * screen, whose cards must stay mounted (InitiativeStrip.tsx FightAlerts).
 */
export function containTab(root: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const stops = tabStops(focusableIn(root), radioOf);
  const next = wrapFocusIndex(stops.length, stopIndex(stops, document.activeElement as HTMLElement | null, radioOf), e.shiftKey);
  if (next === null) return;
  e.preventDefault();
  stops[next]?.focus();
}

/**
 * Everything on the page but `root` made inert, as showModal() makes it
 * for a `<dialog>`: the siblings of `root` and of each of its ancestors up
 * to the body, so nothing behind takes focus, a tap or a screen reader's
 * attention. Returns the undo, which leaves alone what was inert already.
 */
export function inertOutside(root: HTMLElement): () => void {
  const made: Element[] = [];
  for (let node: HTMLElement | null = root; node && node !== document.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      made.push(sibling);
    }
  }
  return () => {
    for (const el of made) el.removeAttribute("inert");
  };
}

function focusedElement(): HTMLElement | null {
  return typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

export type OpeningFocus<T> = { opener: T | null; first: T | null };

/**
 * Who had focus before the dialog opened, and what inside it takes the
 * first focus. React focuses a field marked autoFocus (a new journal
 * page's title, the pasted stat block) while it commits the dialog, which
 * is before this hook's layout effect runs. Read there, the opener was that
 * field, gone once the dialog closed, so focus fell to the page, and the
 * dialog then took focus from the field. So when focus is already inside,
 * the field keeps it and the opener is what had focus before the commit.
 *
 * It is read once per dialog (`saved` holds the first reading). React's
 * StrictMode runs the effect a second time in development, after a
 * cleanup that gave focus back to the opener. Read again there, focus was
 * outside, and the dialog took it from the field in development only.
 */
export function openingFocus<T>(saved: OpeningFocus<T> | null, active: T | null, inDialog: (el: T) => boolean, beforeCommit: T | null): OpeningFocus<T> {
  if (saved) return saved.first === null || inDialog(saved.first) ? saved : { opener: saved.opener, first: null };
  if (active !== null && inDialog(active)) return { opener: beforeCommit, first: active };
  return { opener: active, first: null };
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab visits inside the dialog, in order, without those hidden in a folded section. */
function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/** A native radio's group, read for tabStops. */
function radioOf(el: HTMLElement): RadioMark | null {
  return el instanceof HTMLInputElement && el.type === "radio" && el.name ? { name: el.name, checked: el.checked } : null;
}

export type RadioMark = { name: string; checked: boolean };

/**
 * The places Tab stops in the dialog, in order. A group of native radios
 * (one name, as Segmented and Swatches render) is one stop, as the
 * browser makes it: its checked radio, or its first when none is checked.
 * Counted radio by radio, a group last in a dialog with no footer took
 * Shift+Tab from the first control to its last radio whatever was
 * checked, and Tab from a checked radio that was not the group's last
 * left the dialog for the browser's toolbar.
 */
export function tabStops<T>(controls: readonly T[], radio: (control: T) => RadioMark | null): T[] {
  const stops = new Map<string, T>();
  for (const control of controls) {
    const mark = radio(control);
    if (!mark) continue;
    const current = stops.get(mark.name);
    // The first option holds the group's place until a checked one turns up.
    if (current === undefined || (mark.checked && !radio(current)?.checked)) stops.set(mark.name, control);
  }
  return controls.filter((control) => {
    const mark = radio(control);
    return !mark || stops.get(mark.name) === control;
  });
}

/** Where the focused control sits among the stops. A radio that is not its group's stop counts as that stop. -1 when focus is elsewhere, such as on the dialog itself. */
export function stopIndex<T>(stops: readonly T[], active: T | null, radio: (control: T) => RadioMark | null): number {
  if (active === null) return -1;
  const at = stops.indexOf(active);
  if (at !== -1) return at;
  const mark = radio(active);
  return mark ? stops.findIndex((stop) => radio(stop)?.name === mark.name) : -1;
}

/**
 * Where Tab goes when it would leave the dialog: from the last control to
 * the first, and with Shift from the first (or from the dialog itself,
 * which has focus when it opens) to the last. Null leaves Tab to the
 * browser, which moves between the controls in between.
 */
export function wrapFocusIndex(count: number, active: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift) return active <= 0 ? count - 1 : null;
  return active === -1 || active === count - 1 ? 0 : null;
}
