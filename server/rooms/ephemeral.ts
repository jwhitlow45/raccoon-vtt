import { keys } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { mayMoveToken } from "#shared/permissions.ts";
import { inSightOfNonOwners, ownsToken, perPlayerScene, projectEntity, viewerSceneId, withheldFromViewer } from "#shared/project.ts";
import { walkerFor } from "#shared/rules/attach.ts";
import type { EphEvent } from "#shared/protocol.ts";
import type { PartySight } from "#shared/ruleHooks.ts";
import { previewSqueezed, walkEnd, walkStates, type WalkEnd } from "#shared/rules/movement.ts";
import type { Connection, PreviewKind, SentPreview } from "./connection.ts";
import { perPlayerClasses } from "./fanout.ts";

/**
 * The ephemeral channel (design 7.6). Nothing here is stored: an event is
 * forwarded to the viewers on its scene, filtered per receiver with the same
 * projection that filters state, and checked against the committed fog and,
 * on a vision scene, the party's sight, so a drag into the dark or a ruler
 * to a hidden creature never shows players where it is. A player who was
 * showing a preview that is now withheld gets a bare cancel instead, so the
 * preview disappears rather than freezing. On a per-player scene each
 * player is judged by their own sight and fog
 * (docs/design-v1-per-player-vision.md 7.5).
 */

function previewOf(e: EphEvent): { kind: PreviewKind; id: string; ends: boolean } | null {
  switch (e.k) {
    case "dragStart":
    case "dragMove":
      return { kind: "drag", id: e.tokenId, ends: false };
    case "dragEnd":
    case "dragCancel":
      return { kind: "drag", id: e.tokenId, ends: true };
    case "ruler":
      return { kind: "ruler", id: e.id, ends: false };
    case "rulerEnd":
      return { kind: "ruler", id: e.id, ends: true };
    case "aoe":
      return { kind: "aoe", id: e.id, ends: false };
    case "aoeEnd":
      return { kind: "aoe", id: e.id, ends: true };
    default:
      return null;
  }
}

/*
 * What a socket's previews may keep on the server (review PV3-ASTRA-2):
 * each holds its last frame, so a socket may keep at most this many, the
 * one framed least recently going first. A device keeps a still preview
 * alive with a frame a second and the ephemeral rate allows 40 a second,
 * so no socket keeps more alive than this. One with no frame for
 * PREVIEW_STALE_MS has long left every screen, which drops a preview after
 * 3 s without one (client/state/ephemeral.ts PREVIEW_IDLE_MS), and goes.
 */
export const MOST_PREVIEWS_SENT = 64;
export const PREVIEW_STALE_MS = 10_000;

function cancelEvent(kind: PreviewKind, id: string): EphEvent {
  switch (kind) {
    case "drag":
      return { k: "dragCancel", tokenId: id };
    case "ruler":
      return { k: "rulerEnd", id };
    case "aoe":
      return { k: "aoeEnd", id };
  }
}

/** Whether the sender shares this preview at all (design 7.6): players' rulers by default, the DM's and every AoE only on request. */
function shared(sender: Connection, e: EphEvent): boolean {
  switch (e.k) {
    case "ruler":
      return sender.role === "player" ? e.shared !== false : e.shared === true;
    case "aoe":
      return e.shared === true;
    case "focus":
    case "view":
      return sender.role === "dm";
    default:
      return true;
  }
}

/**
 * A player's drag preview is a claim that they are moving the token, so it
 * goes out only when the move itself would be allowed. Otherwise a player
 * could show any visible token walking across everyone's screen.
 */
function mayMove(state: RoomState, sender: Connection, tokenId: string): boolean {
  if (sender.role === "dm") return true;
  return mayMoveToken(state, sender.viewer, tokenId).ok;
}

/**
 * The event as a player receives it. A drag's path is every cell the token
 * passed through, and on a scene with fog or vision some of those may be
 * dark or out of the party's sight (a monster dragged through darkness back
 * into view), so a player gets only the position, which the check below
 * already passed (docs/design-v1-maps-vision.md 4.3.5).
 */
function forPlayer(state: RoomState, sceneId: string, e: EphEvent, receiver: Connection): EphEvent {
  if (e.k !== "dragMove") return e;
  let out = e;
  // A route's cost reads private facts, such as a Swim Speed, so only the token's owners get it (docs/design-v1-movement.md 6.5).
  if (out.ft !== undefined) {
    const token = state.tokens[e.tokenId];
    if (!token || !ownsToken(state, receiver.viewer, token)) {
      const { ft: _ft, ...rest } = out;
      out = rest;
    }
  }
  if (out.path === undefined) return out;
  const scene = state.scenes[sceneId];
  if (!scene?.fogEnabled && scene?.vision?.on !== true) return out;
  const { path: _path, ...rest } = out;
  return rest;
}

function tokenVisibleTo(state: RoomState, receiver: Connection, tokenId: string): boolean {
  return projectEntity(keys.token(tokenId), state, receiver.viewer, { sceneId: receiver.sceneId }) !== null;
}

/**
 * Whether a player may not see a drag preview where it is now: projection's
 * own rule for a token standing there, by that player's sight and fog
 * (section 13.4 on the merged fog, the party's sight on a vision scene,
 * party members and exempt tokens always shown, and on a per-player scene
 * the player's own, docs/design-v1-per-player-vision.md 6.2). Which
 * players a drag carries along a holder with it stays a public rule, read
 * from what every player sees (`inSightOfNonOwners`). The footprint is the
 * server's to judge, whatever the frame says
 * (docs/design-v1-maps-vision.md 4.1, "Drag previews"): one size smaller
 * around the preview point where a creature that can squeeze stands with
 * its core clear and a blocker through its full footprint, as along a
 * narrow corridor, and full size otherwise. So a Large creature dragged
 * along a corridor out of sight is not shown by the half of its preview
 * drawn over the corridor's walls.
 *
 * The squeeze is judged as the end of the walk the frame draws (movement.ts
 * WalkEnd, review AT-ASTRA-21): off a holder every player sees by the walk
 * off it (rules/attach.ts walkerFor), carried through the frame's corners
 * (`path`), so a walk that cleared its holder and came back over it reads
 * the step under it on the ground's rule. A drag's start has walked
 * nowhere. Any other frame without corners may have walked any way, so it
 * is judged for every walker its last leg may start from, squeezed as it
 * stands or past a corner, on its holder or past it, at any footing a walk
 * off the ground may reach (movement.ts walkStates, review AT-ASTRA-22),
 * and withheld when any of them withholds it.
 */
function previewWithheld(state: RoomState, viewer: Viewer, token: Token, x: number, y: number, path: readonly number[] | undefined): boolean {
  const { squeeze: _squeeze, ...rest } = token;
  const seen = (t: { id: string }) => state.tokens[t.id] !== undefined && inSightOfNonOwners(state, state.tokens[t.id]!, {});
  const walker = walkerFor(state, token, seen);
  const at = { x, y };
  const withheldAs = (end: WalkEnd) => withheldFromViewer(state, viewer, previewSqueezed(state, end) ? { ...rest, x, y, squeeze: true } : { ...rest, x, y });
  if (path === undefined) return walkStates(state.buildChunks, walker).some((w) => withheldAs(walkEnd(state, w, at)));
  const corners: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < path.length; i += 2) corners.push({ x: path[i]!, y: path[i + 1]! });
  return withheldAs(walkEnd(state, walker, at, corners));
}

/**
 * What a player's judgment of a drag preview reads (docs/design-v1-per-player-vision.md
 * 7.5), so players who read the same are judged once per event: with
 * vision on, the sight they read, which viewers with the same sources share,
 * with fog alone, their fog (each holder alone, the rest together), and
 * with both off nothing, since nothing is withheld then. A whole-party
 * scene reads the same for every player. Null when nothing is withheld.
 */
function judgedBy(state: RoomState, sceneId: string, receiver: Connection, sights: Map<PartySight, number>): string | null {
  const scene = state.scenes[sceneId];
  if (!scene || (scene.vision?.on !== true && !scene.fogEnabled)) return null;
  if (!perPlayerScene(scene)) return "party";
  // The fan-out's classes (fanout.ts perPlayerClasses): withholding reads sight alone with vision on, and fog alone otherwise.
  const { sight, fog } = perPlayerClasses(state, sceneId, receiver.memberId, sights);
  return scene.vision?.on === true ? `sight|${sight}` : `fog|${fog}`;
}

/**
 * Whether this receiver may see the event. `withheld` answers, once per
 * event and judgment (judgedBy), whether the receiver may not see a drag
 * preview where it is now.
 */
function allowed(state: RoomState, receiver: Connection, e: EphEvent, withheld: (receiver: Connection) => boolean): boolean {
  switch (e.k) {
    case "dragStart":
    case "dragMove":
    case "dragEnd": {
      const token = state.tokens[e.tokenId];
      if (!token || !tokenVisibleTo(state, receiver, e.tokenId)) return false;
      if (receiver.role === "player" && withheld(receiver)) return false;
      return true;
    }
    case "ruler":
      return e.points.every((p) => p.tokenId === undefined || tokenVisibleTo(state, receiver, p.tokenId));
    case "focus":
      return receiver.role === "player";
    // A DM device's camera, for table displays only (docs/design-v1-dm-tools.md 3.1). Like every event it goes only to
    // receivers on its scene, and a display is on the player scene, so the TV never moves to a scene players cannot see.
    case "view":
      return receiver.display;
    default:
      return true;
  }
}

export function routeEphemeral(state: RoomState, sender: Connection, sceneId: string, e: EphEvent, receivers: Iterable<Connection>): void {
  if (!state.scenes[sceneId]) return;
  // A player previews only on the scene they are on. The DM may be anywhere.
  if (sender.role === "player" && state.meta.playerSceneId !== sceneId) return;
  const all = [...receivers];
  expireStale(sender, all);
  const preview = previewOf(e);
  if (preview?.ends) sender.previewsSent.delete(`${preview.kind}:${preview.id}`);
  if (!shared(sender, e)) return;
  // A drag the sender may not make is withheld from everyone, and one
  // already showing (the token was locked mid-drag, say) is cancelled.
  const senderMay = !(e.k === "dragStart" || e.k === "dragMove" || e.k === "dragEnd") || mayMove(state, sender, e.tokenId);
  const heldKey = preview ? `${sender.memberId}|${preview.kind}:${preview.id}` : null;
  const withheld = withheldFor(state, sceneId, e);
  // A bare end names only what stopped, so it goes to those showing that preview. Sent to
  // everyone, a cancelled drag of a hidden or fogged token would hand players its id.
  const bareEnd = e.k === "dragCancel" || e.k === "rulerEnd" || e.k === "aoeEnd";
  for (const receiver of all) {
    if (receiver === sender || receiver.closed || receiver.held === null) continue;
    if (viewerSceneId(state, receiver.viewer, { sceneId: receiver.sceneId }) !== sceneId) continue;
    if (bareEnd) {
      if (heldKey && receiver.previewsHeld.delete(heldKey)) receiver.send({ t: "eph", from: sender.memberId, e });
      continue;
    }
    if (senderMay && allowed(state, receiver, e, withheld)) {
      receiver.send({ t: "eph", from: sender.memberId, e: receiver.role === "player" ? forPlayer(state, sceneId, e, receiver) : e });
      if (heldKey && preview) {
        if (preview.ends) receiver.previewsHeld.delete(heldKey);
        else receiver.previewsHeld.set(heldKey, sender.id);
      }
    } else if (heldKey && preview && receiver.previewsHeld.has(heldKey)) {
      receiver.previewsHeld.delete(heldKey);
      receiver.send({ t: "eph", from: sender.memberId, e: cancelEvent(preview.kind, preview.id) });
    }
  }
  if (preview && !preview.ends) keepSent(sender, `${preview.kind}:${preview.id}`, { kind: preview.kind, id: preview.id, sceneId, last: e, at: sender.now() }, all);
}

/** Keeps a preview's last frame while some screen shows this socket's frame of it, and none nobody receives, within the socket's most. */
function keepSent(sender: Connection, key: string, sent: SentPreview, receivers: readonly Connection[]): void {
  sender.previewsSent.delete(key);
  if (!showsAnywhere(sender, `${sender.memberId}|${key}`, receivers)) return;
  sender.previewsSent.set(key, sent);
  for (const [oldest, kept] of sender.previewsSent) {
    if (sender.previewsSent.size <= MOST_PREVIEWS_SENT) break;
    dropSent(sender, oldest, kept, receivers);
  }
}

/** Every preview of the socket's with no frame for PREVIEW_STALE_MS goes, with a bare cancel to each screen still holding it. */
function expireStale(sender: Connection, receivers: readonly Connection[]): void {
  const now = sender.now();
  for (const [key, sent] of sender.previewsSent) {
    // The map holds them in the order of their last frames.
    if (now - sent.at < PREVIEW_STALE_MS) break;
    dropSent(sender, key, sent, receivers);
  }
}

function dropSent(sender: Connection, key: string, sent: { kind: PreviewKind; id: string }, receivers: readonly Connection[]): void {
  sender.previewsSent.delete(key);
  const heldKey = `${sender.memberId}|${key}`;
  for (const receiver of receivers) if (release(receiver, heldKey, sender)) receiver.send({ t: "eph", from: sender.memberId, e: cancelEvent(sent.kind, sent.id) });
}

/*
 * A screen holds one preview per member and id, whichever of the member's
 * sockets sent its latest frame (review PV3-ASTRA-3). So a socket's entry
 * that goes ends the preview only on the screens where that socket's frame
 * is the one shown, and one whose frames another socket has replaced
 * everywhere just goes. An explicit end is the member's, from either
 * socket, as the screen reads it, and routeEphemeral ends it everywhere.
 */
function release(receiver: Connection, heldKey: string, sender: Connection): boolean {
  if (receiver === sender || receiver.closed || receiver.previewsHeld.get(heldKey) !== sender.id) return false;
  receiver.previewsHeld.delete(heldKey);
  return true;
}

function showsAnywhere(sender: Connection, heldKey: string, receivers: readonly Connection[]): boolean {
  return receivers.some((r) => r !== sender && !r.closed && r.previewsHeld.get(heldKey) === sender.id);
}

/**
 * Whether players may not see a drag frame where it stands, worked out once
 * per event for each judgment (judgedBy), since it is a wall test besides:
 * on a per-player scene one per source set with vision on, or per fog
 * class with fog alone (docs/design-v1-per-player-vision.md 7.5).
 */
function withheldFor(state: RoomState, sceneId: string, e: EphEvent): (receiver: Connection) => boolean {
  const answers = new Map<string, boolean>();
  const sights = new Map<PartySight, number>();
  const token = "tokenId" in e ? state.tokens[e.tokenId] : undefined;
  return (receiver) => {
    if (token === undefined || !("x" in e) || !("y" in e)) return false;
    const by = judgedBy(state, sceneId, receiver, sights);
    if (by === null) return false;
    let hidden = answers.get(by);
    if (hidden === undefined) answers.set(by, (hidden = previewWithheld(state, receiver.viewer, token, e.x, e.y, e.k === "dragMove" ? e.path : e.k === "dragStart" ? [] : undefined)));
    return hidden;
  };
}

/**
 * Previews held on other screens, judged again after a batch that set
 * `global` (docs/design-v1-per-player-vision.md 7.2): a switch to or from
 * Per player, a holder pick or any other change that re-projects
 * everything can leave a receiver showing a drag or a live ruler it may no
 * longer see. Each is judged by its last frame, as it would be routed now,
 * and a receiver that may no longer have it gets its bare cancel.
 */
export function rejudgePreviews(state: RoomState, connections: Iterable<Connection>): void {
  const all = [...connections];
  for (const sender of all) {
    expireStale(sender, all);
    for (const [key, { kind, id, sceneId, last }] of [...sender.previewsSent]) {
      const heldKey = `${sender.memberId}|${kind}:${id}`;
      const judged = state.scenes[sceneId] !== undefined;
      const senderMay = !(last.k === "dragStart" || last.k === "dragMove" || last.k === "dragEnd") || mayMove(state, sender, last.tokenId);
      const withheld = withheldFor(state, sceneId, last);
      for (const receiver of all) {
        // Only the screens showing this socket's frame are judged by it.
        if (receiver === sender || receiver.closed || receiver.previewsHeld.get(heldKey) !== sender.id) continue;
        const here = judged && viewerSceneId(state, receiver.viewer, { sceneId: receiver.sceneId }) === sceneId;
        if (here && senderMay && allowed(state, receiver, last, withheld)) continue;
        release(receiver, heldKey, sender);
        receiver.send({ t: "eph", from: sender.memberId, e: cancelEvent(kind, id) });
      }
      // A preview no screen shows from this socket any more keeps no frame.
      if (!showsAnywhere(sender, heldKey, all)) sender.previewsSent.delete(key);
    }
  }
}

/** When a socket goes away, every preview it left on other screens is cancelled (design 7.6). */
export function cancelPreviews(sender: Connection, receivers: Iterable<Connection>): void {
  if (sender.previewsSent.size === 0) return;
  for (const receiver of receivers) {
    if (receiver === sender || receiver.closed) continue;
    for (const { kind, id } of sender.previewsSent.values()) {
      if (release(receiver, `${sender.memberId}|${kind}:${id}`, sender)) receiver.send({ t: "eph", from: sender.memberId, e: cancelEvent(kind, id) });
    }
  }
  sender.previewsSent.clear();
}
