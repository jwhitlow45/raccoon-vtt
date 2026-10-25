import type { RoomScope } from "../state/scope.ts";
import type { RoomActions, RoomView } from "../state/types.ts";
import { SHAPES } from "./areas/labels.ts";
import { areaSlot, pickAreaShape, type AreaEnv } from "./areas/store.ts";
import { builderSlot, BUILD_MODES, labelPaneSlot, pickBuildMode } from "./builder/store.ts";
import { accessOf, DRAW_MODES, drawSlot, pickDrawMode } from "./drawings/store.ts";
import { fogSlot, FOG_MODES, pickFogMode } from "./fog/store.ts";
import { MEASURES, pickMeasure, rulerSlot } from "./measure/rulerStore.ts";
import { BLANK_KINDS, placementSlot, setPending } from "./tokens/placement.ts";
import { pickZone, trapSlot, ZONE_KINDS } from "./traps/store.ts";

/**
 * Each tool's main choice, which a second press of the tool's key moves
 * through (docs/design-v1-tool-cycle.md 3 and 4.2): the one choice in its
 * row that sets what a tap or a drag does. Each reads the tool's state,
 * never its row, so a press works while the row loads, waits under a
 * phone's sheet or keeps the choice behind ⋯ (2.12). Each list and pick is
 * the row's own, so the key's order is the row's by construction (2.13).
 * Select, Ping, Pin and Line up grid have none.
 */

/** One option of a main choice, with its full name, which the status says. */
export type ChoiceOption = { value: string; label: string; disabled?: boolean };

/**
 * A tool's main choice as its state has it now. `held` gives the words a
 * press says instead of moving, where a move would lose work (2.8).
 */
export type ToolChoice = { options: readonly ChoiceOption[]; value: string; held?: string };

/** What a cycle reads and acts through: the Room page's state, actions and scope, as the shortcut table has them. */
export type CycleEnv = { role: "dm" | "player"; getState(): RoomView; actions: RoomActions; scope: RoomScope };

export type ToolCycle = {
  /** The choice now, or null where the tool's state shows none. */
  now(env: CycleEnv): ToolChoice | null;
  /** Picks an option with the function the row's control calls. */
  pick(env: CycleEnv, value: string): void;
};

/**
 * The option one press moves to: the next, or with `back` the one before,
 * wrapping at both ends and skipping a disabled one. A value missing from
 * the list goes to the first option, or with `back` the last. Null when
 * no option can be used.
 */
export function cycleStep(options: readonly ChoiceOption[], value: string, back: boolean): string | null {
  const n = options.length;
  const at = options.findIndex((o) => o.value === value);
  for (let k = 1; k <= n; k++) {
    const i = at < 0 ? (back ? n - k : k - 1) : (((at + (back ? -k : k)) % n) + n) % n;
    const option = options[i]!;
    if (!option.disabled) return option.value;
  }
  return null;
}

export const SHAPE_HELD = "Finish or cancel the shape first.";
export const TEXT_HELD = "Add or cancel the text first.";
export const SPELL_HELD = "The spell sets the shape. Cancel to pick another.";
export const ROOM_HELD = "Close or cancel the room first.";
export const LABEL_HELD = "Finish or close the label first.";

/** The value as one of the list's own, or undefined, so a pick never sets a value the row lacks. */
function known<T extends string>(options: readonly { value: T }[], value: string): T | undefined {
  return options.find((o) => o.value === value)?.value;
}

function shownScene(s: RoomView) {
  return s.sceneId ? s.view?.scenes[s.sceneId] : undefined;
}

export const rulerCycle: ToolCycle = {
  now: (env) => ({ options: MEASURES, value: env.scope.get(rulerSlot).store.getState().walk ? "walking" : "straight" }),
  pick(env, value) {
    const measure = known(MEASURES, value);
    if (measure) pickMeasure(env.scope, measure);
  },
};

/** The area tool's env, as its row builds it, or null while the row draws nothing. */
function areaEnv(env: CycleEnv): AreaEnv | null {
  const s = env.getState();
  const scene = shownScene(s);
  if (!s.view || !scene || !s.you) return null;
  return { actions: env.actions, view: s.view, scene, role: env.role, youId: s.you.memberId, area: env.scope.get(areaSlot) };
}

/**
 * Area's shape, while idle, placing or aiming a trap's area, and not while
 * a placed area is picked. A shape change makes a fresh draft, which would
 * drop a spell's name, note, range and target, so a spell's draft holds.
 */
export const areaCycle: ToolCycle = {
  now(env) {
    const a = areaEnv(env);
    if (!a) return null;
    const st = a.area.store.getState();
    if (st.draft) return { options: SHAPES, value: st.draft.shape, ...(st.draft.spell ? { held: SPELL_HELD } : {}) };
    const picked = st.selectedId ? a.view.templates[st.selectedId] : undefined;
    if (picked && picked.sceneId === a.scene.id) return null;
    return { options: SHAPES, value: st.shape };
  },
  pick(env, value) {
    const a = areaEnv(env);
    const shape = known(SHAPES, value);
    if (a && shape) pickAreaShape(a, shape);
  },
};

/** Draw's drawing tool, on its full row only: a player who may only erase has no choice, and no D at all (the shortcut's own gate). */
export const drawCycle: ToolCycle = {
  now(env) {
    if (accessOf(env.getState()) !== "draw") return null;
    const st = env.scope.get(drawSlot).store.getState();
    const corners = st.draft?.kind === "polygon" && st.draft.points.length > 0;
    const held = corners ? SHAPE_HELD : st.textAt !== null ? TEXT_HELD : undefined;
    return { options: DRAW_MODES, value: st.mode, ...(held ? { held } : {}) };
  },
  pick(env, value) {
    const mode = known(DRAW_MODES, value);
    if (mode) pickDrawMode(env.scope, mode);
  },
};

/** Fog's Clear or add fog, while fog is on for the scene. A polygon's corners and a waiting draft survive a move, so it never holds. */
export const fogCycle: ToolCycle = {
  now(env) {
    if (!shownScene(env.getState())?.fogEnabled) return null;
    return { options: FOG_MODES, value: env.scope.get(fogSlot).store.getState().mode };
  },
  pick(env, value) {
    const mode = known(FOG_MODES, value);
    if (mode) pickFogMode(env.scope, mode);
  },
};

/** The builder's mode, once the scene is loaded. A mode change drops a shape room's corners and closes a label's pane with its unsaved words, so both hold. */
export const builderCycle: ToolCycle = {
  now(env) {
    if (!shownScene(env.getState())) return null;
    const st = env.scope.get(builderSlot).store.getState();
    const held = st.mode === "poly" && st.poly.length > 0 ? ROOM_HELD : env.scope.get(labelPaneSlot).getState().labelId !== null ? LABEL_HELD : undefined;
    return { options: BUILD_MODES, value: st.mode, ...(held ? { held } : {}) };
  },
  pick(env, value) {
    const mode = known(BUILD_MODES, value);
    if (mode) pickBuildMode(env.scope, mode);
  },
};

/** Add token's blank kind, while nothing else is chosen: monsters or a character waiting to be placed stay. */
export const placeCycle: ToolCycle = {
  now(env) {
    const pending = env.scope.get(placementSlot).store.getState().pending;
    return pending.kind === "blank" ? { options: BLANK_KINDS, value: pending.tokenKind } : null;
  },
  pick(env, value) {
    const tokenKind = known(BLANK_KINDS, value);
    if (tokenKind) setPending(env.scope, { kind: "blank", tokenKind });
  },
};

/** The Trap's zone, on its plain row: not while a pick waits or a trap's pane is open. */
export const trapCycle: ToolCycle = {
  now(env) {
    const st = env.scope.get(trapSlot).store.getState();
    if (st.picking || st.paneId !== null) return null;
    return { options: ZONE_KINDS, value: st.kind };
  },
  pick(env, value) {
    const kind = known(ZONE_KINDS, value);
    if (kind) pickZone(env.scope, kind);
  },
};
