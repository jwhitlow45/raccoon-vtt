import { useEffect } from "react";
import type { LogEntry } from "#shared/model.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useIsDisplay, useRoomStore, useRoomUi } from "../../state/view.ts";
import { playTrapSound } from "../encounter/alerts.ts";
import { stopNoteSlot } from "../movement/store.ts";
import { lastMoveSlot } from "../tokens/undoMove.ts";
import { dmAlerts, linesAfter, metTrap, newestId, playerAlerts, watchOf, type Watched } from "./alerts.ts";

const NO_LINES: readonly LogEntry[] = [];

/**
 * What a trap going off tells this device (docs/design-v1-traps.md 4.3).
 * The DM gets a toast and the trap's sound for each new line in the DM's
 * trap log. A player gets one, with its sound, for each players' line that
 * names a creature they play. Sound plays only where this device has it on.
 * And once the server's answer to a player's move shows a trap stopped it
 * or told its players, the token bar's Undo move and the stopped walk's
 * Teleport here go, since the server would refuse them now.
 *
 * Lines already there when the room opens are history, never toasts. A
 * table display shows the log and toasts nothing.
 */
export function useTrapAlerts(): void {
  const store = useRoomStore();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const display = useIsDisplay();
  useEffect(() => {
    if (display) return;
    let started = false;
    let seenLog: string | null = null;
    let seenSeen: string | null = null;
    let lastN = 0;
    const watched = new Map<number, Watched>();
    const update = () => {
      const now = store.getState();
      const view = now.view;
      const you = now.you;
      if (!view || !you) return;
      const trapLog = view.trapLog ?? NO_LINES;
      const trapSeen = view.trapSeen ?? NO_LINES;
      if (!started) {
        started = true;
        seenLog = newestId(trapLog);
        seenSeen = newestId(trapSeen);
        lastN = now.pending.reduce((n, p) => Math.max(n, p.n), 0);
        return;
      }
      const freshLog = linesAfter(trapLog, seenLog);
      const freshSeen = linesAfter(trapSeen, seenSeen);
      if (freshLog.length > 0) seenLog = newestId(trapLog);
      if (freshSeen.length > 0) seenSeen = newestId(trapSeen);
      const alerts = you.role === "dm" ? dmAlerts(freshLog, view) : playerAlerts(freshSeen, view, { memberId: you.memberId, role: you.role });
      for (const a of alerts) {
        ui.notify(a.text, "info");
        if (a.sound) playTrapSound(a.sound);
      }
      if (you.role !== "player") return;
      for (const p of now.pending) {
        if (p.n <= lastN) continue;
        lastN = p.n;
        const w = watchOf(p.op, p.n, newestId(trapSeen));
        if (w) watched.set(p.n, w);
      }
      for (const [n, w] of watched) {
        if (now.pending.some((p) => p.n === n)) continue;
        watched.delete(n);
        if ((now.refused ?? []).includes(n) || !metTrap(w, now.confirmed ?? view, trapSeen)) continue;
        const offers = scope.get(lastMoveSlot);
        const kept = offers.getState().offers.filter((o) => !o.ns.includes(n));
        if (kept.length !== offers.getState().offers.length) offers.setState({ offers: kept });
        const note = scope.get(stopNoteSlot);
        const s = note.getState();
        if (s.note?.n === n && !s.busy) note.setState({ note: null });
      }
    };
    update();
    return store.subscribe(update);
  }, [store, ui, scope, display]);
}
