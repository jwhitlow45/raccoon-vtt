import { keys, partsKey, type EntityKey } from "#shared/keys.ts";
import type { RoomState, Token, Viewer } from "#shared/model.ts";
import { mayMoveToken } from "#shared/permissions.ts";
import { ownsToken, perPlayerScene, projectEntity, withheldFromViewer } from "#shared/project.ts";
import { ownEntry } from "#shared/records.ts";
import { startFloor } from "#shared/rules/floors.ts";
import { canSqueeze } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid } from "#shared/rules/grid.ts";
import { expandGroup, isGroupFrame, loneEphSchema, outboundEph, type EphEvent, type EphEventOut, type GroupFrame, type GroupRoster } from "#shared/protocol.ts";
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
 *
 * A group drag (design 7.6) sends one frame for all its tokens. Each one is
 * expanded by the roster it bound as it arrived into every token's own
 * frame, which is judged and sent exactly as a lone frame of that token
 * would be, so receivers read the same events either way.
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
  const ends = e.prior.ends.map((id) => ownEntry(state.floorLinks, id));
  for (const [i, end] of ends.entries()) {
    if (end === undefined) return false;
    if (end.to !== (ends[i + 1]?.sceneId ?? sceneId)) return false;
  }
  return e.prior.anchors.every((id) => ownEntry(state.tokens, id) !== undefined);
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
 * What a socket's previews may keep on the server (review PV3-ASTRA-2): an
 * entry for each preview, a drag gesture's one entry for all its tokens,
 * each with its last frame, at most this many entries, the one framed
 * least recently going first. Past this many, a socket has lost the ends
 * of that many previews within PREVIEW_STALE_MS, which no device does. An
 * entry with no frame for PREVIEW_STALE_MS has long left every screen,
 * which drops a preview after 3 s without one (client/state/ephemeral.ts
 * PREVIEW_IDLE_MS), and goes at the clock's next sweep (sweepPreviews),
 * which reads nothing a socket sends.
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

/** A lone drag's entry on its socket, one token's, as a device sends it one token at a time. */
const dragKey = (tokenId: string) => `drag:${tokenId}`;
/** A group drag's entry on its socket, all its tokens', by its gesture number. */
const gestureKey = (g: number) => `drag#${g}`;

/**
 * The tokens a drag entry framed: its pressed token, then its members. A
 * member whose frame never routed has no point yet.
 */
function entryTokens(sent: SentPreview): readonly string[] {
  return sent.members ? [sent.id, ...sent.members.ids] : [sent.id];
}

/**
 * What an entry still shows, each with the frame other screens are judged
 * by: a ruler's or an area's one preview, and of a drag's tokens each one
 * the entry still owns (Connection.dragOwners), a member by its last point.
 */
function partsOf(sender: Connection, key: string, sent: SentPreview): { part: string; id: string; frame: EphEvent }[] {
  if (sent.kind !== "drag") return [{ part: key, id: sent.id, frame: sent.last }];
  const out: { part: string; id: string; frame: EphEvent }[] = [];
  if (sender.dragOwners.get(sent.id) === key) out.push({ part: dragKey(sent.id), id: sent.id, frame: sent.last });
  const members = sent.members;
  if (members) {
    for (const [i, id] of members.ids.entries()) {
      if (sender.dragOwners.get(id) !== key) continue;
      const x = members.points[2 * i]!;
      const y = members.points[2 * i + 1]!;
      if (!Number.isNaN(x)) out.push({ part: dragKey(id), id, frame: { k: "dragMove", tokenId: id, x, y } });
    }
  }
  return out;
}

/** Each token an entry still owns goes back to owning nothing. */
function disown(sender: Connection, key: string, sent: SentPreview): void {
  if (sent.kind !== "drag") return;
  for (const id of entryTokens(sent)) if (sender.dragOwners.get(id) === key) sender.dragOwners.delete(id);
}

/**
 * Whether a gesture's frame may act on a token: not while a newer gesture
 * owns it. A lone frame acts on its token whatever owns it, as before
 * group frames, and takes it from any gesture.
 */
function mayAct(sender: Connection, key: string, tokenId: string): boolean {
  const owner = sender.dragOwners.get(tokenId);
  if (owner === undefined || owner === key || !key.startsWith("drag#") || !owner.startsWith("drag#")) return true;
  return Number(owner.slice(5)) <= Number(key.slice(5));
}

/** The token now belongs to `key`, or to nothing, and an entry that owned it and owns nothing more goes. */
function setOwner(sender: Connection, tokenId: string, key: string | null): void {
  const before = sender.dragOwners.get(tokenId);
  if (key === null) sender.dragOwners.delete(tokenId);
  else sender.dragOwners.set(tokenId, key);
  if (before === undefined || before === key) return;
  const left = sender.previewsSent.get(before);
  if (left && partsOf(sender, before, left).length === 0) sender.previewsSent.delete(before);
}

export function routeEphemeral(state: RoomState, sender: Connection, sceneId: string, e: EphEvent | GroupFrame, receivers: Iterable<Connection>, at = sender.now(), version: GroupRoster | null = null): void {
  if (!state.scenes[sceneId]) return;
  // A player previews only on a floor they hold, or the start floor as before floors, which reaches nobody behind a
  // blackout but the DM. The DM may be anywhere.
  if (sender.role === "player" && startFloor(state) !== sceneId && !holds(state, sender, sceneId)) return;
  const all = [...receivers];
  if (isGroupFrame(e)) {
    routeGroup(state, sender, sceneId, e, all, at, version);
    return;
  }
  if (e.k === "dragStart" || e.k === "dragMove" || e.k === "dragEnd" || e.k === "dragCancel") {
    routeDrags(state, sender, sceneId, dragKey(e.tokenId), [e], all, at, { ends: e.k === "dragEnd" || e.k === "dragCancel", members: null, checked: true });
    return;
  }
  const preview = previewOf(e);
  if (preview?.ends) sender.previewsSent.delete(`${preview.kind}:${preview.id}`);
  if (!shared(sender, e)) return;
  // A ruler whose chain no longer holds is withheld from everyone, and one already showing is cancelled.
  const may = senderMay(state, sender, sceneId, e);
  const out = outboundEph(e);
  const heldKey = preview ? `${sender.memberId}|${preview.kind}:${preview.id}` : null;
  const bareEnd = e.k === "rulerEnd" || e.k === "aoeEnd";
  for (const receiver of all) {
    if (receiver === sender || receiver.closed || receiver.held === null) continue;
    if (!holds(state, receiver, sceneId)) continue;
    if (bareEnd) {
      if (heldKey && receiver.previewsHeld.delete(heldKey)) receiver.send({ t: "eph", from: sender.memberId, sceneId, e });
      continue;
    }
    if (may && allowed(state, receiver, e, () => false)) {
      receiver.send({ t: "eph", from: sender.memberId, sceneId, e: out });
      if (heldKey && preview) receiver.previewsHeld.set(heldKey, sender.id);
    } else if (heldKey && preview && receiver.previewsHeld.has(heldKey)) {
      receiver.previewsHeld.delete(heldKey);
      receiver.send({ t: "eph", from: sender.memberId, sceneId, e: cancelEvent(preview.kind, preview.id) });
    }
  }
  if (preview && !preview.ends) keepSent(sender, `${preview.kind}:${preview.id}`, { kind: preview.kind, id: preview.id, sceneId, last: e, at }, all);
}

/**
 * A group frame, expanded into every token's own frame by the roster it
 * bound as it arrived (shared/protocol.ts expandGroup), each judged by
 * today's rules for a lone frame as if the device had sent it alone. A
 * frame whose gesture had no roster open expands to the pressed token's
 * alone, and the device is asked for the roster (`need`).
 */
function routeGroup(state: RoomState, sender: Connection, sceneId: string, e: GroupFrame, all: readonly Connection[], at: number, version: GroupRoster | null): void {
  const ends = e.k === "dragCancel" || e.k === "groupEnd";
  if (version === null && !ends && sender.gestures.mayAsk(e.g, at)) sender.send({ t: "need", id: e.tokenId, g: e.g });
  routeDrags(state, sender, sceneId, gestureKey(e.g), expandGroup(e, version), all, at, { ends, members: version?.ids ?? null, checked: false });
}

/**
 * One step of a drag entry: its tokens' frames, the pressed token's first,
 * each routed as a lone frame. A frame that a lone frame's schema or size
 * refuses is dropped alone, so the other tokens' frames still go. Each
 * token belongs to the newest entry that framed it: a gesture's frame
 * never acts on a token a newer gesture framed since, so a late end of an
 * old gesture never ends a newer one's preview. An end then ends whatever
 * else the entry still shows.
 */
function routeDrags(
  state: RoomState,
  sender: Connection,
  sceneId: string,
  key: string,
  frames: readonly EphEvent[],
  all: readonly Connection[],
  at: number,
  step: { ends: boolean; members: readonly string[] | null; checked: boolean },
): void {
  const pressed = frames[0];
  if (pressed === undefined || !("tokenId" in pressed)) return;
  const before = sender.previewsSent.get(key);
  const ids = step.members ?? before?.members?.ids ?? null;
  if (before) endLeft(sender, key, before, pressed.tokenId, ids, all);
  const points = ids === null ? null : pointsFor(ids, before);
  let last = before?.last ?? pressed;
  for (const [j, frame] of frames.entries()) {
    if (!("tokenId" in frame)) continue;
    const tokenId = frame.tokenId;
    if (!mayAct(sender, key, tokenId)) continue;
    if (!step.checked && !loneEphSchema.safeParse(frame).success) continue;
    routeDragFrame(state, sender, sceneId, frame, all);
    const ended = frame.k === "dragEnd" || frame.k === "dragCancel";
    setOwner(sender, tokenId, ended ? null : key);
    if (ended || !("x" in frame)) continue;
    if (j === 0) last = frame;
    else if (points && step.members) {
      points[2 * (j - 1)] = frame.x;
      points[2 * (j - 1) + 1] = frame.y;
    }
  }
  if (step.ends) {
    // What the entry still shows, a member its end could not name among them, ends with it.
    const kept = sender.previewsSent.get(key) ?? before;
    if (kept) dropSent(sender, key, kept, all);
    sender.previewsSent.delete(key);
    return;
  }
  keepSent(sender, key, { kind: "drag", id: pressed.tokenId, sceneId, last, at, ...(ids && points ? { members: { ids, points } } : {}) }, all);
}

/**
 * A step that names other tokens than its entry did, by a new roster or
 * another pressed token, ends each token the entry still owns that it no
 * longer names, with a bare cancel to the screens showing this socket's
 * frame of it, and gives it up. So what a socket's entries own never
 * passes what they name, however many rosters a gesture sends.
 */
function endLeft(sender: Connection, key: string, before: SentPreview, pressedId: string, ids: readonly string[] | null, receivers: readonly Connection[]): void {
  if (before.id === pressedId && (before.members?.ids ?? null) === ids) return;
  const named = new Set(ids);
  named.add(pressedId);
  for (const id of entryTokens(before)) {
    if (named.has(id) || sender.dragOwners.get(id) !== key) continue;
    sender.dragOwners.delete(id);
    const heldKey = `${sender.memberId}|${dragKey(id)}`;
    for (const receiver of receivers) if (release(receiver, heldKey, sender)) receiver.send({ t: "eph", from: sender.memberId, sceneId: before.sceneId, e: cancelEvent("drag", id) });
  }
}

/** The points an entry holds for these members: the ones it held, by id, and none for a member it never framed. */
function pointsFor(ids: readonly string[], before: SentPreview | undefined): Float64Array {
  const points = new Float64Array(ids.length * 2).fill(Number.NaN);
  const held = before?.members;
  if (!held) return points;
  if (held.ids === ids) {
    points.set(held.points);
    return points;
  }
  const at = new Map(held.ids.map((id, i) => [id, i]));
  for (const [i, id] of ids.entries()) {
    const k = at.get(id);
    if (k === undefined) continue;
    points[2 * i] = held.points[2 * k]!;
    points[2 * i + 1] = held.points[2 * k + 1]!;
  }
  return points;
}

/**
 * One token's drag frame to every receiver holding its floor, as a lone
 * frame always went: a drag the sender may not make is withheld from
 * everyone, and one already showing (the token was locked mid-drag, say)
 * is cancelled.
 */
function routeDragFrame(state: RoomState, sender: Connection, sceneId: string, e: EphEvent, all: readonly Connection[]): void {
  if (!("tokenId" in e)) return;
  const may = senderMay(state, sender, sceneId, e);
  const heldKey = `${sender.memberId}|drag:${e.tokenId}`;
  const withheld = withheldFor(state, sceneId, e);
  const ends = e.k === "dragEnd" || e.k === "dragCancel";
  for (const receiver of all) {
    if (receiver === sender || receiver.closed || receiver.held === null) continue;
    if (!holds(state, receiver, sceneId)) continue;
    // A bare cancel names only what stopped, so it goes to those showing that preview. Sent to
    // everyone, a cancelled drag of a hidden or fogged token would hand players its id.
    if (e.k === "dragCancel") {
      if (receiver.previewsHeld.delete(heldKey)) receiver.send({ t: "eph", from: sender.memberId, sceneId, e });
      continue;
    }
    if (may && allowed(state, receiver, e, withheld)) {
      const out = outboundEph(e);
      receiver.send({ t: "eph", from: sender.memberId, sceneId, e: receiver.role === "player" ? forPlayer(state, sceneId, out, receiver) : out });
      if (ends) receiver.previewsHeld.delete(heldKey);
      else receiver.previewsHeld.set(heldKey, sender.id);
    } else if (receiver.previewsHeld.has(heldKey)) {
      receiver.previewsHeld.delete(heldKey);
      receiver.send({ t: "eph", from: sender.memberId, sceneId, e: cancelEvent("drag", e.tokenId) });
    }
  }
}

/** Keeps an entry's last frame while some screen shows this socket's frame of it, and none nobody receives, within the socket's most. */
function keepSent(sender: Connection, key: string, sent: SentPreview, receivers: readonly Connection[]): void {
  sender.previewsSent.delete(key);
  if (!showsAnywhere(sender, key, sent, receivers)) {
    disown(sender, key, sent);
    return;
  }
  sender.previewsSent.set(key, sent);
  for (const [oldest, kept] of sender.previewsSent) {
    if (sender.previewsSent.size <= MOST_PREVIEWS_SENT) break;
    dropSent(sender, oldest, kept, receivers);
  }
}

/**
 * Every socket's entries with no frame for PREVIEW_STALE_MS go, each with
 * a bare cancel to the screens still showing it, and so do its gestures'
 * rosters. The actor runs it once a second, so when an entry goes depends
 * on the clock and that entry's own last frame alone, never on what else
 * the socket sends.
 */
export function sweepPreviews(connections: Iterable<Connection>, now?: number): void {
  const all = [...connections];
  for (const sender of all) {
    const at = now ?? sender.now();
    for (const [key, sent] of sender.previewsSent) {
      // The map holds them in the order of their last frames.
      if (at - sent.at < PREVIEW_STALE_MS) break;
      dropSent(sender, key, sent, all);
    }
    sender.gestures.sweep(at);
  }
}

function dropSent(sender: Connection, key: string, sent: SentPreview, receivers: readonly Connection[]): void {
  sender.previewsSent.delete(key);
  for (const { part, id } of partsOf(sender, key, sent)) {
    const heldKey = `${sender.memberId}|${part}`;
    for (const receiver of receivers) if (release(receiver, heldKey, sender)) receiver.send({ t: "eph", from: sender.memberId, sceneId: sent.sceneId, e: cancelEvent(sent.kind, id) });
  }
  disown(sender, key, sent);
}

/*
 * A screen holds one preview per member and id, whichever of the member's
 * sockets sent its latest frame (review PV3-ASTRA-3). So a socket's entry
 * that goes ends the preview only on the screens where that socket's frame
 * is the one shown, and one whose frames another socket has replaced
 * everywhere just goes. An explicit end is the member's, from either
 * socket, as the screen reads it, and routeEphemeral ends it everywhere.
 * A drag entry's tokens each count apart, and only those the entry still
 * owns on its socket.
 */
function release(receiver: Connection, heldKey: string, sender: Connection): boolean {
  if (receiver === sender || receiver.closed || receiver.previewsHeld.get(heldKey) !== sender.id) return false;
  receiver.previewsHeld.delete(heldKey);
  return true;
}

function showsAnywhere(sender: Connection, key: string, sent: SentPreview, receivers: readonly Connection[]): boolean {
  const held = partsOf(sender, key, sent).map(({ part }) => `${sender.memberId}|${part}`);
  return receivers.some((r) => r !== sender && !r.closed && held.some((k) => r.previewsHeld.get(k) === sender.id));
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

/** Whether any screen shows a preview, so the actor judges them again after a batch (rejudgePreviews). */
export function holdsPreview(connections: Iterable<Connection>): boolean {
  for (const conn of connections) if (!conn.closed && conn.previewsHeld.size > 0) return true;
  return false;
}

/** Whether a kept frame is past PREVIEW_STALE_MS: dead by the clock alone, so only the sweep or the sender's close ends it. */
function stale(sent: SentPreview, now: number): boolean {
  return now - sent.at >= PREVIEW_STALE_MS;
}

/**
 * Previews held on other screens, judged again after every batch while a
 * screen holds one (docs/design/design-v1-per-player-vision.md 7.2,
 * docs/design/design-v1-floors.md 8.1): a switch to or from Per player, a
 * holder pick, Hide, a creature moved to another floor, a lock or a change
 * to a floor some screen does not hold can leave a receiver showing a drag
 * or a live ruler it may no longer see. Each is judged by its last frame,
 * as it would be routed now, a drag gesture's member by its own last point,
 * so one whose token left its floor ends, and a receiver that may no longer
 * have it gets its bare cancel. A carried ruler's last frame is the inbound
 * one, so it is judged by its chain and by every token and end it names too
 * (docs/design/design-v1-floors.md phase 3, 4.4).
 *
 * An entry past PREVIEW_STALE_MS is neither judged, cancelled nor forgotten
 * here: the clock's sweep (sweepPreviews) or the sender's close
 * (cancelPreviews) ends it, as it would with no batch between.
 */
export function rejudgePreviews(state: RoomState, connections: Iterable<Connection>, tick?: number): void {
  const all = [...connections];
  for (const sender of all) {
    for (const [key, sent] of [...sender.previewsSent]) {
      if (stale(sent, tick ?? sender.now())) continue;
      const { kind, sceneId } = sent;
      const judged = state.scenes[sceneId] !== undefined;
      for (const { part, id, frame } of partsOf(sender, key, sent)) {
        const heldKey = `${sender.memberId}|${part}`;
        const may = senderMay(state, sender, sceneId, frame);
        const withheld = withheldFor(state, sceneId, frame);
        for (const receiver of all) {
          // Only the screens showing this socket's frame are judged by it.
          if (receiver === sender || receiver.closed || receiver.previewsHeld.get(heldKey) !== sender.id) continue;
          const here = judged && holds(state, receiver, sceneId);
          if (here && may && allowed(state, receiver, frame, withheld)) continue;
          release(receiver, heldKey, sender);
          receiver.send({ t: "eph", from: sender.memberId, sceneId, e: cancelEvent(kind, id) });
        }
      }
      // An entry no screen shows from this socket any more keeps no frame.
      if (!showsAnywhere(sender, key, sent, all)) {
        sender.previewsSent.delete(key);
        disown(sender, key, sent);
      }
    }
  }
}

/**
 * The entry a screen's held preview comes from on its socket, and the frame
 * it is judged by: a drag's token by the entry that owns it.
 */
function heldEntry(sender: Connection, part: string): { key: string; sent: SentPreview; frame: EphEvent } | null {
  const key = part.startsWith("drag:") ? sender.dragOwners.get(part.slice(5)) : part;
  const sent = key === undefined ? undefined : sender.previewsSent.get(key);
  if (key === undefined || sent === undefined) return null;
  const found = partsOf(sender, key, sent).find((p) => p.part === part);
  return found ? { key, sent, frame: found.frame } : null;
}

/**
 * The previews a screen shows that the batch just took a named key from
 * (docs/design/design-v1-floors.md phase 3, 4.4, D-261110-180 and 181): the
 * fan-out gives the token and end keys whose deleted change it sent this
 * connection (fanout.ts publishBatch `lost`), and each preview the screen
 * shows whose kept frame names one of them gets its bare cancel in the same
 * batch. So a Hide, a light turned off, a door closed, fog added or stairs
 * removed, and the Undo or Redo of any of them, ends a drag or ruler over
 * what the screen no longer holds with the batch's own change, before the
 * batch's judgment of every held preview (rejudgePreviews). Only this
 * screen's previews are read, a drag gesture's tokens each apart.
 */
export function cancelLost(receiver: Connection, lost: readonly EntityKey[], connections: Iterable<Connection>, tick?: number): void {
  if (receiver.closed || receiver.previewsHeld.size === 0 || lost.length === 0) return;
  const gone = new Set(lost);
  const all = [...connections];
  for (const [heldKey, senderId] of [...receiver.previewsHeld]) {
    const sender = all.find((c) => c.id === senderId);
    const part = heldKey.slice(heldKey.indexOf("|") + 1);
    const held = sender ? heldEntry(sender, part) : null;
    // A stale frame waits for the sweep or its sender's close, as in rejudgePreviews.
    if (!sender || !held || stale(held.sent, tick ?? sender.now()) || !namedKeys(held.frame).some((k) => gone.has(k))) continue;
    release(receiver, heldKey, sender);
    receiver.send({ t: "eph", from: sender.memberId, sceneId: held.sent.sceneId, e: cancelEvent(held.sent.kind, part.slice(part.indexOf(":") + 1)) });
    // An entry no screen shows from this socket any more keeps no frame, as rejudgePreviews drops one.
    if (!showsAnywhere(sender, held.key, held.sent, all)) {
      sender.previewsSent.delete(held.key);
      disown(sender, held.key, held.sent);
    }
  }
}

/** When a socket goes away, every preview it left on other screens is cancelled (design 7.6), a gesture's tokens each, and its rosters go. */
export function cancelPreviews(sender: Connection, receivers: Iterable<Connection>): void {
  sender.gestures.clear();
  if (sender.previewsSent.size === 0) return;
  const all = [...receivers];
  for (const [key, sent] of [...sender.previewsSent]) dropSent(sender, key, sent, all);
  sender.previewsSent.clear();
  sender.dragOwners.clear();
}
