import { useMemo } from "react";
import { labelOf, labelsFor, type Label, type Labels, type LabelView } from "../lib/labels.ts";
import { initialsOf } from "../lib/tokenView.ts";
import type { RoomView } from "./types.ts";
import { useRoomView } from "./view.ts";

/**
 * The room's label map (the creature numbers design, section 4, D-261110-316):
 * made once per view and role, and kept by the view object itself, so every
 * store that draws a room (the live one, a player preview, a table display)
 * shares the one rule with nothing to fill in. Each entry keeps its object
 * while it does not change (labels.ts labelsFor), so a row that reads one
 * token's label redraws only when that label does. A module-wide current
 * map was rejected: a memoized row would keep an old preview.
 */
const byView = new WeakMap<LabelView, { dm?: Labels; player?: Labels }>();
/** The last map made for each role, whose unchanged entries the next one keeps. */
const last: { dm?: Labels; player?: Labels } = {};

const NO_LABELS: Labels = new Map();

/** Every token's label in the state's view, for this viewer's role. */
export function labelsOf(s: Pick<RoomView, "view" | "you">): Labels {
  const view = s.view;
  if (!view) return NO_LABELS;
  const role = s.you?.role === "dm" ? "dm" : "player";
  let made = byView.get(view);
  if (!made) byView.set(view, (made = {}));
  const hit = made[role];
  if (hit) return hit;
  const labels = labelsFor(view, role, last[role]);
  made[role] = labels;
  last[role] = labels;
  return labels;
}

/** The room's label map, for a screen that names many tokens and passes it to `displayName`. */
export function useLabels(): Labels {
  return useRoomView(labelsOf);
}

/** One token's label, which changes only when that label does. */
export function useLabel(token: { id: string; name: string; number?: number }): Label {
  const entry = useRoomView((s) => labelsOf(s).get(token.id));
  return useMemo(() => entry ?? labelOf(undefined, token), [entry, token]);
}

/** One token's initials as its body and portrait draw them (tokenView.ts initialsOf). */
export function useInitials(token: { id: string; name: string; number?: number }): { text: string; preview: boolean } {
  const label = useLabel(token);
  return useMemo(() => initialsOf(label), [label]);
}
