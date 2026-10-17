import { createContext, createElement, useContext, type ReactNode } from "react";

/**
 * State that belongs to one Room page rather than to the whole page load: a
 * tool's choices and its gesture in progress, a draft being drawn, the
 * channels between a panel and the map camera.
 *
 * Why: "view as a player" (client/features/dm/PlayerPreview.tsx) mounts a
 * second Room page over the DM's. State kept in module variables was shared
 * by both, so a tool used in the preview wrote into the DM's drafts, and
 * leaving the preview cleared the context the DM's own tool buttons used.
 * Each Room makes one scope, and everything under it reads its own: tool
 * handlers through `ctx.scope`, components through useScoped.
 *
 * A feature declares a slot at module level. The slot holds no state, only
 * how to make it, so the module stays free of shared values:
 *
 *   const drawSlot = scopeSlot(() => ({ store: createStore(...), gesture: null }));
 *   ctx.scope.get(drawSlot)    // in a tool handler
 *   useScoped(drawSlot)        // in a component
 */
export type ScopeSlot<T> = {
  readonly create: () => T;
  /** Stops anything the value runs, such as a timer, when its Room goes away. */
  readonly dispose?: (value: T) => void;
};

export function scopeSlot<T>(create: () => T, dispose?: (value: T) => void): ScopeSlot<T> {
  return dispose ? { create, dispose } : { create };
}

export class RoomScope {
  readonly #values = new Map<ScopeSlot<unknown>, unknown>();

  /** The slot's value in this scope, made on first use. */
  get<T>(slot: ScopeSlot<T>): T {
    if (this.#values.has(slot as ScopeSlot<unknown>)) return this.#values.get(slot as ScopeSlot<unknown>) as T;
    const value = slot.create();
    this.#values.set(slot as ScopeSlot<unknown>, value);
    return value;
  }

  /**
   * Stops what the values run. The values themselves stay: React's
   * development double mount disposes and then keeps using the same Room,
   * and its components still hold these values.
   */
  dispose(): void {
    for (const [slot, value] of this.#values) slot.dispose?.(value);
  }
}

const ScopeContext = createContext<RoomScope | null>(null);

export function RoomScopeProvider(props: { scope: RoomScope; children: ReactNode }) {
  return createElement(ScopeContext.Provider, { value: props.scope }, props.children);
}

export function useRoomScope(): RoomScope {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error("Room components must render inside RoomScopeProvider");
  return scope;
}

/** A slot's value for the Room this component renders in. */
export function useScoped<T>(slot: ScopeSlot<T>): T {
  return useRoomScope().get(slot);
}

/**
 * A slot's value for the Room this component renders in, or null outside
 * any Room, for a shared component that also renders without one, such as
 * a sheet on the dev kit page: it then goes without what the slot gives.
 */
export function useScopedIfAny<T>(slot: ScopeSlot<T>): T | null {
  const scope = useContext(ScopeContext);
  return scope ? scope.get(slot) : null;
}
