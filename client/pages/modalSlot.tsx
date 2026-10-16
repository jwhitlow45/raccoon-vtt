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
 * - The notices that last, under the sheet's header and above its body:
 *   "Viewing as Pat" first, then the connection banner, the DM's frame bar
 *   and a map layer that did not load. They push the body down rather
 *   than lie over it, so the body still scrolls every control into reach,
 *   which a notice that lasts would otherwise cover for as long as it
 *   shows: on a 480 x 320 phone at 130% two of them covered the Log's Send.
 * - "Your turn" and the toasts over the top of the body, as toasts lie
 *   over the map: they go by themselves within seconds.
 * - The folded alerts' status region, visually hidden.
 *
 * A live region speaks what changes in it, not what it holds as it
 * appears, so one already showing moves with its text and is not spoken
 * again.
 */

export type ModalSlotName = "preview" | "connection" | "frame" | "quiet" | "turn" | "toasts" | "status";

const LASTING: readonly ModalSlotName[] = ["preview", "connection", "frame", "quiet"];
const OVER: readonly ModalSlotName[] = ["turn", "toasts"];

type Slots = Readonly<Partial<Record<ModalSlotName, HTMLElement>>>;

/** Per Room page (state/scope.ts): a "view as a player" preview has its own room, and its own very short sheet. */
export const modalSlotsSlot = scopeSlot(() => createStore<{ slots: Slots }>(() => ({ slots: {} })));

/** This notice's place inside the modal sheet while it shows, else null: render in place. */
export function useModalSlot(name: ModalSlotName): HTMLElement | null {
  return useStore(useScoped(modalSlotsSlot), (s) => s.slots[name] ?? null);
}

/** Renders `node` in its place in the modal sheet while one shows, else where it stands. */
export function inModal(node: ReactNode, slot: HTMLElement | null): ReactNode {
  return slot ? createPortal(node, slot) : node;
}

const COLUMN: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: theme.space(2), width: "100%" };

/**
 * One part of the places: `lasting` under the header, `over` laid over the
 * top of the body with the status region. Each publishes its places in a
 * layout effect, so a notice moves in before the modal paints. Empty
 * places take no room (globals.css), and only what they hold takes a tap,
 * so the panel under the toasts stays in reach.
 */
export function ModalSlots(props: { part: "lasting" | "over" }) {
  const store = useScoped(modalSlotsSlot);
  const refs = useRef<Partial<Record<ModalSlotName, HTMLElement | null>>>({});
  const names = props.part === "lasting" ? LASTING : [...OVER, "status" as const];
  const key = names.join(" ");
  useLayoutEffect(() => {
    const found = key.split(" ").map((name) => [name as ModalSlotName, refs.current[name as ModalSlotName]] as const);
    if (found.some(([, el]) => !el)) return;
    store.setState((s) => ({ slots: { ...s.slots, ...Object.fromEntries(found) } }));
    return () =>
      store.setState((s) => {
        const slots = { ...s.slots };
        for (const [name] of found) delete slots[name];
        return { slots };
      });
  }, [store, key]);
  const place = (name: ModalSlotName) => (el: HTMLDivElement | null) => {
    refs.current[name] = el;
  };
  if (props.part === "lasting") {
    return (
      <div data-rvtt-modal-lasting="" style={{ ...COLUMN, flex: "none", padding: `0 ${theme.space(3)}px` }}>
        {LASTING.map((name) => (
          <div key={name} ref={place(name)} data-rvtt-modal-slot={name} style={COLUMN} />
        ))}
      </div>
    );
  }
  return (
    <div style={{ ...COLUMN, padding: `${theme.space(2)}px ${theme.space(3)}px 0` }}>
      {OVER.map((name) => (
        <div key={name} ref={place(name)} data-rvtt-modal-slot={name} style={COLUMN} />
      ))}
      <div ref={place("status")} data-rvtt-modal-slot="status" style={VISUALLY_HIDDEN} />
    </div>
  );
}
