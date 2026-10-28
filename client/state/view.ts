import { createContext, createElement, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { assetUrl, type AssetVariant } from "../lib/api.ts";
import type { RoomUi } from "./store.ts";
import type { RoomActions, RoomView } from "./types.ts";

export type {
  AoePreview,
  DragPreview,
  Ended,
  Ephemeral,
  FocusRequest,
  LaserTrail,
  LocalUi,
  Ping,
  RoomActions,
  RoomView,
  RulerPreview,
  Toast,
  You,
} from "./types.ts";
export type { RoomUi } from "./store.ts";

/**
 * How React reads a room. Components never see where the data comes from:
 * the live store (store.ts, fed by socket.ts) in a real room, and the same
 * store fed by a local stand-in for the server on the dev fixture page.
 */
export type RoomViewStore = Pick<StoreApi<RoomView>, "getState" | "getInitialState" | "subscribe">;

/** Where image bytes come from. The fixture swaps in local placeholder images. */
export type AssetSource = { url(assetId: string, variant: AssetVariant): string };

const defaultAssets: AssetSource = { url: assetUrl };

type RoomContextValue = { store: RoomViewStore; actions: RoomActions; ui: RoomUi; assets: AssetSource; display: boolean };

const RoomContext = createContext<RoomContextValue | null>(null);

export function RoomProvider(props: {
  store: RoomViewStore;
  actions: RoomActions;
  ui: RoomUi;
  assets?: AssetSource;
  /**
   * A table display's room (features/display/DisplayRoom.tsx). Its store
   * reads as a player who owns nothing, so the few places a display differs
   * from a player, such as a tap on a pin, ask this instead.
   */
  display?: boolean;
  children: ReactNode;
}) {
  const value: RoomContextValue = { store: props.store, actions: props.actions, ui: props.ui, assets: props.assets ?? defaultAssets, display: props.display === true };
  return createElement(RoomContext.Provider, { value }, props.children);
}

function useRoomContext(): RoomContextValue {
  const ctx = useContext(RoomContext);
  if (!ctx) throw new Error("Room components must render inside RoomProvider");
  return ctx;
}

/**
 * Reads the room with a selector. Return values already in the state, such
 * as `s => s.view?.tokens[id]`, so the component re-renders only when that
 * slice changes. A selector must not build a new object or array on every
 * call: derive those with useMemo from stable slices instead.
 */
export function useRoomView<T>(selector: (s: RoomView) => T): T {
  return useStore(useRoomContext().store, selector);
}

/**
 * The viewer's role, and whether the room is a table display's, for a
 * control that also draws outside a room, as a unit test renders it: null
 * there, where useRoomView would throw.
 */
export function useRoomRoleIfAny(): { role: "dm" | "player"; display: boolean } | null {
  const ctx = useContext(RoomContext);
  const store = ctx?.store ?? null;
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : () => {}), [store]);
  const read = () => (store ? (store.getState().you?.role ?? "player") : null);
  const role = useSyncExternalStore(subscribe, read, read);
  return ctx && role ? { role, display: ctx.display } : null;
}

/** The store itself, for code outside render that reads the latest state, such as a tool's pointer handler. */
export function useRoomStore(): RoomViewStore {
  return useRoomContext().store;
}

export function useRoomActions(): RoomActions {
  return useRoomContext().actions;
}

/** The active tool, the selection and the open panel. */
export function useRoomUi(): RoomUi {
  return useRoomContext().ui;
}

export function useAssets(): AssetSource {
  return useRoomContext().assets;
}

/** Whether this room is a table display's, which shows the table and takes no input on the map. */
export function useIsDisplay(): boolean {
  return useRoomContext().display;
}
