import { useEffect, useRef } from "react";
import type { LogEntry } from "#shared/model.ts";
import { arrivals } from "../areas/reminders.ts";
import { useConfirmedSeq } from "../encounter/hooks.ts";
import { describeEvent, type LogNames } from "../log/format.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import type { Role } from "./drop.ts";

/** The toasts for teleports among newly arrived log lines: "Thorn teleported past a wall." */
export function teleportToasts(fresh: readonly LogEntry[], names: LogNames): string[] {
  return fresh.flatMap((entry) => (entry.data?.type === "teleport" ? [describeEvent(entry.data, names)] : []));
}

/**
 * The DM's note about a "Teleport here" (docs/design-v1-maps-vision.md
 * 4.1): every DM device shows the DM-only log line as a short toast when
 * it arrives, so a teleport past a wall never goes unnoticed. Players never
 * receive the line. The Log keeps it either way.
 */
export function useTeleportToasts(role: Role): void {
  const log = useRoomView((s) => s.view?.log);
  const confirmedSeq = useConfirmedSeq();
  const ui = useRoomUi();
  const store = useRoomStore();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!log || role !== "dm") return;
    const { seen: next, fresh } = arrivals(seen.current, log, confirmedSeq);
    seen.current = next;
    const view = store.getState().view;
    if (!view) return;
    for (const text of teleportToasts(fresh, view)) ui.notify(text, "info");
  }, [log, confirmedSeq, role, ui, store]);
}

/** The toasts as one of the board's controllers (features/layers.ts CONTROLLERS), mounted once outside both drawing trees, so each toasts once. */
export function TeleportToasts(props: { role: Role }): null {
  useTeleportToasts(props.role);
  return null;
}
