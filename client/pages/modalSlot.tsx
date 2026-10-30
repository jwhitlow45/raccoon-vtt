import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";
import { scopeSlot, useScoped } from "../state/scope.ts";

/*
 * Where the room's notices go while a sheet shows in the very short mode
 * (docs/design-v1-layout-hierarchy.md 4.2). That sheet is a modal dialog,
 * which makes everything outside it inert, so a notice over the map would
 * show and speak where no one can reach it. Each notice stays mounted
 * where it is, keeping its own state, and while the modal shows it renders
 * its output through a portal into its place here, inside the dialog:
 *
 * - Every notice under the sheet's header and above its body: "Viewing as
 *   Pat" first, then the connection banner, the DM's frame bar, a map
 *   layer that did not load, "Your turn" and the toasts. They push the
 *   body down rather than lie over it, so the body still scrolls every
 *   control into reach, and nothing in it covers them: on a 480 x 320
 *   phone at 130% two lasting notices covered the Log's Send, and the
 *   tracker's sticky round header covered "Your turn" and the toasts. The
 *   short ones take their room for the few seconds they show.
 * - The folded alerts' status region, visually hidden.
 *
 * A live region speaks what changes in it, not what it holds as it
 * appears, so one already showing moves with its text and is not spoken
 * again.
 */

export type ModalSlotName = "preview" | "connection" | "frame" | "quiet" | "turn" | "toasts" | "status";

const SHOWN: readonly ModalSlotName[] = ["preview", "connection", "frame", "quiet", "turn", "toasts"];

/** The places of notices that go by themselves within seconds. */
const PASSING: readonly ModalSlotName[] = ["turn", "toasts"];
const NAMES: readonly ModalSlotName[] = [...SHOWN, "status"];

type Slots = Readonly<Partial<Record<ModalSlotName, HTMLElement>>>;

/** Per Room page (state/scope.ts): a "view as a player" preview has its own room, and its own very short sheet. */
export const modalSlotsSlot = scopeSlot(() => createStore<{ slots: Slots }>(() => ({ slots: {} })));

/** This notice's place inside the modal sheet while it shows, else null: render in place. */
export function useModalSlot(name: ModalSlotName): HTMLElement | null {
  return useStore(useScoped(modalSlotsSlot), (s) => s.slots[name] ?? null);
}

/**
 * The room the passing notices ("Your turn" and the toasts) take from the
 * very short sheet's body while they show: each one's height and the gap
 * it brings, the column's gap or the places' foot padding, which
 * globals.css keeps the same. A part that sizes itself from the body, such
 * as the round header (panels/TrackerPanel.tsx), adds it back, so a notice
 * of a few seconds never changes it. A notice that lasts keeps its room
 * taken. 0 outside the very short sheet.
 */
export function passingNoticesPx(inside: Element): number {
  const notices = inside.closest("dialog")?.querySelector("[data-rvtt-modal-notices]");
  if (!notices) return 0;
  const gap = parseFloat(getComputedStyle(notices).rowGap) || 0;
  let px = 0;
  for (const name of PASSING) {
    const place = notices.querySelector<HTMLElement>(`[data-rvtt-modal-slot="${name}"]`);
    if (place && place.offsetHeight > 0) px += place.offsetHeight + gap;
  }
  return px;
}

/** Renders `node` in its place in the modal sheet while one shows, else where it stands. */
export function inModal(node: ReactNode, slot: HTMLElement | null): ReactNode {
  return slot ? createPortal(node, slot) : node;
}

const COLUMN: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: theme.space(2), width: "100%" };

/**
 * The places, under the header in the order above. They publish themselves
 * in a layout effect, so a notice moves in before the modal paints. Empty
 * places take no room (globals.css).
 */
export function ModalSlots() {
  const store = useScoped(modalSlotsSlot);
  const refs = useRef<Partial<Record<ModalSlotName, HTMLElement | null>>>({});
  useLayoutEffect(() => {
    const found = NAMES.map((name) => [name, refs.current[name]] as const);
    if (found.some(([, el]) => !el)) return;
    store.setState((s) => ({ slots: { ...s.slots, ...Object.fromEntries(found) } }));
    return () =>
      store.setState((s) => {
        const slots = { ...s.slots };
        for (const [name] of found) delete slots[name];
        return { slots };
      });
  }, [store]);
  const place = (name: ModalSlotName) => (el: HTMLDivElement | null) => {
    refs.current[name] = el;
  };
  return (
    // Only the sides inline: a padding shorthand here would beat globals.css's foot padding, which passingNoticesPx counts.
    <div data-rvtt-modal-notices="" style={{ ...COLUMN, flex: "none", paddingInline: theme.space(3) }}>
      {SHOWN.map((name) => (
        <div key={name} ref={place(name)} data-rvtt-modal-slot={name} style={COLUMN} />
      ))}
      <div ref={place("status")} data-rvtt-modal-slot="status" style={VISUALLY_HIDDEN} />
    </div>
  );
}
