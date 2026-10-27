import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BuildChunk, FogTile, Label, RoomState, Scene, Stamp, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { WindowLimiter } from "../assets/limits.ts";
import { accessRoutes, type AuthKit, HttpError, requireGrant, roomParam } from "../auth/http.ts";
import { ActorClosedError } from "../rooms/actor.ts";
import { TooBusyError } from "../rooms/errors.ts";
import type { RoomManager } from "../rooms/manager.ts";

/**
 * The map export's player view (docs/design-v1-map-discovery.md 4 and 5.1):
 * one scene as the shared fog class holds it, every player who does not see
 * for themselves and a table display. The DM's own store holds the whole
 * build, which on a scene with fog on is more than players hold, so the
 * export asks the server for the players' share instead.
 *
 * `GET /api/rooms/:id/scenes/:sceneId/player-view`, DM only, answers 200
 * with `PlayerView` (below), `cache-control: no-store`. Refusals, as
 * `{ error }`: 403 `no_access` without a grant, 403 `dm_only` for a player,
 * 404 `room_not_found`, 404 `not_found` for a scene the room lacks, 429
 * `rate_limited` and 503 `busy`, both with Retry-After.
 *
 * The players' scene answers what a table display's snapshot holds of it.
 * Any other scene, or the players' scene behind a blackout, answers it as
 * nobody looks at it now: no party sight, so its held ground is the DM's
 * fog and the party's explored layer, live only where the DM revealed it
 * and as the party remembers it elsewhere. That is what players know of a
 * scene they left, and what they know behind a pause, since the map step
 * counts no sight there either (5.3).
 */
export type PlayerView = {
  /** The scene as players' copy holds it. With fog on its `autoWalls` is "off": the chunks carry the automatic walls players hold, in `auto`. */
  scene: Scene;
  /** By chunk key. With fog on each is a PlayerChunk (`known`, `auto`, `upDir`), stubs included, with fog off the flattened build. */
  buildChunks: Record<string, BuildChunk>;
  /** By id: those players hold, remembered ones as remembered. */
  labels: Record<string, Label>;
  /** By id, as labels go. Never one the DM keeps to themselves. */
  stamps: Record<string, Stamp>;
  /** By tile key: the DM's layer and the party's explored layer merged, rev 0. No explored layer goes on its own. */
  fogTiles: Record<string, FogTile>;
};

/** Read as a table display: no member has a `display:` id, so it owns nothing and reads the shared fog class (rules/held.ts fogClassOf). */
const TABLE: Viewer = { memberId: "display:map-export", role: "player" };

const SceneId = z.string().min(1).max(64);

/** Each request projects a whole scene. This many a minute, for the room's DMs together, is far above what exporting needs. */
const PER_ROOM_PER_MINUTE = 30;

export function registerPlayerViewRoutes(app: FastifyInstance, kit: AuthKit, deps: { manager: RoomManager }): Promise<void> {
  const limiter = new WindowLimiter(60_000);
  return accessRoutes(app, (r) => {
    r.get("/api/rooms/:id/scenes/:sceneId/player-view", async (req, reply) => {
      const roomId = roomParam(req);
      await requireGrant(kit, req, reply, roomId, "dm");
      const checks = [{ key: roomId, limit: PER_ROOM_PER_MINUTE }];
      const wait = limiter.retryAfter(checks);
      if (wait > 0) throw new HttpError(429, "rate_limited", { retryAfter: wait });
      limiter.record(checks);
      const sceneId = SceneId.safeParse((req.params as { sceneId?: unknown }).sceneId);
      if (!sceneId.success) throw new HttpError(404, "not_found");
      // Taken on the queue, so it is a committed state, and projected off it, so the room keeps playing:
      // a committed state is never changed.
      const state = await committedState(deps.manager, roomId);
      const view = playerView(state, sceneId.data);
      if (!view) throw new HttpError(404, "not_found");
      reply.header("cache-control", "no-store");
      return view;
    });
  });
}

async function committedState(manager: RoomManager, roomId: string): Promise<RoomState> {
  try {
    const actor = await manager.acquire(roomId);
    return await actor.read((state) => state);
  } catch (err) {
    if (err instanceof TooBusyError || err instanceof ActorClosedError) throw new HttpError(503, "busy", { retryAfter: err instanceof TooBusyError ? 30 : 2 });
    throw err;
  }
}

/** A scene of the room as the shared fog class holds it, or null for a scene the room lacks. */
export function playerView(state: RoomState, sceneId: string): PlayerView | null {
  // By own keys only, so a scene id such as "__proto__" names nothing.
  if (!Object.hasOwn(state.scenes, sceneId)) return null;
  const looking = state.meta.playerSceneId === sceneId && !state.meta.view.blackout;
  const seen = projectState(looking ? state : unwatched(state, sceneId), TABLE, { sceneId: null });
  const scene = Object.hasOwn(seen.scenes, sceneId) ? seen.scenes[sceneId] : undefined;
  if (!scene) return null;
  return { scene, buildChunks: seen.buildChunks, labels: seen.labels, stamps: seen.stamps, fogTiles: seen.fogTiles };
}

/**
 * The room as if the players stood on the scene with nobody looking: a
 * display projects only the players' scene, and only outside a blackout,
 * and with the scene's creatures gone its party sight is empty. Its ground
 * is then the one the real room gives a scene the players are not on
 * (rules/held.ts classSight), labels and stamps included. Only the scene
 * and the four collections are read from the projection, so nothing else
 * the copy changes reaches the answer.
 */
function unwatched(state: RoomState, sceneId: string): RoomState {
  const tokens: RoomState["tokens"] = {};
  for (const [id, token] of Object.entries(state.tokens)) if (token.sceneId !== sceneId) tokens[id] = token;
  return { ...state, meta: { ...state.meta, playerSceneId: sceneId, view: { ...state.meta.view, blackout: false } }, tokens };
}
