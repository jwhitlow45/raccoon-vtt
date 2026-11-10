import { keys, partsKey, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { mayMoveToken } from "#shared/permissions.ts";
import { ownsToken, perPlayerScene, projectEntity, withheldFromViewer } from "#shared/project.ts";
import { startFloor } from "#shared/rules/floors.ts";
import { canSqueeze } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { outboundEph, type EphEvent, type EphEventOut } from "#shared/protocol.ts";
import type { PartySight } from "#shared/ruleHooks.ts";
import type { Connection, PreviewKind, SentPreview } from "./connection.ts";
import { heldBy, perPlayerClasses } from "./fanout.ts";

/**
 * The ephemeral channel (design 7.6). Nothing here is stored: an event is
 * forwarded to the viewers on its scene, filtered per receiver with the same
 * projection that filters state, and checked against the committed fog and,
 * on a vision scene, the party's sight, so a drag into the dark or a ruler
 * to a hidden creature never shows players where it is. A player who was
 * showing a preview that is now withheld gets a bare cancel instead, so the
 * preview disappears rather than freezing. On a per-player scene each
 * player is judged by their own sight and fog
 * (docs/design/design-v1-per-player-vision.md 7.5).
 *
 * An event happens on one floor, which the client names (`sceneId`), and
 * reaches only receivers holding that floor, with its `sceneId`, so a
 * device keeps it with that floor (docs/design/design-v1-floors.md 8.2).
 *
 * A ruler carried over stairs (docs/design/design-v1-floors.md phase 3,
 * 4.4) names, inbound only, every token a stop sat on before the landing
 * and the ends it crossed. It goes only to a receiver who sees every one
 * of those tokens and holds every one of those ends, and every receiver
 * gets it without them (`outboundEph`). The server keeps the inbound frame,
 * which every later judgement of the preview reads.
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

/**
 * Whether every token the event names stands on its floor now
 * (docs/design/design-v1-floors.md 8.2, FLR-SOL-3): a drag's token and a
 * ruler's anchors. A frame from before its token moved to another floor, or
 * a ruler anchored on two floors, fails, and goes nowhere: a receiver
 * holding both floors would otherwise see Ground's drag land on Roof. A
 * token gone fails as well, as projection would withhold it.
 */
function onItsFloor(state: RoomState, sceneId: string, e: EphEvent): boolean {
  const here = (tokenId: string) => state.tokens[tokenId]?.sceneId === sceneId;
  switch (e.k) {
    case "dragStart":
    case "dragMove":
    case "dragEnd":
      return here(e.tokenId);
    case "ruler":
      return e.points.every((p) => p.tokenId === undefined || here(p.tokenId));
    default:
      return true;
  }
}

/**
 * Whether a carried ruler's chain holds now (docs/design/design-v1-floors.md
 * phase 3, 4.4, step 1): every end it names exists, each leads to the floor
 * of the next, the last to the frame's floor, and every token it names
 * exists. A frame that fails goes nowhere, as one whose anchor is gone
 * does (onItsFloor), so stairs removed or a creature deleted ends it.
 */
function chainHolds(state: RoomState, sceneId: string, e: EphEvent): boolean {
  if (e.k !== "ruler" || e.prior === undefined) return true;
  const ends = e.prior.ends.map((id) => state.floorLinks?.[id]);
  for (const [i, end] of ends.entries()) {
    if (end === undefined) return false;
    if (end.to !== (ends[i + 1]?.sceneId ?? sceneId)) return false;
  }
  return e.prior.anchors.every((id) => state.tokens[id] !== undefined);
}

/**
 * Whether the sender's frame may go out at all, to anyone: a drag the
 * sender may make, every token it names on its floor, and a carried
 * ruler's chain whole.
 */
function senderMay(state: RoomState, sender: Connection, sceneId: string, e: EphEvent): boolean {
  if ((e.k === "dragStart" || e.k === "dragMove" || e.k === "dragEnd") && !mayMove(state, sender, e.tokenId)) return false;
  return onItsFloor(state, sceneId, e) && chainHolds(state, sceneId, e);
}

/** Whether the receiver holds the event's floor (heldBy): a player the floors they hold, a DM every floor of their scene. */
function holds(state: RoomState, receiver: Connection, sceneId: string): boolean {
  return heldBy(state, receiver).has(sceneId);
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

function cancelEvent(kind: PreviewKind, id: string): EphEventOut {
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
 * already passed (docs/design/design-v1-maps-vision.md 4.3.5).
 */
function forPlayer(state: RoomState, sceneId: string, e: EphEventOut, receiver: Connection): EphEventOut {
  if (e.k !== "dragMove") return e;
  let out = e;
  // A route's cost reads private facts, such as a Swim Speed, so only the token's owners get it (docs/design/design-v1-movement.md 6.5).
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

/** Whether the receiver's copy holds an end of stairs or a ladder (project.ts projectFloorLinkCtx), so it holds the end's floor and the end is not under its fog. */
function endHeldBy(state: RoomState, receiver: Connection, linkId: string): boolean {
  return projectEntity(keys.floorLink(linkId), state, receiver.viewer, { sceneId: receiver.sceneId }) !== null;
}

/**
 * Whether a player may not see a drag preview where it is now: projection's
 * own rule for a token standing there, by that player's sight and fog
 * (section 13.4 on the merged fog, the party's sight on a vision scene,
 * party members and exempt tokens always shown, and on a per-player scene
 * the player's own, docs/design/design-v1-per-player-vision.md 6.2). The
 * footprint is the server's to judge, whatever the frame says
 * (docs/design/design-v1-maps-vision.md 4.1, "Drag previews"). So a Large
 * creature dragged along a corridor out of sight is not shown by the half
 * of its preview drawn over the corridor's walls.
 *
 * A creature that can squeeze is withheld where either its full footprint
 * or the one size smaller around the preview point would be, and any other
 * creature by its full footprint (D-261101-187), on squares and hexes
 * alike. The preview point is unsnapped and only the drop settles whether
 * the creature squeezes, so the preview errs toward withholding whichever
 * footprint the drop gives it, and needs no walk and no walls to choose the
 * footprint. The stored squeeze is dropped first so the full footprint is
 * always tested: the squeezed one does not always lie inside it (a custom
 * 1 by 3 creature's reaches out of its snapped rectangle), so a token
 * already squeezed would otherwise skip it. On hexes each footprint is judged by
 * the sub-cells inside the hexes it stands on, as projection judges a
 * creature standing there (docs/design/design-v1-hex-grids.md HX-D10).
 */
function previewWithheld(state: RoomState, viewer: Viewer, token: Token, x: number, y: number): boolean {
  const { squeeze: _squeeze, ...rest } = token;
  return withheldFromViewer(state, viewer, { ...rest, x, y }) || (canSqueeze(rest) && withheldFromViewer(state, viewer, { ...rest, x, y, squeeze: true }));
}

/**
 * What a player's judgment of a drag preview reads (docs/design/design-v1-per-player-vision.md
 * 7.5), so players who read the same are judged once per event: with
 * vision on, the sight they read, which viewers with the same sources share,
 * with fog alone, their fog (each holder alone, the rest together), and
 * with both off nothing, since nothing is withheld then. On a hex scene with
 * fog on a creature's outline is clipped by the walls the receiver holds,
 * which holders who share one sight hold apart, so there their fog joins the
 * sight. A whole-party scene reads the same for every player. Null when
 * nothing is withheld.
 */
function judgedBy(state: RoomState, sceneId: string, receiver: Connection, sights: Map<PartySight, number>): string | null {
  const scene = state.scenes[sceneId];
  if (!scene || (scene.vision?.on !== true && !scene.fogEnabled)) return null;
  if (!perPlayerScene(scene)) return "party";
  // The fan-out's classes (fanout.ts perPlayerClasses): withholding reads sight alone with vision on, and fog alone otherwise.
  const { sight, fog } = perPlayerClasses(state, sceneId, receiver.memberId, sights);
  if (scene.vision?.on !== true) return partsKey(["fog", fog]);
  return scene.fogEnabled && isHex(sceneGrid(scene)) ? partsKey(["sight", sight, fog]) : partsKey(["sight", sight]);
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
    // A carried ruler also needs every token it sat on before the landing and every end it crossed (phase 3, 4.4, step 2),
    // so it shows no walk from a creature, or through stairs, the receiver does not hold.
    case "ruler":
      return (
        e.points.every((p) => p.tokenId === undefined || tokenVisibleTo(state, receiver, p.tokenId)) &&
        (e.prior === undefined || (e.prior.anchors.every((id) => tokenVisibleTo(state, receiver, id)) && e.prior.ends.every((id) => endHeldBy(state, receiver, id))))
      );
    case "focus":
      return receiver.role === "player";
    // A DM device's camera, for table displays only (docs/design/design-v1-dm-tools.md 3.1). Like every event it goes only to
    // receivers holding its floor, and a display holds only floors players have reached, so the TV never moves to a scene
    // or floor players cannot see.
    case "view":
      return receiver.display;
    default:
      return true;
  }
}

export function routeEphemeral(state: RoomState, sender: Connection, sceneId: string, e: EphEvent, receivers: Iterable<Connection>): void {
  if (!state.scenes[sceneId]) return;
  // A player previews only on a floor they hold, or the start floor as before floors, which reaches nobody behind a
  // blackout but the DM. The DM may be anywhere.
  if (sender.role === "player" && startFloor(state) !== sceneId && !holds(state, sender, sceneId)) return;
  const all = [...receivers];
  expireStale(sender, all);
  const preview = previewOf(e);
  if (preview?.ends) sender.previewsSent.delete(`${preview.kind}:${preview.id}`);
  if (!shared(sender, e)) return;
  // A drag the sender may not make is withheld from everyone, and one
  // already showing (the token was locked mid-drag, say) is cancelled.
  const may = senderMay(state, sender, sceneId, e);
  const out = outboundEph(e);
  const heldKey = preview ? `${sender.memberId}|${preview.kind}:${preview.id}` : null;
  const withheld = withheldFor(state, sceneId, e);
  // A bare end names only what stopped, so it goes to those showing that preview. Sent to
  // everyone, a cancelled drag of a hidden or fogged token would hand players its id.
  const bareEnd = e.k === "dragCancel" || e.k === "rulerEnd" || e.k === "aoeEnd";
  for (const receiver of all) {
    if (receiver === sender || receiver.closed || receiver.held === null) continue;
    if (!holds(state, receiver, sceneId)) continue;
    if (bareEnd) {
      if (heldKey && receiver.previewsHeld.delete(heldKey)) receiver.send({ t: "eph", from: sender.memberId, sceneId, e });
      continue;
    }
    if (may && allowed(state, receiver, e, withheld)) {
      receiver.send({ t: "eph", from: sender.memberId, sceneId, e: receiver.role === "player" ? forPlayer(state, sceneId, out, receiver) : out });
      if (heldKey && preview) {
        if (preview.ends) receiver.previewsHeld.delete(heldKey);
        else receiver.previewsHeld.set(heldKey, sender.id);
      }
    } else if (heldKey && preview && receiver.previewsHeld.has(heldKey)) {
      receiver.previewsHeld.delete(heldKey);
      receiver.send({ t: "eph", from: sender.memberId, sceneId, e: cancelEvent(preview.kind, preview.id) });
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

function dropSent(sender: Connection, key: string, sent: { kind: PreviewKind; id: string; sceneId: string }, receivers: readonly Connection[]): void {
  sender.previewsSent.delete(key);
  const heldKey = `${sender.memberId}|${key}`;
  for (const receiver of receivers) if (release(receiver, heldKey, sender)) receiver.send({ t: "eph", from: sender.memberId, sceneId: sent.sceneId, e: cancelEvent(sent.kind, sent.id) });
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
 * per event for each judgment (judgedBy), since it reads up to two
 * footprints on squares and is a wall test besides on hexes:
 * on a per-player scene one per source set with vision on, or per fog
 * class with fog alone (docs/design/design-v1-per-player-vision.md 7.5).
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
    if (hidden === undefined) answers.set(by, (hidden = previewWithheld(state, receiver.viewer, token, e.x, e.y)));
    return hidden;
  };
}

/**
 * Previews held on other screens, judged again after a batch that set
 * `global` (docs/design/design-v1-per-player-vision.md 7.2), or changed the
 * floors some receiver holds (docs/design/design-v1-floors.md 8.1): a switch to
 * or from Per player, a holder pick, Hide, a creature moved to another
 * floor or any other change that re-projects everything can leave a
 * receiver showing a drag or a live ruler it may no longer see. Each is
 * judged by its last frame, as it would be routed now, so one whose token
 * left its floor ends, and a receiver that may no longer have it gets its
 * bare cancel. A carried ruler's last frame is the inbound one, so it is
 * judged by its chain and by every token and end it names too
 * (docs/design/design-v1-floors.md phase 3, 4.4). A batch that is neither
 * still ends a preview over a key it took from a screen (cancelLost).
 */
export function rejudgePreviews(state: RoomState, connections: Iterable<Connection>): void {
  const all = [...connections];
  for (const sender of all) {
    expireStale(sender, all);
    for (const [key, { kind, id, sceneId, last }] of [...sender.previewsSent]) {
      const heldKey = `${sender.memberId}|${kind}:${id}`;
      const judged = state.scenes[sceneId] !== undefined;
      const may = senderMay(state, sender, sceneId, last);
      const withheld = withheldFor(state, sceneId, last);
      for (const receiver of all) {
        // Only the screens showing this socket's frame are judged by it.
        if (receiver === sender || receiver.closed || receiver.previewsHeld.get(heldKey) !== sender.id) continue;
        const here = judged && holds(state, receiver, sceneId);
        if (here && may && allowed(state, receiver, last, withheld)) continue;
        release(receiver, heldKey, sender);
        receiver.send({ t: "eph", from: sender.memberId, sceneId, e: cancelEvent(kind, id) });
      }
      // A preview no screen shows from this socket any more keeps no frame.
      if (!showsAnywhere(sender, heldKey, all)) sender.previewsSent.delete(key);
    }
  }
}

/** The keys of the tokens and ends a kept frame names: a drag's token, a ruler's stop tokens, and a carried ruler's anchors and ends. */
function namedKeys(e: EphEvent): EntityKey[] {
  switch (e.k) {
    case "dragStart":
    case "dragMove":
    case "dragEnd":
      return [keys.token(e.tokenId)];
    case "ruler": {
      const out = e.points.flatMap((p) => (p.tokenId === undefined ? [] : [keys.token(p.tokenId)]));
      if (e.prior) out.push(...e.prior.anchors.map((id) => keys.token(id)), ...e.prior.ends.map((id) => keys.floorLink(id)));
      return out;
    }
    default:
      return [];
  }
}

/**
 * The previews a screen shows that the batch just took a named key from
 * (docs/design/design-v1-floors.md phase 3, 4.4, D-261110-180 and 181): the
 * fan-out gives the token and end keys whose deleted change it sent this
 * connection (fanout.ts publishBatch `lost`), and each preview the screen
 * shows whose kept frame names one of them gets its bare cancel in the same
 * batch. So a Hide, a light turned off, a door closed, fog added or stairs
 * removed, and the Undo or Redo of any of them, ends a drag or ruler over
 * what the screen no longer holds, which no global batch would judge again.
 * Only this screen's previews are read.
 */
export function cancelLost(receiver: Connection, lost: readonly EntityKey[], connections: Iterable<Connection>): void {
  if (receiver.closed || receiver.previewsHeld.size === 0 || lost.length === 0) return;
  const gone = new Set(lost);
  const all = [...connections];
  for (const [heldKey, senderId] of [...receiver.previewsHeld]) {
    const sender = all.find((c) => c.id === senderId);
    const key = heldKey.slice(heldKey.indexOf("|") + 1);
    const sent = sender?.previewsSent.get(key);
    if (!sender || !sent || !namedKeys(sent.last).some((k) => gone.has(k))) continue;
    release(receiver, heldKey, sender);
    receiver.send({ t: "eph", from: sender.memberId, sceneId: sent.sceneId, e: cancelEvent(sent.kind, sent.id) });
    // A preview no screen shows from this socket any more keeps no frame, as rejudgePreviews drops one.
    if (!showsAnywhere(sender, heldKey, all)) sender.previewsSent.delete(key);
  }
}

/** When a socket goes away, every preview it left on other screens is cancelled (design 7.6). */
export function cancelPreviews(sender: Connection, receivers: Iterable<Connection>): void {
  if (sender.previewsSent.size === 0) return;
  for (const receiver of receivers) {
    if (receiver === sender || receiver.closed) continue;
    for (const { kind, id, sceneId } of sender.previewsSent.values()) {
      if (release(receiver, `${sender.memberId}|${kind}:${id}`, sender)) receiver.send({ t: "eph", from: sender.memberId, sceneId, e: cancelEvent(kind, id) });
    }
  }
  sender.previewsSent.clear();
}
