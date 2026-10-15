import { useLayoutEffect, useRef, type RefObject } from "react";
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
 * the first focus so a screen reader starts at its label.
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
  const deviceScale = useUiScale();
  const scale = options.zoom === false ? 1 : deviceScale;
  // A layout effect, so the dialog is modal before the first paint and never shows as a plain element.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    el.focus({ preventScroll: true });
    const onCancel = (e: Event) => {
      e.preventDefault();
      latest.current.onClose();
    };
    // Chrome closes without a cancel event when Escape repeats with no tap or click in between.
    // A close event left over from an earlier cleanup, such as React's development double mount, finds the dialog open again and is ignored.
    const onNativeClose = () => {
      if (!el.open) latest.current.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const stops = tabStops(focusableIn(el), radioOf);
      const next = wrapFocusIndex(stops.length, stopIndex(stops, document.activeElement as HTMLElement | null, radioOf), e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      stops[next]?.focus();
    };
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
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [dialog]);

  // Through the DOM rather than the dialog's own style, so every dialog takes it without passing it along.
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    el.style.setProperty("zoom", scale === 1 ? "" : String(scale));
    el.style.setProperty("--rvtt-ui", scale === 1 ? "" : String(scale));
    el.toggleAttribute("data-rvtt-small-ui", scale < 1);
  }, [dialog, scale]);
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
