import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AreaShape, AreaTemplate, RoomState, Scene } from "#shared/model.ts";
import type { TemplatePatch } from "#shared/protocol.ts";
import { PREVIEW_SAMPLES, SAMPLES } from "#shared/rules/aoe.ts";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import type { RoomActions } from "../../state/types.ts";
import { areaContext } from "./coverage.ts";
import { aoeFrame, draftTemplate, newDraft, templateInput, type AreaDraft, type DraftTemplate, type SnapMode } from "./placement.ts";

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
   * The placed area whose damage the DM is entering in the Areas panel
   * (AreaDamage.tsx). It outlives the tool, since the panel opens with
   * any tool.
   */
  damageId: string | null;
};

/** One Room page's area tool (client/state/scope.ts). */
export type AreaScope = {
  store: StoreApi<AreaToolState>;
  /** The token selected on the map when the tool opened: the caster a new draft assumes. */
  defaultCaster: string | null;
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
      damageId: null,
    })),
    defaultCaster: null,
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

export function canEdit(env: Pick<AreaEnv, "role" | "youId">, t: Pick<AreaTemplate, "ownerId">): boolean {
  return env.role === "dm" || t.ownerId === env.youId;
}

export function currentTemplate(env: Pick<AreaEnv, "view">, draft: AreaDraft | null): DraftTemplate | null {
  return draft ? draftTemplate(draft, env.view.tokens, env.view.meta.settings.feetPerCell) : null;
}

/**
 * A new draft of the last shape used. The token selected on the map when the
 * tool opened is the caster, as the person most likely means it to be.
 */
export function startDraft(env: AreaEnv, casterId: string | null): AreaDraft {
  const d = newDraft(env.actions.newId(), env.area.store.getState().shape, memberColor(env));
  const caster = casterId ? env.view.tokens[casterId] : undefined;
  if (caster && caster.sceneId === env.scene.id) d.casterId = caster.id;
  return d;
}

/** Replaces the draft and, while it is shared, sends its geometry. */
export function setDraft(env: AreaEnv, draft: AreaDraft | null): void {
  const areaStore = env.area.store;
  const prev = areaStore.getState();
  if (prev.draft && prev.shared && (!draft || draft.id !== prev.draft.id)) env.actions.sendEph({ k: "aoeEnd", id: prev.draft.id });
  areaStore.setState({ draft, shared: draft && draft.id === prev.draft?.id ? prev.shared : false, ...(draft ? { shape: draft.shape } : null) });
  if (draft && areaStore.getState().shared) sendFrame(env);
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

/** Opens the Areas panel on the damage form for a placed area (DM only). */
export function openDamage(a: AreaScope, ui: { openPanel(id: string): void }, templateId: string): void {
  a.store.setState({ damageId: templateId });
  ui.openPanel("areas");
}

/** Ends everything the tool showed: the draft (and its shared frame) and the selection. */
export function resetAreaTool(a: AreaScope, actions: RoomActions | null): void {
  const { draft, shared } = a.store.getState();
  if (actions && draft && shared) actions.sendEph({ k: "aoeEnd", id: draft.id });
  markRested(a);
  a.store.setState({ draft: null, shared: false, selectedId: null, live: null, pickCaster: false, query: "" });
}

/** The rules context for drawing or listing the area being worked on. */
export function liveContext(view: RoomState, scene: Scene, moving: boolean) {
  return areaContext(view, scene, samplesNow(moving));
}
