import { createElement, lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * React.lazy keeps a failed load for good: rendering the component again
 * throws the same error and never asks the network again. A panel that
 * failed to open while offline could then never open until a reload, which
 * would throw away the edits still queued in memory.
 *
 * So a lazy component made here starts a fresh React.lazy after a failed
 * load, but only when retryFailedLoads() asks. LoadBoundary's Retry button
 * calls it. Making a fresh one on every render instead would retry in a
 * tight loop while the device is still offline.
 *
 * Where the browser fetches the module again, that opens the panel in
 * place. Chrome does not: it remembers a module that failed for the life of
 * the page, so there the retry fails at once and the notice offers a reload
 * instead. Preloading (below) keeps that rare.
 */

const resets = new Set<() => void>();

/** One lazily loaded module. `generation` moves on each time a failed load is reset. */
export class RetryableLoad<T> {
  readonly #load: () => Promise<T>;
  #generation = 0;
  #failed = false;

  constructor(load: () => Promise<T>) {
    this.#load = load;
  }

  get generation(): number {
    return this.#generation;
  }

  run(): Promise<T> {
    return this.#load().catch((err: unknown) => {
      if (!this.#failed) {
        this.#failed = true;
        resets.add(this.#reset);
      }
      throw err;
    });
  }

  readonly #reset = (): void => {
    this.#failed = false;
    this.#generation += 1;
  };
}

/** Lets every load that failed so far try again on its next render. */
export function retryFailedLoads(): void {
  const pending = [...resets];
  resets.clear();
  for (const reset of pending) reset();
}

export type Role = "dm" | "player";

/**
 * Whether a lazy part made for `roles` may load for a viewer of `role`. A
 * part for the DM alone never loads for a player (design section 14.1),
 * however it is mounted. A part told no role loads for everyone.
 */
export function roleMayLoad(roles: readonly Role[], role: unknown): boolean {
  return role !== "dm" && role !== "player" ? true : roles.includes(role);
}

/** Loads a room preloads in the background, with the roles that may use each. */
const preloadable: { load: () => Promise<unknown>; roles: readonly Role[]; started: boolean }[] = [];

/** What preloadLazies asks of the device's connection, a parameter so a test can stand in for the browser's. */
export type Network = { online(): boolean; onceOnline(go: () => void): void };

const browserNetwork: Network = {
  online: () => navigator.onLine !== false,
  onceOnline: (go) => window.addEventListener("online", go, { once: true }),
};

/**
 * Starts loading, without showing, every lazy module this role may open.
 * The Room page calls it once its connection is up, so the first load of
 * the room stays small (design section 14.1) while a panel opened later,
 * offline or after a redeploy removed the old chunks, is already here. A
 * DM-only module never loads for a player. Failures are left for the
 * panel's own load to report.
 *
 * A device that is offline when it is called waits to be back online. The
 * room's socket can still read as open then, for up to ten seconds until
 * its heartbeat gives up (state/socket.ts), but every load started offline
 * fails, and Chrome keeps each failure for the life of the page (above),
 * so none of those panels could open until a reload.
 */
export function preloadLazies(role: Role, network: Network = browserNetwork): void {
  if (!network.online()) {
    network.onceOnline(() => preloadLazies(role, network));
    return;
  }
  for (const entry of preloadable) {
    if (entry.started || !entry.roles.includes(role)) continue;
    entry.started = true;
    entry.load().catch(() => {
      // The panel's own load reports it, if it is ever opened.
    });
  }
}

/**
 * A load that is no component, such as the token icon index, started with
 * the panels' preloads (docs/design-v1-dm-tools.md 3.12), so it is on the
 * device before the connection might drop.
 */
export function preloadInBackground(load: () => Promise<unknown>, roles: readonly Role[]): void {
  preloadable.push({ load, roles, started: false });
}

/**
 * React.lazy, except that a failed load can be tried again (see above).
 * `roles` lists who preloadLazies loads it for. Left out, it is never
 * preloaded.
 */
export function retryableLazy<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  options: { roles?: readonly Role[] } = {},
): ComponentType<P> {
  const loader = new RetryableLoad(load);
  if (options.roles) preloadable.push({ load, roles: options.roles, started: false });
  let made: { generation: number; component: LazyExoticComponent<ComponentType<P>> } | null = null;
  const current = () => {
    if (!made || made.generation !== loader.generation) made = { generation: loader.generation, component: lazy(() => loader.run()) };
    return made.component;
  };
  function Retryable(props: P) {
    return createElement(current(), props);
  }
  return Retryable;
}
