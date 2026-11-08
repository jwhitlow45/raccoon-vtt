import type { SceneId } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { shareRecord } from "./share.ts";
import type { RoomView } from "./types.ts";

/** A room's view as the store holds it (RoomView.view), whole or cut to one floor. */
export type RoomViewState = NonNullable<RoomView["view"]>;

type Entries = Readonly<Record<string, unknown>>;

/** The collections whose entries each stand on one floor by their own `sceneId`. */
const BY_RECORD = ["tokens", "labels", "templates", "drawings", "stamps", "lights", "pins", "traps"] as const;

/** The collections keyed `"<sceneId>:..."`: build chunks and the fog, explored and sight tiles. */
const BY_KEY = ["buildChunks", "fogTiles", "exploredTiles", "sight", "sightAll", "fogAll", "exploredAny"] as const;

/** The collections keyed by the floor's own id: the DM's fog draft and sight holders. */
const BY_FLOOR = ["fogDrafts", "holders"] as const;

/** Every collection the cut makes, which floorView.test.ts holds against the floor-scoped key kinds. */
export const CUT_COLLECTIONS: readonly string[] = [...BY_RECORD, ...BY_KEY, ...BY_FLOOR];

type Cut = (typeof BY_RECORD)[number] | (typeof BY_KEY)[number] | (typeof BY_FLOOR)[number];

/**
 * The cut of each source collection, per floor, made once while the
 * collection keeps its identity (share.ts keeps it while nothing in it
 * changed), so a view rebuilt for an op on another collection cuts nothing
 * again.
 */
const cuts = new WeakMap<object, Map<SceneId, Entries>>();

function cutOf(kind: Cut, all: Entries, sceneId: SceneId, prev: Entries | undefined): Entries {
  let floors = cuts.get(all);
  const known = floors?.get(sceneId);
  if (known !== undefined) return known;
  const out: Record<string, unknown> = {};
  if ((BY_FLOOR as readonly string[]).includes(kind)) {
    const own = ownEntry(all, sceneId);
    if (own !== undefined) out[sceneId] = own;
  } else if ((BY_KEY as readonly string[]).includes(kind)) {
    const prefix = `${sceneId}:`;
    for (const key in all) if (key.startsWith(prefix)) out[key] = all[key];
  } else {
    for (const key in all) {
      const entry = all[key] as { sceneId?: unknown } | undefined;
      if (entry?.sceneId === sceneId) out[key] = entry;
    }
  }
  // Each entry already keeps its identity across rebuilds, so the cut keeps its own while it holds the same ones.
  const shared = shareRecord(prev, out) as Entries;
  if (floors === undefined) cuts.set(all, (floors = new Map()));
  floors.set(sceneId, shared);
  return shared;
}

/**
 * The cut of the whole view that the board reads (docs/design/design-v1-floors.md
 * 10, D-261107-224): the floor-scoped collections (tokens, chunks, fog,
 * explored and sight tiles, labels, stamps, lights, pins, traps, templates,
 * drawings, the fog draft and the sight holders) cut to the floor shown,
 * `sceneId`, and every other part of `view` as it is. `prev` is the last
 * cut, whose collections it shares while they hold the same entries, so a
 * layer that reads one renders only when it changes.
 *
 * A scene of one floor is its own cut: the view then holds that one scene's
 * records, as it did before floors, so `view` itself comes back.
 */
export function floorViewOf(view: RoomView["view"], sceneId: SceneId | null, prev?: RoomView["view"]): RoomView["view"] {
  if (view === null) return null;
  if (sceneId === null || ownEntry(view.scenes, sceneId)?.floor === undefined) return view;
  const from = prev !== null && prev !== undefined && prev !== view ? (prev as unknown as Record<string, unknown>) : undefined;
  const source = view as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const kind of CUT_COLLECTIONS as readonly Cut[]) {
    const all = source[kind] as Entries | undefined;
    if (all !== undefined) out[kind] = cutOf(kind, all, sceneId, from?.[kind] as Entries | undefined);
  }
  if (from !== undefined && Object.keys(from).length === Object.keys(out).length && Object.keys(out).every((key) => out[key] === from[key])) return prev!;
  return out as unknown as RoomViewState;
}
