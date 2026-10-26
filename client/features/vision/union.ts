import { viewMapsOf } from "#shared/keys.ts";
import type { FogTile, RoomState, Token } from "#shared/model.ts";
import { withheldFromViewer } from "#shared/project.ts";
import { decodeTile, encodeTile } from "#shared/rules/fog.ts";

/**
 * What any player sees, as the DM's tools read it
 * (docs/design-v1-per-player-vision.md decision 14): the Outliner and the
 * tracker's "visible" add say what reaches some player, by the union of
 * every source and every map. The DM's view holds the union's sight as
 * its own `sight`, and the fog of each layer apart: the DM's (`fogTiles`),
 * the party's (`exploredTiles`) and, on a per-player scene, every holder's
 * joined (`exploredAny`). So the union is the DM's view with that last
 * map joined into the party's layer, which a player's projection of it
 * then reads as one player who sees everything any player sees. On a
 * whole-party scene nothing is joined and the view is the DM's own.
 */
export function unionView(view: RoomState): RoomState {
  const any = viewMapsOf(view).exploredAny;
  if (!any || Object.keys(any).length === 0) return view;
  let byExplored = joined.get(any);
  if (!byExplored) joined.set(any, (byExplored = new WeakMap()));
  let exploredTiles = byExplored.get(view.exploredTiles);
  if (!exploredTiles) byExplored.set(view.exploredTiles, (exploredTiles = joinedLayers(view.exploredTiles, any)));
  return { ...view, exploredTiles };
}

/** Whether no player sees a token where it stands, by the union (unionView). Its visibility and a blackout are the caller's. */
export function withheldFromEveryPlayer(view: RoomState, token: Token): boolean {
  // A projection holds no holder list, so any member id reads the view's own fog and sight: here the union's.
  return withheldFromViewer(unionView(view), { memberId: "", role: "player" }, token);
}

/* The union's layer, kept while both maps are the same objects, so the Outliner's rows are not decoded again on every op. */
const joined = new WeakMap<Record<string, FogTile>, WeakMap<Record<string, FogTile>, Record<string, FogTile>>>();

function joinedLayers(party: Record<string, FogTile>, holders: Record<string, FogTile>): Record<string, FogTile> {
  const out = { ...party };
  for (const [key, tile] of Object.entries(holders)) {
    const own = out[key];
    out[key] = own ? orTiles(own, tile) : tile;
  }
  return out;
}

function orTiles(a: FogTile, b: FogTile): FogTile {
  const x = decodeTile(a.bits);
  const y = decodeTile(b.bits);
  if (!x || !y) return x ? a : b;
  const bits = new Uint8Array(x);
  for (let i = 0; i < bits.length; i++) bits[i] = bits[i]! | y[i]!;
  return { ...a, bits: encodeTile(bits) };
}
