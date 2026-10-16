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

/** How a sheet's `<dialog>` stands: closed (hidden, or not yet open), open beside the map with show(), or modal with showModal(). */
export type SheetDialogState = "closed" | "shown" | "modal";
export type SheetDialogStep = "close" | "show" | "showModal";

/**
 * What takes a sheet's `<dialog>` from how it stands to how its sheet asks
 * (docs/design-v1-layout-hierarchy.md 4.2): show() or showModal() to open,
 * close() to hide, and close() then the other open for a change of mode,
 * since a dialog cannot change between modal and not while open.
 */
export function sheetDialogSteps(now: SheetDialogState, want: { shown: boolean; modal: boolean }): SheetDialogStep[] {
  const next: SheetDialogState = !want.shown ? "closed" : want.modal ? "modal" : "shown";
  if (next === now) return [];
  if (next === "closed") return ["close"];
  const open: SheetDialogStep = next === "modal" ? "showModal" : "show";
  return now === "closed" ? [open] : ["close", open];
}

/**
 * Where focus goes once a sheet's dialog has taken its steps. The browser
 * runs its own focusing steps on show(), showModal() and close(), which no
 * sheet asked for, so the hook puts focus where the sheet's rules say:
 * - Opened, beside the map: back where it was, so a turn strip's tap that
 *   opens Initiative leaves focus on the strip. A request Room makes after
 *   (the sheet's title, for a panel picked from the list) still wins.
 *   Opened modal: where the browser put it, inside, since outside is inert.
 * - Switched between modes: the element inside the sheet that had it.
 * - Closed with focus inside: on `hide`, the element that stands for the
 *   sheet (Panels), else lost to the page, as when a sheet unmounted, for
 *   Room's own decision after a sheet closes. Focus elsewhere stays there.
 * Null leaves focus where the browser put it, and "page" blurs it.
 */
export function sheetFocusAfter(input: { steps: readonly SheetDialogStep[]; before: "inside" | "outside" | "page"; hiding: boolean }): "before" | "page" | "hide" | null {
  const { steps, before } = input;
  if (steps.length === 0) return null;
  const last = steps[steps.length - 1];
  if (last === "close") {
    if (before === "outside") return "before";
    return input.hiding ? "hide" : "page";
  }
  if (steps.length === 2) return before === "inside" ? "before" : last === "showModal" ? null : before === "outside" ? "before" : "page";
  if (last === "showModal") return null;
  return before === "page" ? "page" : "before";
}

/** The parts of a `<dialog>` a sheet's steps use, so they run in tests without a DOM. */
export type DialogLike = {
  open: boolean;
  show(): void;
  showModal(): void;
  close(): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/**
 * Counts the closes the hook asked for. The browser fires `close` a task
 * after close(), so each close event heard is the hook's own while any is
 * owed, and otherwise the viewer's: a repeated Escape that closed the
 * modal with no cancel event.
 */
export function closeLedger(): { mark(): void; heard(): "own" | "viewer" } {
  let owed = 0;
  return {
    mark() {
      owed++;
    },
    heard() {
      if (owed === 0) return "viewer";
      owed--;
      return "own";
    },
  };
}

/**
 * Takes the steps on the dialog. `aria-modal` is set only once showModal()
 * has run and removed before every close(), so a closed or plain sheet is
 * never taken for a modal by the room's readers of one.
 */
export function applySheetDialogSteps(el: DialogLike, steps: readonly SheetDialogStep[], ledger: { mark(): void }): void {
  for (const step of steps) {
    if (step === "close") {
      el.removeAttribute("aria-modal");
      if (!el.open) continue;
      ledger.mark();
      el.close();
    } else if (step === "show") el.show();
    else {
      el.showModal();
      el.setAttribute("aria-modal", "true");
    }
  }
}

/*
 * How many sheets are taking their dialog steps right now. The steps move
 * focus synchronously, the browser's focusing steps and then the hook's
 * own placing, and neither is the viewer moving it.
 */
let stepping = 0;

/** Whether a focus event comes from a sheet's dialog steps, for a reader that tracks where the viewer put focus (Room's dock). */
export function sheetStepping(): boolean {
  return stepping > 0;
}

/**
 * A panel sheet as one `<dialog>` kept mounted from the moment its panel
 * opens until it closes (docs/design-v1-layout-hierarchy.md 4.2), so no
 * change of mode, no Hide and no rotation remounts the panel, and its
 * draft, scroll and subpage stay. `shown` false closes it with its content
 * kept. `modal` opens it with showModal() and `aria-modal="true"`, which
 * the room's readers of an open modal see only while it shows, so after
 * Hide the map's shortcuts and Escape work again at once.
 *
 * While modal it takes useModalDialog's Tab wrapping and its Escape, which
 * asks `onCancel`. Chrome can close a modal dialog with no cancel event
 * when Escape repeats with no tap between: a close this hook did not ask
 * for is the viewer closing the sheet, so it drops the marker and calls
 * `onCancel` too. `hideFocus` is where focus goes when the sheet hides
 * with focus inside it, as Hide does. Unmounting closes the dialog first,
 * so whatever decides focus after a sheet closes finds nothing inert.
 */
export function useSheetDialog(
  dialog: RefObject<HTMLDialogElement | null>,
  options: { shown: boolean; modal: boolean; onCancel(): void; hideFocus?: RefObject<HTMLElement | null> },
): void {
  const latest = useRef(options);
  latest.current = options;
  const [ledger] = useState(closeLedger);
  const state = useRef<SheetDialogState>("closed");
  /*
   * What had focus inside the sheet when the effects were last cleaned up
   * with the sheet still mounted. React's development StrictMode cleans up
   * and runs a new component's effects again at once, which closes and
   * opens the dialog: focus goes back to that element, never to where the
   * browser's focusing steps put it.
   */
  const held = useRef<HTMLElement | null>(null);
  const { shown, modal } = options;

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const steps = sheetDialogSteps(state.current, { shown, modal });
    if (steps.length === 0) return;
    const active = focusedElement();
    const before = active === null || active === document.body ? "page" : el.contains(active) ? "inside" : "outside";
    stepping++;
    try {
      applySheetDialogSteps(el, steps, ledger);
      state.current = !shown ? "closed" : modal ? "modal" : "shown";
      const keep = held.current;
      held.current = null;
      if (shown && keep?.isConnected && el.contains(keep)) {
        keep.focus({ preventScroll: true });
        return;
      }
      const focus = sheetFocusAfter({ steps, before, hiding: !shown });
      if (focus === "before") {
        if (active?.isConnected) active.focus({ preventScroll: true });
        // What had it may be gone or hidden by this same render, such as a token bar folded under the sheet. Focus then goes to the page, as before sheets were dialogs, for the room to place.
        if (focusedElement() !== active) focusedElement()?.blur();
      } else if (focus === "hide") {
        const target = latest.current.hideFocus?.current;
        if (target?.isConnected) target.focus({ preventScroll: true });
        else focusedElement()?.blur();
      } else if (focus === "page") focusedElement()?.blur();
    } finally {
      stepping--;
    }
  }, [dialog, shown, modal, ledger]);

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      latest.current.onCancel();
    };
    const onNativeClose = () => {
      if (ledger.heard() === "own" || el.open) return;
      state.current = "closed";
      el.removeAttribute("aria-modal");
      latest.current.onCancel();
    };
    const onKey = (e: KeyboardEvent) => {
      if (state.current === "modal") containTab(el, e);
    };
    el.addEventListener("cancel", onCancel);
    el.addEventListener("close", onNativeClose);
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("cancel", onCancel);
      el.removeEventListener("close", onNativeClose);
      el.removeEventListener("keydown", onKey);
      // The sheet closes for good: closed before it leaves the page, and focus that was inside is lost to the page, as when a sheet unmounted, for Room to place.
      const active = focusedElement();
      const inside = active !== null && el.contains(active);
      applySheetDialogSteps(el, ["close"], ledger);
      state.current = "closed";
      held.current = inside ? active : null;
      if (inside) focusedElement()?.blur();
    };
  }, [dialog, ledger]);
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
 * attention. It keeps doing so until undone: something that arrives
 * meanwhile beside one of them, such as a player's roll card portaled to
 * the body above the fight's alerts opened over the screen, is made inert
 * as it arrives, as the browser does for a modal dialog's top layer.
 * Returns the undo, which leaves alone what was inert already.
 */
export function inertOutside(root: HTMLElement): () => void {
  const made: Element[] = [];
  const parents: HTMLElement[] = [];
  const stillOut = (sibling: Element, node: Element) => {
    if (sibling === node || sibling.contains(root) || sibling.hasAttribute("inert")) return;
    sibling.setAttribute("inert", "");
    made.push(sibling);
  };
  for (let node: HTMLElement | null = root; node && node !== document.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    parents.push(parent);
    for (const sibling of Array.from(parent.children)) stillOut(sibling, node);
  }
  const arrivals = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) if (added instanceof Element) stillOut(added, root);
    }
  });
  for (const parent of parents) arrivals.observe(parent, { childList: true });
  return () => {
    arrivals.disconnect();
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
