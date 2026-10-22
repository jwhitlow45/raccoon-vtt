import { useEffect, useRef } from "react";
import type { LogEntry } from "#shared/model.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useIsDisplay, useRoomActions, useRoomStore, useRoomUi } from "../../state/view.ts";
import { useStartGroupSave } from "../dice/groupSave/start.ts";
import { playTrapSound } from "../encounter/alerts.ts";
import { stopNoteSlot } from "../movement/store.ts";
import { lastMoveSlot } from "../tokens/undoMove.ts";
import { dmAlerts, linesAfter, metTrap, newestId, playerAlerts, watchOf, type TrapAlert, type Watched } from "./alerts.ts";
import { trapStart } from "./TrapSaveStart.tsx";

const NO_LINES: readonly LogEntry[] = [];

/**
 * What a trap going off tells this device (docs/design-v1-traps.md 4.3).
 * The DM gets a toast and the trap's sound for each new line in the DM's
 * trap log, with Save and damage while its springing waits with a save,
 * damage or conditions, and the Passive Perception hint with Mark found. A
 * player gets one, with its sound, for each players' line that names a
 * creature they play. Sound plays only where this device has it on.
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
  const actions = useRoomActions();
  const scope = useRoomScope();
  const display = useIsDisplay();
  // In a ref, so a scene switch, which makes a new start, never resubscribes and forgets the moves being watched.
  const starter = useStartGroupSave();
  const start = useRef(starter);
  start.current = starter;
  useEffect(() => {
    // Save and damage from the toast: the springing as the room holds it at the tap, which another DM device may have settled.
    const saveAction = (a: TrapAlert) => {
      const trap = a.trapId ? store.getState().view?.traps[a.trapId] : undefined;
      const rig = trap?.rig;
      // The hint never marks anything found by itself: the DM does, from its toast.
      if (a.notice) return trap && !trap.found ? { label: "Mark found", run: () => void actions.dispatch({ t: "trap.update", trapId: trap.id, patch: { found: true } }) } : undefined;
      if (!trap || !rig || !rig.due?.some((d) => d.id === a.due) || (!rig.save && !rig.damage && !rig.conditions)) return undefined;
      return {
        label: rig.save || rig.damage ? "Save and damage" : "Apply",
        run: () => {
          const now = store.getState().view?.traps[trap.id];
          const due = now?.rig?.due?.find((d) => d.id === a.due);
          if (!now || !due) ui.notify("It was settled meanwhile.", "info");
          else if (!start.current(trapStart(now, due))) ui.notify("The open group save holds rolls. Its card's Save and damage asks before it is discarded.", "info");
        },
      };
    };
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
      // The lines the server holds, never a prediction: the DM's own walk replays its trap step here, and its line may come back under another id.
      const held = now.confirmed ?? view;
      const trapLog = held.trapLog ?? NO_LINES;
      const trapSeen = held.trapSeen ?? NO_LINES;
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
        const action = you.role === "dm" ? saveAction(a) : undefined;
        ui.notify(a.text, "info", undefined, action);
        if (a.sound) playTrapSound(a.sound);
      }
      if (you.role !== "player") return;
      for (const p of now.pending) {
        if (p.n <= lastN) continue;
        lastN = p.n;
        const w = watchOf(p.op, p.n);
        if (w) watched.set(p.n, w);
      }
      for (const [n, w] of watched) {
        if (now.pending.some((p) => p.n === n)) continue;
        watched.delete(n);
        if ((now.refused ?? []).includes(n) || !metTrap(w, now.trapped)) continue;
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
  }, [store, ui, actions, scope, display]);
}
