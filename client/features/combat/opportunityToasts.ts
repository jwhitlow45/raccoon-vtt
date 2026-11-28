import { createElement, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { RoomState, Viewer } from "#shared/model.ts";
import { reachWords } from "#shared/rules/opportunity.ts";
import { displayName } from "../../lib/scene.ts";
import type { Labels } from "../../lib/labels.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useLabels } from "../../state/labels.ts";
import { useRoomUi, useRoomView, useRoomYouIfAny } from "../../state/view.ts";
import { viewAsSlot } from "../dm/viewAs.tsx";
import { shownLeavesSlot, type ShownLeaves } from "../movement/store.ts";
import { answersFor } from "./logic.ts";
import { useTurnReach, type TurnReach } from "./opportunity.ts";

/*
 * The DM's Opportunity Attack toasts (docs/design/design-v1-opportunity-attacks.md
 * 1, The DM's toast, D-261128-060): when a player answers for the mover, the
 * DM has no turn card, so each DM device says "Bree left Goblin 2's reach."
 * as a new leg's job finishes. It names a creature once a turn on this
 * device, skips a leg this device's own drag line already named, and seeds
 * itself from the legs already stored whenever it mounts or the turn
 * changes (Previous too), so a reload, a second DM device or a late join
 * repeats nothing. While the DM views as a player it says nothing and
 * seeds what lands. A join is no new leg, and a part that finishes after
 * it says only its own creatures not yet said.
 */

/** What one read of the toasts takes: the jobs' notices, with which legs the server's copy holds, the room as this device holds it, and what this device's drops showed. */
export type ToastInput = {
  reach: TurnReach;
  view: Pick<RoomState, "tokens" | "characters" | "encounter">;
  viewer: Viewer;
  previewing: boolean;
  shown: readonly ShownLeaves[];
  labels: Labels;
};

/** The toasts' memory on this device: the turn it seeded for, the legs it has read, and the creatures it named. */
export class ReachToasts {
  #turn: string | null = null;
  #read = new Set<number>();
  #seeded = new Set<number>();
  #named = new Set<string>();

  /** The toasts this read brings, each once. */
  step(input: ToastInput): string[] {
    const { reach, view, viewer } = input;
    if (viewer.role !== "dm") return [];
    // The turn itself, not who moved in it: an Undo of a mover's only leg takes its path away, and its next leg is the same turn's.
    const encounter = view.encounter;
    const turn = `${reach.key ?? ""}|${encounter?.activeEntryId ?? ""}|${encounter?.round ?? ""}|${encounter?.turnStart?.seq ?? Object.values(reach.movers)[0]?.turn ?? ""}`;
    if (turn !== this.#turn) {
      // A new turn, a mount, a reload or a late join: what is stored now was the table's before this device looked.
      this.#turn = turn;
      this.#read.clear();
      this.#named.clear();
      this.#seeded = new Set(Object.values(reach.movers).flatMap((m) => m.legs.flatMap((l) => l.parts.map((p) => p.id))));
    }
    const out: string[] = [];
    for (const [moverId, mover] of Object.entries(reach.movers)) {
      const creature = turnCreature(view);
      // The DM's own movers are the DM's turn card's.
      const toasts = creature !== null && !answersFor(view, viewer, creature);
      const rows = new Set(mover.rows.map((r) => r.left.id));
      for (const leg of mover.legs) {
        for (const part of leg.parts) {
          if (this.#read.has(part.id)) continue;
          if (this.#seeded.has(part.id) || input.previewing || !toasts) {
            // Seeded: its creatures count as named once it finishes, never toasted.
            if (part.done) {
              this.#read.add(part.id);
              for (const left of part.leaves) this.#named.add(`${moverId}|${left.id}`);
            }
            continue;
          }
          // A leg this device predicted waits for the server to take that very move, a join's parts included.
          if (!part.done || !part.confirmed) continue;
          this.#read.add(part.id);
          // A part that does not provoke says nothing, though a join holding it does: a Teleport joined with a walk is still a Teleport.
          if (part.over || !part.provokes) continue;
          const fresh = part.leaves.filter((l) => rows.has(l.id) && !this.#named.has(`${moverId}|${l.id}`));
          for (const left of fresh) this.#named.add(`${moverId}|${left.id}`);
          if (fresh.length === 0) continue;
          // This device's own drag line already named them at the drop.
          const line = input.shown.find((s) => s.tokenId === moverId && s.x === part.to.x && s.y === part.to.y);
          if (line && fresh.every((l) => line.ids.includes(l.id))) continue;
          const mover = view.tokens[moverId];
          const names = fresh.flatMap((l) => {
            const t = view.tokens[l.id];
            return t ? [displayName(t, input.labels)] : [];
          });
          if (mover && names.length > 0) out.push(`${displayName(mover, input.labels)} ${reachWords(names, "left", false, 3)}.`);
        }
      }
    }
    return out;
  }
}

/** The turn's own creature, whose answerer decides whether the DM has a card for its notice. */
function turnCreature(view: Pick<RoomState, "encounter">): { tokenId: string } | { characterId: string } | null {
  const encounter = view.encounter;
  const entry = encounter?.entries.find((e) => e.id === encounter.activeEntryId);
  if (!entry) return null;
  return entry.tokenId !== undefined ? { tokenId: entry.tokenId } : entry.characterId !== undefined ? { characterId: entry.characterId } : null;
}

/**
 * The toasts as one of the board's controllers (features/layers.ts
 * CONTROLLERS), mounted once outside both drawing trees, so each says its
 * words once. It feeds the turn's jobs too (opportunity.ts useTurnReach),
 * so a drag reads them on every device that drags, whether or not a turn
 * card shows. A table display reads none.
 */
export function OpportunityToasts(): ReturnType<typeof createElement> | null {
  return toastsMount(useRoomYouIfAny()) ? createElement(Toasts) : null;
}

/** Whether the toasts mount on this page: in a room, never on a table display. */
export function toastsMount(room: { display: boolean } | null): boolean {
  return room !== null && !room.display;
}

function Toasts(): null {
  const reach = useTurnReach();
  const view = useRoomView((s) => s.view);
  const you = useRoomView((s) => s.you);
  const ui = useRoomUi();
  const scope = useRoomScope();
  const labels = useLabels();
  const previewing = useStore(scope.get(viewAsSlot).store, (s) => s.target !== null);
  const shown = useStore(useScoped(shownLeavesSlot), (s) => s.shown);
  const toasts = useMemo(() => new ReachToasts(), []);
  const viewer = useMemo(() => (you ? { memberId: you.memberId, role: you.role } : null), [you]);
  useEffect(() => {
    if (!view || !viewer) return;
    for (const text of toasts.step({ reach, view, viewer, previewing, shown, labels })) ui.notify(text, "info");
  }, [reach, view, viewer, previewing, shown, labels, toasts, ui]);
  return null;
}
