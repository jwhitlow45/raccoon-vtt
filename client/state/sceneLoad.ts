/**
 * What the map area says while a scene loads. Switching scenes can take
 * seconds on a phone: the snapshot first (design 7.1), then the map image,
 * which is the larger part. Without a word on screen the old scene simply
 * stays put, and the site looks hung.
 *
 * Two things can be loading, and this module keeps them apart:
 *
 * - The scene's contents, which this device asked for and does not have
 *   yet: a DM's `scene` request, or a `hello` for another scene after a
 *   reconnect. The old scene stays on screen meanwhile. The socket reports
 *   these as events, and `stepSceneLoad` keeps the one scene in flight.
 * - The map image of the scene on screen, which loads after its contents
 *   arrive. That covers every way a view lands on a scene: a DM's switch,
 *   players moved by the DM, the first snapshot and a reconnect. The
 *   canvas reports each map it finishes, and `sceneLoadView` compares that
 *   with the scene on screen, so nothing has to start or stop it.
 *
 * Plain functions, so the rules run under node's test runner.
 */

export type SceneLoad = {
  /** The scene this device asked for and has no contents of yet. */
  requested: string | null;
  /** The server delayed the snapshot (`wait`, design 10.4) or refused the request for now (`retry`). */
  slow: boolean;
};

export const SCENE_LOAD_IDLE: SceneLoad = Object.freeze({ requested: null, slow: false });

export type SceneLoadEvent =
  /** A DM picked a scene, or a `hello` asks for a scene other than the one on screen. */
  | { t: "request"; sceneId: string }
  /** The DM picked the scene already on screen, with nothing in flight: nothing will load. */
  | { t: "cancel" }
  /** `wait` for the snapshot, or `retry` for the `scene` request. Either way it takes longer. */
  | { t: "slow" }
  /** The snapshot deadline passed (design 7.5). The socket reconnects and asks again. */
  | { t: "timeout" }
  /**
   * A snapshot arrived for `sceneId`. `next` is the scene the socket sent
   * straight after it, when the DM picked again while this one was in flight.
   */
  | { t: "snapshot"; sceneId: string | null; next: string | null };

/** A switch that ended without the scene, for one plain sentence. */
export type SceneLoadFailure = { sceneId: string; reason: "timeout" | "refused" };

export function stepSceneLoad(load: SceneLoad, e: SceneLoadEvent): { load: SceneLoad; failed: SceneLoadFailure | null } {
  switch (e.t) {
    case "request":
      // The same scene asked again (the hello after its resync) is the same load.
      if (load.requested === e.sceneId) return { load, failed: null };
      return { load: { requested: e.sceneId, slow: false }, failed: null };
    case "cancel":
      return { load: SCENE_LOAD_IDLE, failed: null };
    case "slow":
      if (load.requested === null || load.slow) return { load, failed: null };
      return { load: { ...load, slow: true }, failed: null };
    case "timeout":
      if (load.requested === null) return { load, failed: null };
      return { load: SCENE_LOAD_IDLE, failed: { sceneId: load.requested, reason: "timeout" } };
    case "snapshot":
      if (e.next !== null) return { load: load.requested === e.next ? load : { requested: e.next, slow: false }, failed: null };
      if (load.requested === null) return { load, failed: null };
      if (load.requested === e.sceneId) return { load: SCENE_LOAD_IDLE, failed: null };
      // The server sends the player scene when the one asked for is gone.
      return { load: SCENE_LOAD_IDLE, failed: { sceneId: load.requested, reason: "refused" } };
  }
}

/**
 * The last map image the canvas finished with, by asset id. `loading` while
 * it fetches and decodes one. `swap` says the scene's previous image stays
 * on screen meanwhile: a map phase switch, or a new image for the scene on
 * screen (docs/design-v1-maps-vision.md section 3.4).
 */
export type MapProgress = { assetId: string; state: "loading" | "drawn" | "failed"; swap?: boolean } | null;

export type SceneLoadNotice = {
  /** The scene that is loading, for the Scenes panel to mark its row. */
  sceneId: string;
  text: string;
  /** A second line, when the server said the wait is longer. */
  detail: string | null;
};

/** A scene's name as the Scenes panel shows it. */
export function sceneLabel(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : "the scene";
}

/**
 * What to say on the map, or null when nothing is loading. `shown` is the
 * scene on screen, `map` what the canvas last reported.
 */
export function sceneLoadView(input: {
  load: SceneLoad | undefined;
  shown: { id: string; name: string; mapAssetId: string | null } | null;
  map: MapProgress;
  nameOf(sceneId: string): string | undefined;
}): SceneLoadNotice | null {
  const { load, shown, map } = input;
  if (load && load.requested !== null) {
    return {
      sceneId: load.requested,
      text: `Loading ${sceneLabel(input.nameOf(load.requested))}…`,
      detail: load.slow ? "Still loading…" : null,
    };
  }
  if (!shown || shown.mapAssetId === null) return null;
  if (map && map.assetId === shown.mapAssetId && map.state !== "loading") return null;
  if (map && map.assetId === shown.mapAssetId && map.swap) return { sceneId: shown.id, text: "Changing the map…", detail: null };
  return { sceneId: shown.id, text: `Loading ${sceneLabel(shown.name)}…`, detail: null };
}

/** The sentence for a switch that failed. The socket keeps trying after a timeout, so it says so. */
export function sceneLoadFailureText(failure: SceneLoadFailure, name: string | undefined): string {
  const scene = sceneLabel(name);
  const subject = scene === "the scene" ? "The scene" : scene;
  return failure.reason === "timeout"
    ? `${subject} did not load in time. Reconnecting to try again.`
    : `${subject} could not be opened. It may have been deleted.`;
}

export function mapFailureText(name: string | undefined): string {
  const scene = sceneLabel(name);
  return scene === "the scene" ? "The map image did not load. Check your connection." : `The map image for ${scene} did not load. Check your connection.`;
}
