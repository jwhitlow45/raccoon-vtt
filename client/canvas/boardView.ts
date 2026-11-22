import { createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PillProps } from "../features/measure/Pill.tsx";
import type { Box } from "../lib/boardText.ts";
import { NO_INSETS, screenToView, type Camera, type Insets, type Size } from "../lib/camera.ts";
import { onCameraMove, type LiveCamera, liveCameraSlot } from "../state/liveCamera.ts";
import { scopeSlot, useScoped } from "../state/scope.ts";
import { useTreeShown } from "./relief/context.ts";

/**
 * The board in view, in view space (lib/view.ts), two ways: `clear`, the
 * part the bars over the map leave (`insets`, in screen px), which a readout
 * near the screen's edge slides back into (Pill.tsx), and `canvas`, the
 * whole canvas, which what is drawn culls by, since the map shows beside a
 * bar's narrower parts such as the options line
 * (features/builder/heights/HeightLayer.tsx). In Top-down view space is the
 * world's cells. In Isometric it is the turned and squashed picture, so a
 * box here holds what stands upright there, never a stretch of ground.
 */
export type BoardViews = { clear: Box; canvas: Box };

/** The part of the board in `insets` of the canvas, in view space. */
export function boardViewOf(cam: Camera, size: Size, insets: Insets): Box {
  const a = screenToView(cam, { x: insets.left, y: insets.top });
  const b = screenToView(cam, { x: size.width - insets.right, y: size.height - insets.bottom });
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
}

export function boardViewsOf(cam: Camera, size: Size, insets: Insets): BoardViews {
  return { clear: boardViewOf(cam, size, insets), canvas: boardViewOf(cam, size, NO_INSETS) };
}

/** Null until the canvas has a size. */
export const BoardViewContext = createContext<BoardViews | null>(null);

export function useBoardView(): BoardViews | null {
  return useContext(BoardViewContext);
}

/**
 * The clear part of the board at the camera's last rest, in view space as
 * `clear` is: for a layer that places its pills by where the screen's edge
 * slides them (features/floors/LinkLayer.tsx), which must not lay out on
 * every frame of a pan (docs/design/design-v1-relief-pan.md 5.8). Every
 * stage reads this one box, where the ground stage's board view is its cull
 * box, so both place the same pills. Null until the canvas has a camera.
 */
export const restViewSlot = scopeSlot(() => createStore<{ rest: Box | null }>(() => ({ rest: null })));

/** How long the camera holds still before the rest view follows it: past a frame's gap, so no pan or pinch writes it mid-gesture. */
export const REST_MS = 150;

type RestStore = StoreApi<{ rest: Box | null }>;

function sameBox(a: Box | null, b: Box): boolean {
  return a !== null && a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/**
 * Keeps `store` on the clear view of `live`'s camera: at once when it
 * starts, since the size or the bars changed or nothing is held yet, then
 * REST_MS after each camera move with no later one. Returns the stop.
 */
export function watchRestView(live: LiveCamera, store: RestStore, size: Size, insets: Insets): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    timer = undefined;
    const c = live.camera;
    if (!c) return;
    const view = boardViewOf(c, size, insets);
    if (!sameBox(store.getState().rest, view)) store.setState({ rest: view });
  };
  settle();
  const stop = onCameraMove(live, () => {
    clearTimeout(timer);
    timer = setTimeout(settle, REST_MS);
  });
  return () => {
    stop();
    clearTimeout(timer);
  };
}

/** The board's writer of the rest view (canvas/Stage.tsx), from the canvas's size and the bars over it. */
export function useWriteRestView(size: Size | null, insets: Insets): void {
  const live = useScoped(liveCameraSlot);
  const store = useScoped(restViewSlot);
  const { top, right, bottom, left } = insets;
  const width = size?.width;
  const height = size?.height;
  useLayoutEffect(() => {
    if (width === undefined || height === undefined) return;
    return watchRestView(live, store, { width, height }, { top, right, bottom, left });
  }, [live, store, width, height, top, right, bottom, left]);
}

const NO_SUBSCRIBE = () => () => {};

/** The rest view, held while the tree is hidden, so a write after a Top-down pan renders nothing of the hidden isometric tree. */
export function useRestView(): Box | null {
  const store = useScoped(restViewSlot);
  const shown = useTreeShown();
  const held = useRef(store.getState().rest);
  const get = shown ? () => store.getState().rest : () => held.current;
  const view = useSyncExternalStore(shown ? store.subscribe : NO_SUBSCRIBE, get, get);
  held.current = view;
  return view;
}

/**
 * Pills other layers draw over the tokens' ground (an area's name, the move
 * marker), by the layer that owns them. Token labels keep off them
 * (useBoardText.ts), and those layers place their pills from token bodies
 * alone, never from where labels went, so the two never chase each other.
 *
 * A layer publishes its pill as it draws it, minus the zoom: where it
 * points and what it says. The canvas works out its box at each zoom
 * itself, so a pinch never sends a fresh pill through the store, and the
 * board lays out once a frame.
 */
export type PillSpec = Omit<PillProps, "scale" | "color">;

export const boardPillsSlot = scopeSlot(() => createStore<{ pills: Readonly<Record<string, readonly PillSpec[]>> }>(() => ({ pills: {} })));

const NONE: readonly PillSpec[] = [];
const pillOwnersSlot = scopeSlot(() => new Map<string, Map<symbol, readonly PillSpec[]>>());

type PillStore = StoreApi<{ pills: Readonly<Record<string, readonly PillSpec[]>> }>;
type PillOwners = Map<string, Map<symbol, readonly PillSpec[]>>;
type PillClaim = { store: PillStore; owners: PillOwners; key: string; owner: symbol; shown: boolean };

/** The publishing half of usePublishPills, a plain function so the ordering rules can be driven without React. */
export function publishPillsEffect(c: PillClaim, pills: readonly PillSpec[]): void {
  if (!c.shown) return;
  // Claim equal geometry too, so the previous tree's cleanup cannot
  // delete the newly shown tree's publication.
  const publishers = c.owners.get(c.key) ?? new Map<symbol, readonly PillSpec[]>();
  publishers.delete(c.owner);
  publishers.set(c.owner, pills);
  c.owners.set(c.key, publishers);
  const current = c.store.getState().pills[c.key] ?? NONE;
  if (JSON.stringify(current) === JSON.stringify(pills)) return;
  c.store.setState((s) => ({ pills: { ...s.pills, [c.key]: pills } }));
}

/** The cleanup half: returns what runs when the tree stops being the one shown or unmounts. */
export function retractPillsEffect(c: PillClaim): (() => void) | undefined {
  if (!c.shown) return undefined;
  return () => {
    const publishers = c.owners.get(c.key);
    if (!publishers?.delete(c.owner)) return;
    const remaining = [...publishers.values()].at(-1);
    if (remaining) {
      // Isometric ground and upright layers can publish the same key.
      // Removing either leaves the other layer's current publication.
      if (JSON.stringify(c.store.getState().pills[c.key] ?? NONE) !== JSON.stringify(remaining)) c.store.setState((s) => ({ pills: { ...s.pills, [c.key]: remaining } }));
    } else {
      c.owners.delete(c.key);
      const { [c.key]: _gone, ...rest } = c.store.getState().pills;
      c.store.setState({ pills: rest });
    }
  };
}

/** Only the shown tree publishes. A view switch republishes even an unchanged spec. */
export function usePublishPills(key: string, pills: readonly PillSpec[]): void {
  const store = useScoped(boardPillsSlot);
  const owners = useScoped(pillOwnersSlot);
  const owner = useRef(Symbol());
  const shown = useTreeShown();
  useLayoutEffect(() => publishPillsEffect({ store, owners, key, owner: owner.current, shown }, pills), [store, owners, key, pills, shown]);
  useLayoutEffect(() => retractPillsEffect({ store, owners, key, owner: owner.current, shown }), [store, owners, key, shown]);
}

/** Every published pill. */
export function useBoardPills(): readonly PillSpec[] {
  const pills = useStore(useScoped(boardPillsSlot), (s) => s.pills);
  return useMemo(() => Object.values(pills).flat(), [pills]);
}

/** The pills published under keys that do not start with `prefix`. */
export function pillsExcept(pills: Readonly<Record<string, readonly PillSpec[]>>, prefix: string): PillSpec[] {
  return Object.entries(pills).flatMap(([key, list]) => (key.startsWith(prefix) ? [] : list));
}

/**
 * Every pill but those under keys starting with `prefix`, kept the same
 * array while they do not change, so a layer that reads them and publishes
 * its own does not lay out again on every publish of its own.
 */
export function useBoardPillsExcept(prefix: string): readonly PillSpec[] {
  const pills = useStore(useScoped(boardPillsSlot), (s) => s.pills);
  const kept = useMemo(() => pillsExcept(pills, prefix), [pills, prefix]);
  const key = JSON.stringify(kept);
  // Keyed on what the pills say, not on the store's object, which changes whenever any layer publishes.
  return useMemo(() => kept, [key]);
}
