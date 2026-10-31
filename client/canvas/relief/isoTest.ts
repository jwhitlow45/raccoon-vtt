import { useEffect, useLayoutEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import { ISO_TEST_FLAG } from "../../features/view/choice.ts";
import { pickView, turnView, withPick, withTurn, type StoredView, type ViewPick } from "../../features/view/store.ts";
import type { Camera } from "../../lib/camera.ts";
import type { Turn } from "../../lib/view.ts";
import type { KeptStats } from "./kept.ts";
import type { Item } from "./buckets.ts";
import type { VolumesNow } from "./volumes.ts";

/**
 * A way for tests and the bench to pick and turn without the View menu:
 * with the test flag (features/view/choice.ts ISO_TEST_FLAG) set before
 * the page loads (Playwright's addInitScript), `__rvttIsoHook` picks and
 * turns as the menu does. Nothing a user can do sets it, and it offers
 * nothing the menu does not (docs/design-v1-isometric-view.md 13).
 */
const HOOK = "__rvttIsoHook";

export type Hook = {
  pick(pick: ViewPick | "follow"): void;
  turn(turn: Turn): void;
  layout?(): BoardLayout | null;
  volumes?(): BoardVolumesNow | null;
  /** The board's kept picture's counts (docs/design-v1-relief-pan.md 9 and 10.3). */
  kept?(): KeptCounts | null;
  /** Repaints the relief whole at the camera on screen, on the next frame, as any content change does. */
  repaint?(): void;
  /** The relief canvas's pixels as a PNG data URL, exactly as kept. */
  pixels?(): string | null;
  /** The camera the canvas last drew. */
  drawn?(): Camera | null;
  /** Turns on or off the kept picture's measure of what each scroll paints (kept.ts KeptRelief.measure), for untimed counts only. */
  measure?(on: boolean): void;
};

/** What the bench and the tests count of a board's frames: the kept picture's draws and painted shares, background slices, and board, map and pill provider renders. */
export type KeptCounts = KeptStats & { probe: string; frames: number; draws: number; cameraGroundDraws: number; slices: number; slicesInWhole: number; boardCommits: number; mapCommits: number; pillCommits: number };

/** A mounted board's kept picture, as the hook reads it. */
export type KeptReport = { counts(): Omit<KeptCounts, "boardCommits" | "mapCommits" | "pillCommits"> | null; repaint(): void; pixels(): string | null; drawn(): Camera | null; measure(on: boolean): void };

const keptBoards: KeptReport[] = [];
/** Commits of the isometric board, of the map stage and of the isometric pills' board view, counted only with the test flag. */
const commits = { board: 0, map: 0, pills: 0 };

/** Registers a board's kept picture for the hook while it is mounted, with the test flag only. */
export function useKeptReport(report: () => KeptReport): void {
  const on = flagged();
  useEffect(() => {
    if (!on) return;
    const mine = report();
    keptBoards.push(mine);
    return () => {
      keptBoards.splice(keptBoards.indexOf(mine), 1);
    };
  }, [on]);
}

/**
 * Counts a commit of the board, the map stage or the pills' board view, with
 * the test flag only: a pan inside a cull step commits neither of the first
 * two (docs/design-v1-relief-pan.md 6), and a Top-down pan never the third.
 */
export function useCommitCount(which: "board" | "map" | "pills"): void {
  const on = flagged();
  useLayoutEffect(() => {
    if (on) commits[which]++;
  });
}

/** How many areas stand on the board and whether one waits to, read without the depth list, so the bench can ask each frame of a build at no cost to it. */
export type BoardVolumesNow = { standing: number; waiting: boolean };

/**
 * The isometric board's depth list as the tests read it
 * (docs/design-v1-iso-area-shapes.md 8): its entries in drawing order, a
 * standee by its token's id and an area's band by the area and the band,
 * with the relief's own pieces left out, which areas stand now and
 * whether one waits to, and the colors of the rings at each standee's base.
 */
export type BoardLayout = {
  order: ({ kind: "standee"; id: string } | { kind: "band"; area: string; band: number })[];
  standing: string[];
  waiting: boolean;
  rings: Record<string, string[]>;
};

function flagged(): boolean {
  return typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>)[ISO_TEST_FLAG] === true;
}

/**
 * Every mounted board's hook, the newest last. View as a player mounts a
 * board over the DM's, which takes the hook while it stands. As it goes it
 * hands the hook back to the board under it, which a plain delete took
 * away for good (ISO5P2-FV-4).
 */
const installed: Hook[] = [];

/** Sets `hook` as `__rvttIsoHook`, and returns what takes it away. */
export function installHook(hook: Hook): () => void {
  const g = globalThis as Record<string, unknown>;
  installed.push(hook);
  g[HOOK] = hook;
  return () => {
    installed.splice(installed.indexOf(hook), 1);
    const top = installed.at(-1);
    if (top) g[HOOK] = top;
    else delete g[HOOK];
  };
}

/** What a board laid out last, read into a `BoardLayout` only when the hook asks, so a pan in a test costs what it costs without one. */
type Reported = { items: readonly Item[]; volumes: VolumesNow | null; rings: ReadonlyMap<string, readonly string[]> | null };

/** Each mounted board's last layout, the newest board last: a View as a player board over the DM's is the one the hook reads while it stands, as it takes the hook. */
const boards: { last: Reported | null }[] = [];

/** What a board reports its layout through: with the test flag only, so anything else costs nothing. */
export type LayoutReport = (items: readonly Item[], volumes: VolumesNow | null, rings: ReadonlyMap<string, readonly string[]> | null) => void;

const NO_REPORT: LayoutReport = () => {};

/** A board's place among the boards the hook reads, for as long as it is mounted. */
export function useLayoutReport(): LayoutReport {
  const on = flagged();
  const slot = useRef<{ last: Reported | null } | null>(null);
  useEffect(() => {
    if (!on) return;
    const mine = (slot.current ??= { last: null });
    boards.push(mine);
    return () => {
      boards.splice(boards.indexOf(mine), 1);
    };
  }, [on]);
  if (!on) return NO_REPORT;
  return (items, volumes, rings) => {
    (slot.current ??= { last: null }).last = { items, volumes, rings };
  };
}

function layoutOf(r: Reported | null): BoardLayout | null {
  if (!r) return null;
  const order: BoardLayout["order"] = [];
  for (const item of r.items) {
    if (item.kind === "standee") order.push({ kind: "standee", id: item.id });
    else for (const p of item.pieces) if (p.kind === "volume") order.push({ kind: "band", area: p.area, band: p.band });
  }
  return { order, standing: [...(r.volumes?.standing ?? [])].sort(), waiting: r.volumes?.waiting ?? false, rings: Object.fromEntries([...(r.rings ?? [])].map(([id, colors]) => [id, [...colors]])) };
}

/** Installs `__rvttIsoHook` while the test flag is set. */
export function useIsoTestHook(key: string, sceneId: string, memory?: StoreApi<StoredView> | null): void {
  const on = flagged();
  useEffect(() => {
    if (!on) return;
    return installHook({
      ...viewTestHook(key, sceneId, memory),
      layout: () => layoutOf(boards.at(-1)?.last ?? null),
      volumes: () => {
        const r = boards.at(-1)?.last;
        return r ? { standing: r.volumes?.standing.size ?? 0, waiting: r.volumes?.waiting ?? false } : null;
      },
      kept: () => {
        const c = keptBoards.at(-1)?.counts();
        return c ? { ...c, boardCommits: commits.board, mapCommits: commits.map, pillCommits: commits.pills } : null;
      },
      repaint: () => keptBoards.at(-1)?.repaint(),
      pixels: () => keptBoards.at(-1)?.pixels() ?? null,
      drawn: () => keptBoards.at(-1)?.drawn() ?? null,
      measure: (on: boolean) => keptBoards.at(-1)?.measure(on),
    });
  }, [on, key, sceneId, memory]);
}

/** A board's view controls, targeting the same view state as its menu. */
export function viewTestHook(key: string, sceneId: string, memory?: StoreApi<StoredView> | null): Hook {
  return {
    pick: (pick) => {
      const next = pick === "follow" ? null : pick;
      if (memory) memory.setState(withPick(memory.getState(), next), true);
      else pickView(key, next);
    },
    turn: (turn) => {
      if (memory) memory.setState(withTurn(memory.getState(), sceneId, turn), true);
      else turnView(key, sceneId, turn);
    },
  };
}
