import type { Drawing, RoomSettings } from "#shared/model.ts";
import { drawsAllowed } from "#shared/permissions.ts";

/**
 * What the Draw tool offers this viewer (docs/design-v1-dm-tools.md 3.9),
 * by the rule the server applies (shared/permissions.ts drawsAllowed):
 *
 * - `draw`: everything, for the DM and for players the room lets draw.
 * - `erase`: a player the DM has not let draw, who still has drawings of
 *   their own on this scene. Erasing and clearing their own stay allowed,
 *   so the tool stays with only its eraser and "Clear mine".
 * - `none`: no Draw tool at all.
 *
 * Kept rulers are drawings in the model but measurements of the ruler
 * tool, so they neither need the permission nor count as drawings here.
 */
export type DrawAccess = "draw" | "erase" | "none";

type Drawings = Readonly<Record<string, Pick<Drawing, "ownerId" | "sceneId" | "kind"> | undefined>>;

/*
 * Whether a member has drawings on a scene, kept per drawings record, which
 * the store replaces on every change and never edits. The toolbar asks on
 * every store update, so a scene of 2,000 drawings is walked once per
 * change, not once per frame of someone's drag.
 */
const owners = new WeakMap<Drawings, Set<string>>();

function ownersOf(drawings: Drawings): Set<string> {
  let set = owners.get(drawings);
  if (set) return set;
  set = new Set();
  for (const d of Object.values(drawings)) if (d && d.kind !== "ruler") set.add(`${d.sceneId}|${d.ownerId}`);
  owners.set(drawings, set);
  return set;
}

export function drawAccess(input: {
  role: "dm" | "player";
  memberId: string;
  settings: Partial<Pick<RoomSettings, "playersDraw">>;
  drawings: Drawings;
  sceneId: string | null;
}): DrawAccess {
  if (input.role === "dm" || drawsAllowed(input.settings, input.memberId)) return "draw";
  return input.sceneId !== null && ownersOf(input.drawings).has(`${input.sceneId}|${input.memberId}`) ? "erase" : "none";
}

/** The words a player sees when the DM takes drawing away while their Draw tool is open. */
export const DRAWING_TURNED_OFF = "The DM turned off drawing for you.";
