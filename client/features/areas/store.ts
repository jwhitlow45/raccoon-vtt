import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AreaShape, AreaTemplate, RoomState, Scene } from "#shared/model.ts";
import { askedArea } from "#shared/permissions.ts";
import type { TemplatePatch } from "#shared/protocol.ts";
import { PREVIEW_SAMPLES, SAMPLES } from "#shared/rules/aoe.ts";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { RoomActions } from "../../state/types.ts";
import { useRoomStore } from "../../state/view.ts";
import { areaCreatures, choiceOf, draftCaster, savedChoice, seeSelection, type AreaCreature, type SavedChoice, type SelectionSeen } from "./caster.ts";
import { areaContext } from "./coverage.ts";
import { aoeFrame, draftTemplate, newDraft, templateInput, withShape, type AreaDraft, type DraftTemplate, type SnapMode } from "./placement.ts";

/**
 * The area tool's state, which lives on this device only.
 *
 * - `draft`: the area being aimed. Private unless `shared`, and then only
 *   its geometry goes out (design 7.6).
 * - `selectedId`: a placed template being looked at or edited, and `live`
 *   its move or turn in progress, sent as one `template.update` on lift.
 * - `moving`: a finger is moving, so the preview samples boundary cells at
 *   4x4 and refines to 16x16 once the finger rests (design 9.3).
 */
export type AreaToolState = {
  draft: AreaDraft | null;
  shared: boolean;
  selectedId: string | null;
  live: TemplatePatch | null;
  moving: boolean;
  snap: SnapMode;
  /** The shape a tap on the map starts, the last one used. */
  shape: AreaShape;
  /** The next tap on a token picks the caster. */
  pickCaster: boolean;
  query: string;
  /**
   * Who a player's next area starts from (docs/design-v1-area-from-character.md
   * 3.3): kept for the page across areas, tools and scenes, until a reload.
   * The DM has none.
   */
  saved: SavedChoice;
  /**
   * The placed area whose save and damage the DM asked for, which the
   * Areas panel starts as a group save (AreaSaveStart.tsx). It outlives the
   * tool, since the panel opens with any tool.
   */
  damageId: string | null;
  /**
   * The trap whose area the draft aims (docs/design-v1-traps.md 4.1, "Everyone
   * in an area"): Save puts its shape into the trap rather than placing an
   * area, and the tool goes back to the trap's pane.
   */
  forTrap: string | null;
};

/** One Room page's area tool (client/state/scope.ts). */
export type AreaScope = {
  store: StoreApi<AreaToolState>;
  /** The room's selection as last seen, and how often it has changed, whatever tool is active (useSelectionWatch). */
  selection: SelectionSeen;
  /** The selection's count when the saved choice last changed: a selection made after it is fresh (3.3 step 1). */
  choiceAt: number;
  restTimer: ReturnType<typeof setTimeout> | null;
};

export const areaSlot = scopeSlot<AreaScope>(
  () => ({
    store: createStore<AreaToolState>(() => ({
      draft: null,
      shared: false,
      selectedId: null,
      live: null,
      moving: false,
      snap: "15",
      shape: "cone",
      pickCaster: false,
      query: "",
      saved: null,
      damageId: null,
      forTrap: null,
    })),
    selection: { ids: [], count: 0 },
    choiceAt: 0,
    restTimer: null,
  }),
  (a) => {
    if (a.restTimer) clearTimeout(a.restTimer);
    a.restTimer = null;
  },
);

export function useAreaScope(): AreaScope {
  return useScoped(areaSlot);
}

export function useAreaTool<T>(selector: (s: AreaToolState) => T): T {
  return useStore(useAreaScope().store, selector);
}

/** How close, in screen pixels, a press must land to a handle or an origin to grab it. */
export const GRAB_PX = 28;
/** How far past an area's far end its rotation handle sits, in screen pixels. */
export const HANDLE_GAP_PX = 26;

/** What area actions need from the room, from a tool context or from hooks. */
export type AreaEnv = {
  actions: RoomActions;
  view: RoomState;
  scene: Scene;
  role: "dm" | "player";
  youId: string;
  area: AreaScope;
};

/** How long a finger must rest before the preview refines from 4x4 to 16x16 samples. */
export const REST_MS = 160;

export function markMoving(a: AreaScope): void {
  if (!a.store.getState().moving) a.store.setState({ moving: true });
  if (a.restTimer) clearTimeout(a.restTimer);
  a.restTimer = setTimeout(() => markRested(a), REST_MS);
}

export function markRested(a: AreaScope): void {
  if (a.restTimer) clearTimeout(a.restTimer);
  a.restTimer = null;
  if (a.store.getState().moving) a.store.setState({ moving: false });
}

export function samplesNow(moving: boolean): number {
  return moving ? PREVIEW_SAMPLES : SAMPLES;
}

export function memberColor(env: Pick<AreaEnv, "view" | "youId">): string {
  return env.view.members[env.youId]?.color ?? theme.color.crest;
}

/**
 * Whether the viewer may move, size, aim or delete the area: the DM, or its
 * owner while no ask for saves names it, so a player never changes what the
 * DM is resolving (docs/design-v1-player-save-spell.md 5.4). The server
 * refuses the same, as the backstop.
 */
export function canEdit(env: Pick<AreaEnv, "role" | "youId"> & { view?: Pick<RoomState, "casts"> }, t: Pick<AreaTemplate, "ownerId"> & { id?: string }): boolean {
  if (env.role === "dm") return true;
  if (t.ownerId !== env.youId) return false;
  return t.id === undefined || env.view === undefined || !askedArea(env.view, t.id);
}

export function currentTemplate(env: Pick<AreaEnv, "view">, draft: AreaDraft | null): DraftTemplate | null {
  return draft ? draftTemplate(draft, env.view.tokens, env.view.meta.settings.feetPerCell) : null;
}

/**
 * A new draft of the last shape used, cast from `casterId`: a player's
 * saved choice (resolvedChoice), or nothing for the DM.
 */
export function startDraft(env: AreaEnv, casterId: string | null): AreaDraft {
  const d = newDraft(env.actions.newId(), env.area.store.getState().shape, memberColor(env));
  const caster = casterId ? env.view.tokens[casterId] : undefined;
  if (caster && caster.sceneId === env.scene.id) {
    d.casterId = caster.id;
    d.lastCaster = caster.id;
  }
  return d;
}

/** The viewer's own creatures on this scene, which the From control offers (3.1). None for the DM. */
export function yourCreatures(env: Pick<AreaEnv, "view" | "scene" | "role" | "youId">): AreaCreature[] {
  return areaCreatures({ view: env.view, sceneId: env.scene.id, you: { memberId: env.youId, role: env.role } });
}

/** Who a player's next area starts from now: the saved choice resolved against their creatures here (3.3 steps 2 and 3). */
export function resolvedChoice(env: AreaEnv, creatures: readonly AreaCreature[] = yourCreatures(env)): string | null {
  return savedChoice({ creatures, tokens: env.view.tokens, sceneId: env.scene.id, choice: env.area.store.getState().saved, selected: { id: null, fresh: false }, role: env.role }).casterId;
}

/** Sets a player's saved choice. A selection made before this no longer counts as fresh. */
export function setChoice(env: Pick<AreaEnv, "area" | "role">, choice: SavedChoice): void {
  if (env.role === "dm") return;
  env.area.choiceAt = env.area.selection.count;
  env.area.store.setState({ saved: choice });
}

/**
 * Whether the area's caster is one of the viewer's creatures: then a tap
 * on another creature aims rather than casts (3.5). Never for the DM.
 */
export function castsYours(env: AreaEnv, d: AreaDraft, creatures: readonly AreaCreature[] = yourCreatures(env)): boolean {
  const caster = draftCaster(d);
  return caster !== null && creatures.some((c) => c.tokenId === caster);
}

/** A tap or Set caster made `casterId` the area's caster: where it is one of the player's creatures, it is their choice too (3.3). */
export function noteCaster(env: AreaEnv, casterId: string | null): void {
  const creature = casterId === null ? undefined : yourCreatures(env).find((c) => c.tokenId === casterId);
  if (creature) setChoice(env, choiceOf(creature));
}

/**
 * Counts every change of the room's selection, whatever tool is active,
 * so the area tool can tell a selection made since the choice changed
 * from an old one (3.3 step 1). Mounted with the board, which is always
 * drawn in a room.
 */
export function useSelectionWatch(): void {
  const store = useRoomStore();
  const area = useAreaScope();
  useEffect(() => {
    const see = () => {
      area.selection = seeSelection(area.selection, store.getState().local.selectedIds);
    };
    see();
    return store.subscribe(see);
  }, [store, area]);
}

/** Replaces the draft and, while it is shared, sends its geometry. */
export function setDraft(env: AreaEnv, draft: AreaDraft | null): void {
  const areaStore = env.area.store;
  const prev = areaStore.getState();
  if (prev.draft && prev.shared && (!draft || draft.id !== prev.draft.id)) env.actions.sendEph({ k: "aoeEnd", id: prev.draft.id });
  areaStore.setState({ draft, shared: draft && draft.id === prev.draft?.id ? prev.shared : false, ...(draft ? { shape: draft.shape } : null) });
  if (draft && areaStore.getState().shared) sendFrame(env);
}

/**
 * A new shape, which the row and the tool's key both pick: the next area's
 * while idle, or the draft's, which takes the new shape's own size and
 * keeps its point, aim, caster and sharing (placement.ts withShape).
 */
export function pickAreaShape(env: AreaEnv, shape: AreaShape): void {
  const { draft } = env.area.store.getState();
  if (draft) setDraft(env, withShape(draft, shape));
  else env.area.store.setState({ shape });
}

export function sendFrame(env: AreaEnv): void {
  const { draft, shared } = env.area.store.getState();
  if (!draft || !shared) return;
  const t = currentTemplate(env, draft);
  if (t) env.actions.sendEph(aoeFrame(t));
}

export function setShared(env: AreaEnv, shared: boolean): void {
  const { draft } = env.area.store.getState();
  if (!draft) return;
  if (!shared) env.actions.sendEph({ k: "aoeEnd", id: draft.id });
  env.area.store.setState({ shared });
  if (shared) sendFrame(env);
}

/** Places the draft as a template (design 9.3) and selects it, so its In area list stays in view. */
export function placeDraft(env: AreaEnv): void {
  const { draft, shared } = env.area.store.getState();
  if (!draft) return;
  const t = currentTemplate(env, draft);
  if (!t) return;
  const template = templateInput(t, {
    sceneId: env.scene.id,
    ownerId: env.youId,
    color: draft.color,
    spell: draft.spell,
    visibility: env.role === "dm" ? draft.visibility : "all",
  });
  if (env.actions.dispatch({ t: "template.create", template }) === null) return;
  if (shared) env.actions.sendEph({ k: "aoeEnd", id: draft.id });
  env.area.store.setState({ draft: null, shared: false, selectedId: t.id, live: null, query: "", pickCaster: false });
}

export function cancelDraft(env: AreaEnv): void {
  setDraft(env, null);
  env.area.store.setState({ query: "", pickCaster: false });
}

export function select(a: AreaScope, id: string | null): void {
  a.store.setState({ selectedId: id, live: null });
}

export function updateTemplate(env: AreaEnv, id: string, patch: TemplatePatch): void {
  env.actions.dispatch({ t: "template.update", templateId: id, patch });
}

export function deleteTemplate(env: AreaEnv, id: string): void {
  env.actions.dispatch({ t: "template.delete", templateId: id });
  if (env.area.store.getState().selectedId === id) select(env.area, null);
}

/**
 * Opens the Areas panel on a placed area's group save (DM only, docs/design-v1-roll-options.md 5.6).
 * `from` is the panel the press was in, the Areas panel's own list, so
 * with two panels its page opens where the panel is (docs/design-v1-split-panel.md 5.1).
 */
export function openDamage(a: AreaScope, ui: { openPanel(id: string, how?: { from: string }): void }, templateId: string, from?: string | null): void {
  a.store.setState({ damageId: templateId });
  ui.openPanel("areas", from ? { from } : undefined);
}

/** Ends everything the tool showed: the draft (and its shared frame) and the selection. */
export function resetAreaTool(a: AreaScope, actions: RoomActions | null): void {
  const { draft, shared } = a.store.getState();
  if (actions && draft && shared) actions.sendEph({ k: "aoeEnd", id: draft.id });
  markRested(a);
  a.store.setState({ draft: null, shared: false, selectedId: null, live: null, pickCaster: false, query: "", forTrap: null });
}

/** The rules context for drawing or listing the area being worked on. */
export function liveContext(view: RoomState, scene: Scene, moving: boolean) {
  return areaContext(view, scene, samplesNow(moving));
}
