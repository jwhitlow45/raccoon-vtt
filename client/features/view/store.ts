import { useSyncExternalStore } from "react";
import type { Scene } from "#shared/model.ts";
import { isometric, TOP_DOWN, type Turn, type View, type ViewKind } from "../../lib/view.ts";

/**
 * Which view this device shows the board in (docs/design-v1-isometric-view.md
 * 7, ISO-D2): a pick per device and room, "Follow the scene" until the user
 * picks one, and a turn per scene. It is kept in the device's storage, as
 * the table display's settings are, and never on the server: the view
 * changes nothing a device receives.
 */

/**
 * Isometric stays out of reach until the lanes that draw it, take input in
 * it and offer it are in (section 13). Until then every device shows
 * Top-down, whatever it has stored or the scene suggests.
 */
export const isoReady = false;

/** The user's pick, null to follow the scene. */
export type ViewPick = ViewKind | null;

/**
 * A scene's turn. The turns are kept as a list, oldest first, never as an
 * object keyed by scene id (ISO1-OPUS-1): an object reads "constructor" or
 * "__proto__" off its prototype, and lists integer-like ids such as "7"
 * first, which would make them the oldest and drop them first.
 */
export type SceneTurn = readonly [sceneId: string, turn: Turn];

export type StoredView = { readonly pick: ViewPick; readonly turns: readonly SceneTurn[] };

/** What a device that never picked holds, and what an unreadable value reads as: Follow the scene, every turn 0. */
export const FOLLOW_THE_SCENE: StoredView = { pick: null, turns: [] };

/** Turns are kept for this many scenes, the oldest dropped. */
export const MAX_TURNS = 100;

export const viewKey = (roomId: string) => `rvtt.view.${roomId}`;

/** The table display's own, apart from a member's in the same browser (ISO-D16), as `rvtt.displayUiScale` is. */
export const displayViewKey = (roomId: string) => `rvtt.displayView.${roomId}`;

const isTurn = (t: unknown): t is Turn => t === 0 || t === 1 || t === 2 || t === 3;

/**
 * A stored value, `{"v":1,"pick":"isometric","turns":[["<sceneId>",1]]}`,
 * the turns oldest first. Whatever part of it cannot be read reads as its
 * default. A scene named twice keeps its last turn, in its last place.
 * Turns kept as an object, `{"<sceneId>":1}`, still read, in the order the
 * object lists them.
 */
export function parseStoredView(raw: string | null): StoredView {
  if (raw === null) return FOLLOW_THE_SCENE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return FOLLOW_THE_SCENE;
  }
  if (value === null || typeof value !== "object" || (value as { v?: unknown }).v !== 1) return FOLLOW_THE_SCENE;
  const { pick, turns } = value as { pick?: unknown; turns?: unknown };
  const listed: unknown[] = Array.isArray(turns) ? turns : turns !== null && typeof turns === "object" ? Object.entries(turns) : [];
  const kept = new Map<string, Turn>();
  for (const pair of listed) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [sceneId, turn] = pair as [unknown, unknown];
    if (typeof sceneId !== "string" || sceneId === "" || !isTurn(turn)) continue;
    kept.delete(sceneId);
    kept.set(sceneId, turn);
  }
  return { pick: pick === "topDown" || pick === "isometric" ? pick : null, turns: [...kept].slice(-MAX_TURNS) };
}

export function serializeStoredView(stored: StoredView): string {
  return JSON.stringify({ v: 1, ...(stored.pick !== null ? { pick: stored.pick } : {}), turns: stored.turns });
}

/** A pick holds for the whole room, every scene, until the user picks "Follow the scene" again (D-261026-5). */
export function withPick(stored: StoredView, pick: ViewPick): StoredView {
  return { ...stored, pick };
}

/** A turn writes only its own scene's, as the newest, and is never a pick (D-261026-5). */
export function withTurn(stored: StoredView, sceneId: string, turn: Turn): StoredView {
  const others = stored.turns.filter(([id]) => id !== sceneId);
  return { ...stored, turns: [...others.slice(Math.max(0, others.length - MAX_TURNS + 1)), [sceneId, turn]] };
}

/** A scene's turn, 0 until it is turned. */
export function turnOf(stored: StoredView, sceneId: string): Turn {
  return stored.turns.find(([id]) => id === sceneId)?.[1] ?? 0;
}

/**
 * The view the board shows on a scene: Top-down while Isometric is out of
 * reach or a tool shows Top-down while in use (section 6.4), else the
 * user's pick, else the scene's suggestion, at the scene's own turn.
 */
export function shownView(input: {
  stored: StoredView;
  sceneId: string;
  suggested: Scene["suggestedView"];
  forcedTopDown?: boolean;
  ready?: boolean;
}): View {
  if (!(input.ready ?? isoReady) || input.forcedTopDown) return TOP_DOWN;
  const kind = input.stored.pick ?? (input.suggested === "isometric" ? "isometric" : "topDown");
  return kind === "isometric" ? isometric(turnOf(input.stored, input.sceneId)) : TOP_DOWN;
}

/**
 * A device switches only once any gesture in progress ends (ISO-D3), so a
 * new suggestion or a turn never moves the map under a finger: while a
 * drag, a pinch or a ruler is under way it keeps the view it shows.
 */
export function settledView(showing: View, wanted: View, gesture: boolean): View {
  return gesture ? showing : wanted;
}

// ---------------------------------------------------------------- the device's storage

const listeners = new Set<() => void>();
const cache = new Map<string, StoredView>();

export function readView(key: string): StoredView {
  const known = cache.get(key);
  if (known) return known;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    // Storage blocked: Follow the scene until picked here.
  }
  const stored = parseStoredView(raw);
  cache.set(key, stored);
  return stored;
}

function writeView(key: string, next: StoredView): void {
  cache.set(key, next);
  try {
    localStorage.setItem(key, serializeStoredView(next));
  } catch {
    // The pick lasts until the page closes.
  }
  for (const listener of listeners) listener();
}

export function pickView(key: string, pick: ViewPick): void {
  writeView(key, withPick(readView(key), pick));
}

export function turnView(key: string, sceneId: string, turn: Turn): void {
  writeView(key, withTurn(readView(key), sceneId, turn));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStoredView(key: string): StoredView {
  return useSyncExternalStore(subscribe, () => readView(key));
}
