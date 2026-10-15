import { createStore } from "zustand/vanilla";
import type { DoorRef } from "#shared/protocol.ts";
import { scopeSlot } from "../../state/scope.ts";

/** The door whose pill shows over the map, by how ops name it, or null. */
export type DoorPill = { sceneId: string; ref: DoorRef } | null;

export const doorPillSlot = scopeSlot(() => createStore<{ pill: DoorPill }>(() => ({ pill: null })));
