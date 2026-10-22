import type { RoomState, Token } from "#shared/model.ts";
import { dragExtra, holderOf, linkHolds, onHolder, type SeenByAll } from "#shared/rules/attach.ts";
import { publicToken } from "#shared/rules/walkWorld.ts";
import { landedOffHolder, type DropToken, type Landed } from "../movement/drop.ts";
import { dragWalkers } from "./groups.ts";

/**
 * A holder's walk as a drag searches it (docs/design-v1-attach.md 4.2 and
 * 7.3), as plain functions for node --test, so the drag pipeline
 * (features/movement/stageHooks.ts) needs a line for each. The world it
 * walks in is shared/rules/walkWorld.ts groupWalkWorld.
 */

type Role = "dm" | "player";

/**
 * Whether every player sees a token, as this copy shows it (7.3, the path's
 * `seen` marks): held, not hidden by the DM, and on the DM's copy not
 * withheld where it stands.
 */
export function seenIn(view: RoomState, role: Role): SeenByAll {
  return (t) => {
    const token = view.tokens[t.id];
    return token !== undefined && publicToken(view, token, { role });
  };
}

/**
 * How the label names the holder's extra foot (7.3): "dragging" while one of
 * the creatures that cost it is dragged, else "carrying".
 */
export function towingWord(view: RoomState, holderId: string, role: Role): "dragging" | "carrying" {
  const drags: RoomState["tokens"] = {};
  for (const [id, t] of Object.entries(view.tokens)) if (t && (t.attached === undefined || t.attached.kind === "drag")) drags[id] = t;
  return dragExtra(drags, holderId, seenIn(view, role)) === 1 ? "dragging" : "carrying";
}

/** The creatures a lead token drags beside it as this copy shows them (groups.ts dragWalkers), stopping at the other tokens a drag names. */
export function walkersFor(view: RoomState, tokenId: string, role: Role, named: ReadonlySet<string> = new Set()): Token[] {
  return dragWalkers(view.tokens, tokenId, seenIn(view, role), named);
}

/**
 * A drop's moves with each token that sits on its holder landed by the
 * holder (docs/design-v1-attach.md 4.1 and 4.3), not by the ground under
 * its seat, which differs where the holder straddles two heights. One that
 * stays on it is seated at the holder's elevation, the height the server
 * takes for a new seat, so a player who may only re-seat a token is never
 * refused for the ground under it. One dragged off it lands as a Get off
 * does (drop.ts landedOffHolder), never in midair over low ground.
 */
export function onSeats(view: Pick<RoomState, "tokens" | "meta" | "buildChunks">, moves: readonly Landed[]): Landed[] {
  return moves.map((move) => {
    const token = view.tokens[move.tokenId];
    const link = token?.attached;
    const holder = token ? (holderOf(view.tokens, token) as Token | undefined) : undefined;
    if (!token || !link || !holder || !onHolder(link.kind)) return move;
    const { elevation: _ground, ...rest } = move;
    const stays = linkHolds(view.meta.settings, link.kind, { ...token, x: move.x, y: move.y, elevation: holder.elevation }, holder);
    const elevation = stays ? holder.elevation : landedOffHolder(view.buildChunks, token, holder, move);
    return elevation === token.elevation ? rest : { ...rest, elevation };
  });
}

/** For a drag of several tokens: what each named one drags beside it, judged with the others named. */
export function walkersOfGroup(view: RoomState, group: readonly DropToken[], role: Role): (token: DropToken) => readonly DropToken[] {
  const named = new Set(group.map((t) => t.id));
  return (token) => walkersFor(view, token.id, role, named);
}
