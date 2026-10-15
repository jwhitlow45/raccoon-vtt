import type { RoomState, Scene } from "#shared/model.ts";
import { api } from "../../lib/api.ts";
import { scopeSlot } from "../../state/scope.ts";
import type { RoomActions, RoomView } from "../../state/types.ts";
import type { AssetSource, RoomViewStore } from "../../state/view.ts";
import { thumbSceneOf } from "./thumbnail.ts";

/**
 * When a DM device makes a scene's thumbnail (docs/design-v1-maps-vision.md
 * section 3.3). The DM's projection holds only the scene in view, so a
 * thumbnail can only be drawn from the scene on screen, and the moment to
 * draw it is when the DM leaves a scene this device changed: the view held
 * just before the switch still has it whole. "Update thumbnail" draws the
 * scene on screen at once.
 *
 * Only this device's own changes count, read from its queue of sent ops,
 * so two DM devices never both draw the same edit. A copy of a scene this
 * device has marked is marked as well: the copy takes the original's
 * stored thumbnail, which the mark says is out of date.
 */

type Watched = Pick<RoomView, "you" | "sceneId" | "view" | "pending">;

export type ThumbWatch = {
  /**
   * Feeds every store state. Returns the scene this device changed and has
   * just left, with the view that still holds it, or null.
   */
  observe(s: Watched): { sceneId: string; room: RoomState } | null;
  /** Whether this device changed the scene since its last thumbnail. */
  changed(sceneId: string): boolean;
  /**
   * Starts drawing a scene, or null if it is being drawn already. The mark
   * goes back to `end`, so an edit made while the drawing ran keeps the
   * scene marked.
   */
  begin(sceneId: string): number | null;
  end(sceneId: string, mark: number, ok: boolean): void;
};

export function createThumbWatch(): ThumbWatch {
  /** Each changed scene, with the number of this device's latest op that changed it. */
  const dirty = new Map<string, number>();
  const running = new Set<string>();
  let seen = Number.NEGATIVE_INFINITY;
  let lastScene: string | null = null;
  let lastView: RoomState | null = null;
  return {
    observe(s) {
      if (s.you?.role === "dm") {
        for (const p of s.pending) {
          if (p.n <= seen) continue;
          seen = p.n;
          const id = thumbSceneOf(p.op, s.sceneId);
          if (id !== null) dirty.set(id, p.n);
          // A copy starts with its original's stored thumbnail, which is out of date while the original is marked, so the copy is marked too.
          if (p.op.t === "scene.duplicate" && dirty.has(p.op.sceneId)) dirty.set(p.op.newSceneId, p.n);
        }
      }
      let left: { sceneId: string; room: RoomState } | null = null;
      if (s.sceneId !== lastScene && lastScene !== null && dirty.has(lastScene)) {
        if (lastView?.scenes[lastScene]) left = { sceneId: lastScene, room: lastView };
        else dirty.delete(lastScene);
      }
      lastScene = s.sceneId;
      lastView = s.view;
      return s.you?.role === "dm" ? left : null;
    },
    changed: (sceneId) => dirty.has(sceneId),
    begin(sceneId) {
      if (running.has(sceneId)) return null;
      running.add(sceneId);
      return dirty.get(sceneId) ?? Number.NEGATIVE_INFINITY;
    },
    end(sceneId, mark, ok) {
      running.delete(sceneId);
      if (ok && (dirty.get(sceneId) ?? Number.NEGATIVE_INFINITY) <= mark) dirty.delete(sceneId);
    },
  };
}

/** Per Room page: its watch, and the drawing in flight for each scene, so a second ask waits on the first. */
export const thumbsSlot = scopeSlot(() => ({ watch: createThumbWatch(), inFlight: new Map<string, Promise<void>>() }));

export type ThumbDeps = {
  store: RoomViewStore;
  actions: Pick<RoomActions, "dispatch">;
  assets: AssetSource;
  /** Draws the scene and uploads the picture, giving its asset id. Left out, the renderer and the server's upload. */
  picture?: (scene: Scene, room: RoomState) => Promise<string>;
};

async function drawAndUpload(deps: ThumbDeps, scene: Scene, room: RoomState): Promise<string> {
  // Loaded on first use, so a player's page never carries the renderer.
  const { renderThumbnail } = await import("./renderThumbnail.ts");
  const blob = await renderThumbnail({ scene, room, assets: deps.assets });
  const { roomId } = deps.store.getState();
  return (await api.uploadAsset(roomId, "thumb", blob)).id;
}

/**
 * Points the scene at its new picture and settles once the server answers.
 * Until the server has taken it, the scene stays marked and is drawn again
 * the next time the DM leaves it. An answer lost with the connection is
 * read from the snapshot that followed it.
 */
function pointAt(deps: ThumbDeps, sceneId: string, assetId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const n = deps.actions.dispatch(
      { t: "scene.update", sceneId, patch: { thumb: assetId } },
      {
        onAnswer: (answer) => {
          if (answer === "taken" || (answer === "unknown" && deps.store.getState().view?.scenes[sceneId]?.thumb === assetId)) resolve();
          else reject(new Error(answer === "refused" ? "the server refused the thumbnail" : "the connection dropped before the server answered"));
        },
      },
    );
    if (n === null) reject(new Error("the thumbnail op was refused here"));
  });
}

/**
 * Draws a scene from `room`, uploads it as a `thumb` asset and points the
 * scene at it, settling once the server has answered. Rejects on failure:
 * a background drawing ignores that and is tried again the next time the
 * DM leaves the scene, since nobody waits on it, while "Update thumbnail"
 * says so.
 */
export function makeThumbnail(thumbs: { watch: ThumbWatch; inFlight: Map<string, Promise<void>> }, deps: ThumbDeps, sceneId: string, room: RoomState): Promise<void> {
  const running = thumbs.inFlight.get(sceneId);
  if (running) return running;
  const mark = thumbs.watch.begin(sceneId);
  if (mark === null) return Promise.resolve();
  const work = (async () => {
    let ok = false;
    try {
      const scene = room.scenes[sceneId];
      if (!scene) throw new Error("the scene is gone");
      const assetId = await (deps.picture ?? ((sc, r) => drawAndUpload(deps, sc, r)))(scene, room);
      // A scene deleted meanwhile has nothing to point at the picture, and nothing left to draw.
      if (!deps.store.getState().view?.scenes[sceneId]) {
        ok = true;
        return;
      }
      await pointAt(deps, sceneId, assetId);
      ok = true;
    } finally {
      thumbs.watch.end(sceneId, mark, ok);
      thumbs.inFlight.delete(sceneId);
    }
  })();
  thumbs.inFlight.set(sceneId, work);
  return work;
}
