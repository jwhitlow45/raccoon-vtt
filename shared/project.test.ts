import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys, readEntity } from "./keys.ts";
import type { Drawing, Effect, FogTile, FreeWall, LogEvent, RoomState, Stamp, Token, Viewer } from "./model.ts";
import type { Op } from "./protocol.ts";
import {
  allKeys,
  dependents,
  diffProjection,
  hash128,
  hashValue,
  heldOf,
  hpAccess,
  isPartyMember,
  pageReadableBy,
  partySightOf,
  pinCells,
  playersToken,
  projectEntity,
  projectState,
  stableStringify,
  stampCells,
  viewerSceneId,
  visibleAssetIds,
  type ProjectedActor,
  type ProjectedState,
} from "./project.ts";
import { stairMarkAt } from "./heightCodec.ts";
import { autoWallBetween, paintedOf } from "./rules/autoWalls.ts";
import { decodeTile, encodeTile, isCellFullyFogged, isTokenFullyFogged, labelCells } from "./rules/fog.ts";
import { footprintRect } from "./rules/footprint.ts";
import { compareEntries } from "./rules/initiative.ts";
import { applyOp } from "./reducer.ts";
import { visionRules, type PartySight, type VisionRules } from "./ruleHooks.ts";
import { derivedId } from "./reducer/duplicate.ts";
import { DM, P1, P2, actor, apply, chance, character, companionBlock, customMonster, member, deepClone, drawing, entry, env, imageRef, randomState, reveal, rng, room, srdImage, template, token } from "./testutil.ts";
import { imageAssetId } from "./imageRef.ts";

/** A table display's viewer: a player who owns nothing (docs/design-v1-dm-tools.md 3.1). */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };

/** Every object nested anywhere in a value, for "this key never appears" checks. */
function* walk(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) for (const v of value) yield* walk(v);
  else if (value && typeof value === "object") {
    yield value as Record<string, unknown>;
    for (const v of Object.values(value)) yield* walk(v);
  }
}

/** The HP holder of a token the way the projection sees it: its character when it points at one. */
function holderOf(state: RoomState, t: Token | undefined): { token?: Token; character?: RoomState["characters"][string] } {
  if (!t) return {};
  const character = "ref" in t.actor ? state.characters[t.actor.ref] : undefined;
  return character ? { token: t, character } : { token: t };
}

function ownsToken(state: RoomState, viewer: Viewer, t: Token): boolean {
  if (t.ownerIds.includes(viewer.memberId)) return true;
  return "ref" in t.actor && (state.characters[t.actor.ref]?.ownerIds.includes(viewer.memberId) ?? false);
}

/**
 * Behind a blackout a player holds none of the table: no scene or anything
 * on one, no initiative, no handouts, and no log line about any of them.
 */
function assertPaused(p: ProjectedState, label: string): void {
  for (const [name, scoped] of Object.entries({
    scenes: p.scenes,
    buildChunks: p.buildChunks,
    labels: p.labels,
    fogTiles: p.fogTiles,
    fogDrafts: p.fogDrafts,
    tokens: p.tokens,
    templates: p.templates,
    drawings: p.drawings,
    handouts: p.handouts,
  })) {
    assert.deepEqual(scoped, {}, `${label}: ${name} behind a blackout`);
  }
  assert.equal(p.encounter, null, `${label}: initiative behind a blackout`);
  for (const e of p.log) {
    const data = e.data;
    if (!data) continue;
    assert.ok(!("tokenId" in data && data.tokenId !== undefined), `${label}: a log line about a token behind a blackout`);
    assert.ok(!["turn", "handout", "encounter"].includes(data.type), `${label}: a ${data.type} log line behind a blackout`);
  }
}

/**
 * A player gets a creature's path only for the turn under way, of a row
 * they see, without the marks of who could see each stop. A player who
 * does not own it gets only the stops they saw, and a leg's uncounted mark
 * only when they saw both its ends.
 */
function assertPathKept(state: RoomState, p: ProjectedState, id: string, owned: boolean, label: string): void {
  const path = p.tokens[id]!.path!;
  const stored = state.tokens[id]!.path!;
  const start = state.encounter?.turnStart;
  assert.ok(start?.seq !== undefined && stored.turn === start.seq && start.tokenId === id && start.entryId === state.encounter!.activeEntryId, `${label}: a path of another turn of ${id} leaked`);
  assert.equal(p.encounter?.activeEntryId, start.entryId, `${label}: the path of ${id}, whose row is unseen, leaked`);
  for (const stop of path.stops) assert.ok(!("seen" in stop), `${label}: the seen mark of a stop of ${id} leaked`);
  const kept = stored.stops.flatMap((stop, i) => (owned || stop.seen ? [{ stop, i }] : []));
  assert.equal(path.stops.length, kept.length, `${label}: stops of ${id} players could not see leaked`);
  for (const [k, stop] of path.stops.entries()) {
    const { stop: was, i } = kept[k]!;
    assert.deepEqual([stop.x, stop.y, stop.elevation], [was.x, was.y, was.elevation], `${label}: stop ${k} of ${id}`);
    assert.ok(!("joinedUnseen" in stop), `${label}: the joined mark of a stop of ${id} leaked`);
    if (stop.uncounted) assert.ok(was.uncounted && (owned || (i > 0 && stored.stops[i - 1]!.seen && !was.joinedUnseen)), `${label}: how ${id} moved unseen leaked`);
  }
}

/**
 * A Ready action's trigger reaches players who do not own the creature only
 * when a player, not a DM, owns it or a token of its character, or the DM
 * shows it.
 */
function assertTriggersKept(stored: readonly Effect[], projected: readonly Effect[], playerOwned: boolean, label: string): void {
  for (const e of projected) {
    if (e.key !== "readied" || e.label === undefined) continue;
    const was = stored.find((s) => s.id === e.id);
    assert.ok(playerOwned || was?.triggerShown === true, `${label}: the trigger of ${e.id} leaked`);
  }
}

/** Whether a member who is a player, not a DM, is among these owners. */
function playersAmong(state: RoomState, ids: readonly string[]): boolean {
  return ids.some((id) => state.members[id]?.kind === "player");
}

/**
 * The fog players get, written here independently of the projection: each
 * tile either layer holds, the DM's and the party's explored layer joined
 * (docs/design-v1-maps-vision.md 4.3.3).
 */
function mergedFog(state: RoomState): Record<string, FogTile> {
  const out: Record<string, FogTile> = {};
  for (const key of new Set([...Object.keys(state.fogTiles), ...Object.keys(state.exploredTiles)])) {
    const a = state.fogTiles[key];
    const b = state.exploredTiles[key];
    const bits = new Uint8Array(512);
    for (const t of [a, b]) {
      const d = t ? decodeTile(t.bits) : null;
      if (d) for (let i = 0; i < bits.length; i++) bits[i] = bits[i]! | d[i]!;
    }
    out[key] = { ...(a ?? b)!, bits: encodeTile(bits) };
  }
  return out;
}

/** The design 18 leak list, checked against one player projection of one state. */
function assertNoLeaks(state: RoomState, viewer: Viewer, p: ProjectedState, label: string): void {
  if (state.meta.view.blackout) assertPaused(p, label);
  const sceneId = state.meta.view.blackout ? null : state.meta.playerSceneId!;
  assert.deepEqual(Object.keys(p.scenes), sceneId === null ? [] : [sceneId], `${label}: scenes`);
  // The viewer's own characters' companion blocks are theirs to read (docs/design-v1-companion-stat-blocks.md 4.2), and only those.
  const { companionBlocks: ownBlocks, ...rest } = p;
  for (const obj of walk(rest)) {
    assert.ok(!("dmNotes" in obj), `${label}: dmNotes leaked`);
    assert.ok(!("groupKey" in obj), `${label}: groupKey leaked`);
    assert.ok(!("hiddenFromPlayers" in obj), `${label}: a hidden effect leaked`);
    assert.ok(!("abilities" in obj) && !("legendaryActions" in obj), `${label}: a custom stat block leaked`);
  }
  for (const [id, block] of Object.entries(ownBlocks)) {
    assert.ok(state.characters[block.characterId]?.ownerIds.includes(viewer.memberId), `${label}: companion block ${id} of another's character leaked`);
    assert.equal(block.rev, 0, `${label}: rev of companion block ${id}`);
  }
  for (const block of Object.values(state.companionBlocks)) {
    const owned = state.characters[block.characterId]?.ownerIds.includes(viewer.memberId) === true;
    assert.equal(block.id in ownBlocks, owned, `${label}: companion block ${block.id}`);
  }
  assert.deepEqual(p.encounterHistory, [], `${label}: history`);
  assert.deepEqual(p.monsters, {}, `${label}: custom monsters`);
  for (const m of Object.values(state.monsters)) {
    assert.ok(!JSON.stringify(p).includes(m.traits[0]?.text ?? m.id), `${label}: custom monster ${m.id} text leaked`);
  }
  // Which image the DM chose for a monster is DM metadata. Random rooms never put these images on a token.
  assert.deepEqual(p.srdImages, {}, `${label}: SRD monster images`);
  // A fight the DM built ahead says what is coming.
  assert.deepEqual(p.savedEncounters, {}, `${label}: saved encounters`);
  for (const e of Object.values(state.savedEncounters)) assert.ok(!JSON.stringify(p).includes(e.name), `${label}: saved encounter ${e.id} leaked`);
  const visible = visibleAssetIds(state, viewer, { sceneId: "s2" });
  const othersBlocks = Object.values(state.companionBlocks).filter((b) => !state.characters[b.characterId]?.ownerIds.includes(viewer.memberId));
  const chosen = [
    ...Object.values(state.monsters).flatMap((m) => (m.defaultImage ? [imageAssetId(m.defaultImage)!] : [])),
    ...Object.values(state.srdImages).map((e) => imageAssetId(e.image)!),
    ...othersBlocks.flatMap((b) => (b.defaultImage ? [imageAssetId(b.defaultImage)!] : [])),
  ];
  for (const assetId of chosen) {
    assert.ok(!JSON.stringify(p).includes(assetId), `${label}: monster image ${assetId} leaked`);
    assert.ok(!visible.has(assetId), `${label}: monster image ${assetId} readable`);
  }
  for (const t of Object.values(state.tokens)) {
    if (ownsToken(state, viewer, t)) continue;
    for (const image of t.altImages ?? []) {
      assert.ok(!JSON.stringify(p).includes(imageAssetId(image)!), `${label}: other image ${imageAssetId(image)} of ${t.id} leaked`);
      assert.ok(!visible.has(imageAssetId(image)!), `${label}: other image ${imageAssetId(image)} of ${t.id} readable`);
    }
  }
  assert.deepEqual(p.fogDrafts, {}, `${label}: fog draft`);
  for (const scoped of [p.tokens, p.templates, p.drawings, p.labels, p.fogTiles, p.buildChunks]) {
    for (const e of Object.values(scoped)) assert.equal(e.sceneId, sceneId, `${label}: another scene leaked`);
  }
  const fog = mergedFog(state);
  // Players never get the explored layer itself, only merged into their fog, and the DM's teleport notes never.
  assert.deepEqual(p.exploredTiles, {}, `${label}: explored layer`);
  for (const [key, tile] of Object.entries(p.fogTiles)) assert.equal(decodeTile(tile.bits)?.join(), decodeTile(fog[key]!.bits)?.join(), `${label}: fog tile ${key} is not the layers merged`);
  for (const e of p.log) assert.notEqual(e.data?.type, "teleport", `${label}: a teleport line leaked`);
  for (const e of p.log) assert.notEqual(e.data?.type, "companion", `${label}: a companion line leaked`);
  for (const e of p.log) assert.notEqual(e.data?.type, "characterDeleted", `${label}: a deleted character's line leaked`);
  const vision = sceneId !== null && state.scenes[sceneId]!.vision?.on === true;
  for (const key of Object.keys(p.sight)) assert.ok(vision && key.startsWith(`${sceneId}:`), `${label}: sight tile ${key} leaked`);
  for (const [id, pt] of Object.entries(p.tokens)) {
    const t = state.tokens[id]!;
    const owned = ownsToken(state, viewer, t);
    assert.ok(t.visibility === "all" || owned, `${label}: hidden token ${id} leaked`);
    // Spelled out rather than read from rules/fog.ts, so the oracle stands apart from the code: a party member or the DM's
    // exemption, never a creature revealed on its turn (`fogExemptAuto`), which follows the fog and sight (decided 2026-10-14).
    const member = isPartyMember(state, t) || t.fogExempt;
    const fogged = sceneId !== null && !vision && state.scenes[sceneId]!.fogEnabled && !member && isTokenFullyFogged(fog, sceneId, t);
    assert.ok(!fogged, `${label}: token ${id} under fog leaked`);
    // On a vision scene a creature reaches players only in the party's sight, unless a party member or exempt.
    if (vision && !member) assert.ok(partySightOf(state, sceneId).seesToken(t), `${label}: token ${id} out of the party's sight leaked`);
    assert.equal(pt.aboveFog, member, `${label}: aboveFog of ${id}`);
    assert.ok(!("partyVision" in pt), `${label}: party membership of ${id} leaked`);
    assert.equal(pt.rev, 0, `${label}: rev of ${id}`);
    if (!owned) {
      for (const field of ["ownerIds", "fogExempt", "fogExemptAuto", "nameHidden", "publicName", "visibility", "hpVisibility", "altImages", "light"]) {
        assert.ok(!(field in pt), `${label}: ${field} of ${id} leaked`);
      }
      // A companion is the table's only while a player plays it (docs/design-v1-combat-flow.md 3.6.5).
      assert.equal("companion" in pt, t.companion !== undefined && playersToken(state, t), `${label}: companion of ${id}`);
      if (t.companion && t.kind === "object" && "inline" in pt.actor) assert.equal(pt.actor.inline.life, "alive", `${label}: an effect companion's life of ${id}`);
      if (t.nameHidden) {
        assert.equal(pt.name, t.publicName ?? "Unknown creature", `${label}: hidden name of ${id} leaked`);
        assert.ok(!("number" in pt), `${label}: number of ${id} with a hidden name leaked`);
      }
      if ("inline" in pt.actor) {
        const a = pt.actor.inline;
        const access = hpAccess(state, viewer, holderOf(state, t));
        assert.equal("hp" in a, access === "exact", `${label}: hp numbers of ${id}`);
        assert.equal("hpBar" in a, access === "bar", `${label}: hp bar of ${id}`);
        assert.equal("hpLabel" in a, access === "label", `${label}: hp label of ${id}`);
        assert.ok(!("ac" in a) && !("notes" in a), `${label}: stats of ${id} leaked`);
        assert.ok(!("blockId" in a) && !("srdId" in a), `${label}: the stat block link of ${id} leaked`);
        if ("inline" in t.actor) assertTriggersKept(t.actor.inline.effects, a.effects, playersAmong(state, t.ownerIds), `${label}: token ${id}`);
      }
    }
    if (pt.path) assertPathKept(state, p, id, owned, label);
  }
  for (const [id, pc] of Object.entries(p.characters)) {
    const c = state.characters[id]!;
    assert.equal(pc.rev, 0, `${label}: rev of character ${id}`);
    if (!c.ownerIds.includes(viewer.memberId)) {
      assert.ok(!("ownerIds" in pc) && !("ac" in pc.actor), `${label}: character ${id} stats leaked`);
      assert.ok(!("level" in pc), `${label}: character ${id} level leaked`);
      const exact = state.meta.settings.pcHpVisibleToParty;
      assert.equal("hp" in pc.actor, exact, `${label}: character ${id} hp`);
      assert.equal("hpLabel" in pc.actor, !exact, `${label}: character ${id} label`);
      const played = playersAmong(state, c.ownerIds) || Object.values(state.tokens).some((t) => "ref" in t.actor && t.actor.ref === id && playersAmong(state, t.ownerIds));
      assertTriggersKept(c.actor.effects, pc.actor.effects, played, `${label}: character ${id}`);
    }
  }
  for (const [id, pa] of Object.entries(p.templates)) {
    const a = state.templates[id]!;
    assert.equal(a.visibility, "all", `${label}: hidden template ${id} leaked`);
    if (a.attachedTo !== undefined) assert.ok(p.tokens[a.attachedTo], `${label}: template ${id} attached to an unseen token`);
    if (a.casterId !== undefined) assert.ok(pa.casterId === null || p.tokens[a.casterId], `${label}: template ${id} caster leaked`);
    if (a.ownerId !== viewer.memberId && !state.meta.settings.playersSeeAoeOfOthers) {
      assert.equal(state.members[a.ownerId]?.kind, "dm", `${label}: another player's template ${id} leaked`);
    }
  }
  for (const d of Object.values(p.drawings)) {
    assert.equal(d.visibility, "all", `${label}: DM drawing leaked`);
    for (const [i, id] of (d.anchors ?? []).entries()) {
      if (id === null) continue;
      const seen = p.tokens[id];
      assert.ok(seen, `${label}: kept ruler ${d.id} on an unseen token leaked`);
      const r = footprintRect(seen);
      assert.deepEqual([d.points[2 * i], d.points[2 * i + 1]], [r.x + r.w / 2, r.y + r.h / 2], `${label}: kept ruler ${d.id} stop ${i} is not where ${id} stands now`);
    }
  }
  if (sceneId !== null && state.scenes[sceneId]!.fogEnabled) {
    for (const l of Object.values(p.labels)) {
      const r = labelCells(l);
      let lit = false;
      for (let y = r.y0; y < r.y1 && !lit; y++) for (let x = r.x0; x < r.x1 && !lit; x++) lit = !isCellFullyFogged(fog, sceneId, { x, y });
      assert.ok(lit, `${label}: label ${l.id} under fog leaked`);
    }
  }
  for (const c of Object.values(p.buildChunks)) {
    for (const e of Object.values(c.edges)) assert.ok(!(e.kind === "door" && e.secret && !e.discovered), `${label}: secret door leaked`);
    for (const e of Object.values(c.edges)) assert.ok(!(e.kind === "door" && e.state === "locked"), `${label}: a lock leaked`);
    for (const w of c.walls ?? []) {
      assert.ok(!(w.f.kind === "door" && ((w.f.secret && !w.f.discovered) || w.f.state === "locked")), `${label}: a secret or locked free door leaked`);
    }
    const order = (c.walls ?? []).map((w) => [...w.a, ...w.b]);
    const sorted = [...order].sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]! || x[3]! - y[3]!);
    assert.deepEqual(order, sorted, `${label}: free walls of ${c.cx},${c.cy} in stored order`);
  }
  // A hidden secret door shows players a gap only where the scene's rule puts an automatic wall (design-v1-maps-vision 2.1).
  if (sceneId !== null) {
    const rule = state.scenes[sceneId]!.autoWalls ?? "all";
    // A stair mark makes a cell a Stairs overlay whatever its terrain (wave 4).
    const painted = (x: number, y: number) =>
      x >= 0 && y >= 0 && stairMarkAt(state.buildChunks, sceneId, x, y) !== "." ? "overlay" : paintedOf(x < 0 || y < 0 ? undefined : state.buildChunks[`${sceneId}:${Math.floor(x / 16)},${Math.floor(y / 16)}`]?.cells[`${x},${y}`]);
    for (const c of Object.values(state.buildChunks)) {
      if (c.sceneId !== sceneId) continue;
      for (const [key, e] of Object.entries(c.edges)) {
        if (!(e.kind === "door" && e.secret && !e.discovered)) continue;
        const [xs, ys, side] = key.split(",");
        const x = Number(xs);
        const y = Number(ys);
        const automatic = autoWallBetween(rule, painted(x, y), side === "n" ? painted(x, y - 1) : painted(x - 1, y));
        const shown: unknown = p.buildChunks[`${sceneId}:${c.cx},${c.cy}`]?.edges[key];
        assert.deepEqual(shown, automatic ? undefined : { kind: "wall" }, `${label}: hidden door ${key} under "${rule}"`);
      }
    }
  }
  // Scenes: an allowlist, without the DM's folder, thumbnail and phases, whose other images and names are not in the data.
  for (const sc of Object.values(p.scenes)) {
    for (const field of ["folder", "thumb", "phases", "phaseId", "phaseGrid"]) assert.ok(!(field in sc), `${label}: scene ${field} leaked`);
    assert.equal(sc.rev, 0, `${label}: scene rev`);
    assert.equal(sc.order, 0, `${label}: scene order`);
    assert.equal(sc.wallsVersion, 0, `${label}: scene walls version`);
  }
  const text = JSON.stringify(p);
  // A copy shares its original's images, so a phase of one scene can be the map players see on another.
  const shownMaps = new Set(Object.values(p.scenes).flatMap((sc) => (sc.map ? [sc.map.assetId] : [])));
  for (const sc of Object.values(state.scenes)) {
    if (sc.thumb) {
      assert.ok(!text.includes(sc.thumb), `${label}: thumbnail ${sc.thumb} leaked`);
      assert.ok(!visible.has(sc.thumb), `${label}: thumbnail ${sc.thumb} readable`);
    }
    for (const phase of sc.phases ?? []) {
      assert.ok(!text.includes(phase.name), `${label}: phase name ${phase.name} leaked`);
      if (!shownMaps.has(phase.assetId)) {
        assert.ok(!text.includes(phase.assetId), `${label}: phase image ${phase.assetId} leaked`);
        assert.ok(!visible.has(phase.assetId), `${label}: phase image ${phase.assetId} readable`);
      }
    }
    if (sc.folder) assert.ok(!text.includes(sc.folder), `${label}: folder leaked`);
  }
  // Lights are the DM's in every wave. Stamps follow the labels' rule, and their images go with them.
  assert.deepEqual(p.lights, {}, `${label}: lights`);
  for (const l of Object.values(state.lights)) assert.ok(!text.includes(l.id), `${label}: light ${l.id} leaked`);
  // A copied stamp wears its original's image, so an image is readable while any stamp wearing it is shown.
  const shownArt = new Set(Object.values(p.stamps).flatMap((st) => ("assetId" in st.art ? [st.art.assetId] : [])));
  for (const st of Object.values(state.stamps)) {
    const shown = p.stamps[st.id];
    if ("assetId" in st.art) assert.equal(visible.has(st.art.assetId), shownArt.has(st.art.assetId), `${label}: stamp image ${st.art.assetId} readable while its stamps are ${shown ? "shown" : "withheld"}`);
    if (!shown) continue;
    assert.equal(st.sceneId, sceneId, `${label}: stamp ${st.id} of another scene leaked`);
    assert.equal(st.visibility, "all", `${label}: DM stamp ${st.id} leaked`);
    if (state.scenes[st.sceneId]!.fogEnabled) {
      const r = stampCells(st);
      let lit = false;
      for (let y = r.y0; y < r.y1 && !lit; y++) for (let x = r.x0; x < r.x1 && !lit; x++) lit = !isCellFullyFogged(fog, st.sceneId, { x, y });
      assert.ok(lit, `${label}: stamp ${st.id} under fog leaked`);
    }
  }
  for (const h of Object.values(p.handouts)) assert.ok(h.to === "all" || h.to.includes(viewer.memberId), `${label}: handout leaked`);
  if (p.encounter) {
    for (const e of p.encounter.entries) {
      const full = state.encounter!.entries.find((x) => x.id === e.id)!;
      assert.ok(!full.hidden, `${label}: hidden entry leaked`);
      if (e.tokenId !== undefined) {
        assert.ok(p.tokens[e.tokenId], `${label}: entry for an unseen token leaked`);
        assert.ok(!("label" in e), `${label}: entry label leaked`);
      }
    }
    assert.ok(p.encounter.activeEntryId === null || p.encounter.entries.some((e) => e.id === p.encounter!.activeEntryId), `${label}: active entry`);
    // Numbered 0..n-1 over the rows the player sees, in the DM's turn order, so no gap hints at a hidden row.
    const turnOrder = [...state.encounter!.entries].sort(compareEntries).map((e) => e.id);
    assert.deepEqual(
      p.encounter.entries.map((e) => e.tieOrder),
      p.encounter.entries.map((_, i) => i),
      `${label}: tieOrder gaps leaked`,
    );
    assert.deepEqual(
      p.encounter.entries.map((e) => e.id),
      turnOrder.filter((id) => p.encounter!.entries.some((e) => e.id === id)),
      `${label}: turn order`,
    );
    // Where a turn began reaches a player only for a creature in their sight now, and then for one they could see there.
    const start = p.encounter.turnStart;
    if (start) {
      const stored = state.encounter!.turnStart!;
      const t = state.tokens[start.tokenId]!;
      assert.equal(start.entryId, p.encounter.activeEntryId, `${label}: the start of another row's turn leaked`);
      assert.ok(p.tokens[start.tokenId], `${label}: the turn start of an unseen token leaked`);
      assert.equal(start.sceneId, t.sceneId, `${label}: a turn start on another scene leaked`);
      assert.ok(stored.seen || ownsToken(state, viewer, t), `${label}: a turn start players could not see leaked`);
      assert.ok(!("seen" in start), `${label}: the seen mark leaked`);
    }
  }
  for (const e of p.log) {
    if (e.kind === "whisper") assert.ok(e.from === viewer.memberId || e.to?.includes(viewer.memberId), `${label}: whisper leaked`);
    const data = e.data;
    if (!data) continue;
    const stored = state.log.find((x) => x.id === e.id)?.data;
    assert.ok(!(stored && "hidden" in stored && stored.hidden), `${label}: log entry ${e.id} about a hidden effect leaked`);
    if (stored && "tokenId" in stored && stored.tokenId !== undefined && !("seen" in stored && stored.seen)) {
      const t = state.tokens[stored.tokenId];
      assert.ok(t && ownsToken(state, viewer, t), `${label}: log entry ${e.id} from while its creature was unseen leaked`);
    }
    // A roll line follows its creature's owners, wherever the creature stands (below).
    if ("tokenId" in data && data.tokenId !== undefined && data.type !== "roll") {
      assert.ok(p.tokens[data.tokenId], `${label}: log entry about an unseen token leaked`);
      if ((data.type === "hp" || data.type === "rest") && ("amount" in data || "left" in data)) {
        assert.equal(hpAccess(state, viewer, holderOf(state, state.tokens[data.tokenId])), "exact", `${label}: hp amount leaked`);
      }
      if (data.type === "concentration" && "dc" in data) {
        assert.equal(hpAccess(state, viewer, holderOf(state, state.tokens[data.tokenId])), "exact", `${label}: dc leaked`);
      }
      if (data.type === "deathSave" && ("ok" in data || "fail" in data)) {
        assert.equal(hpAccess(state, viewer, holderOf(state, state.tokens[data.tokenId])), "exact", `${label}: death save counts leaked`);
      }
    }
    if ("characterId" in data && data.characterId !== undefined) assert.ok(p.characters[data.characterId], `${label}: log about a missing character`);
    // What an HP change replaced, and which line a take-back names, are the DM's alone, owners included.
    if (data.type === "hp") assert.ok(!("revert" in data) && !("of" in data), `${label}: what HP line ${e.id} replaced leaked`);
    if (data.type === "turn") {
      const row = p.encounter?.entries.find((x) => x.id === data.entryId);
      assert.ok(row, `${label}: turn of an unseen entry leaked`);
      if (!data.seen) {
        const t = row.tokenId !== undefined ? state.tokens[row.tokenId] : undefined;
        const c = row.characterId !== undefined ? state.characters[row.characterId] : undefined;
        assert.ok((t && ownsToken(state, viewer, t)) || c?.ownerIds.includes(viewer.memberId), `${label}: turn ${e.id} from while its row was unseen leaked`);
      }
      assert.ok(!("toSeen" in data), `${label}: the mark on take-back ${e.id} leaked`);
      if (data.to !== undefined) {
        const stored = state.log.find((x) => x.id === e.id)?.data;
        const resumed = p.encounter?.entries.find((x) => x.id === data.to);
        const t = resumed?.tokenId !== undefined ? state.tokens[resumed.tokenId] : undefined;
        const c = resumed?.characterId !== undefined ? state.characters[resumed.characterId] : undefined;
        const owned = (t !== undefined && ownsToken(state, viewer, t)) || (c?.ownerIds.includes(viewer.memberId) ?? false);
        assert.ok(resumed && (owned || (stored?.type === "turn" && stored.toSeen)), `${label}: the row take-back ${e.id} resumed leaked`);
      }
    }
    if (data.type === "handout") assert.ok(p.handouts[data.handoutId], `${label}: handout log leaked`);
    // An area's reminder reaches a player only while the area is in their sight, and never one hidden when it happened.
    if (data.type === "area") assert.ok(p.templates[data.templateId], `${label}: reminder about an unseen area leaked`);
    // A roll line reaches the creature's players now, under the request's two switches (docs/design-v1-dm-tools.md 3.3).
    if (data.type === "roll") {
      const stored = state.log.find((x) => x.id === e.id)?.data as Extract<LogEvent, { type: "roll" }>;
      assert.ok(ownsCreature(state, viewer, data), `${label}: roll line ${e.id} about another's creature leaked`);
      if (!stored.dcShown) assert.ok(!("dc" in data), `${label}: hidden DC on roll line ${e.id} leaked`);
      if (!stored.resultShown) assert.ok(!("result" in data), `${label}: hidden result on roll line ${e.id} leaked`);
      // A DM's bare mark under hidden results: a result no player's answer could carry, a total's verdict from the DC or their own fail without rolling (LP5-ROLLS-4).
      if (!stored.resultShown && stored.result !== undefined) {
        const playerCould = stored.total !== undefined ? stored.dc !== undefined && stored.result === (stored.total >= stored.dc ? "pass" : "fail") : stored.noRoll === true && stored.result === "fail";
        assert.ok(playerCould, `${label}: the DM's mark on roll line ${e.id} leaked`);
      }
      assert.equal(data.noRoll === true, stored.noRoll === true, `${label}: no-roll mark on roll line ${e.id}`);
    }
  }
  assertNoWave5Leaks(state, viewer, p, label);
}

/** Whether the viewer owns a roll target's or a roll line's creature now. */
function ownsCreature(state: RoomState, viewer: Viewer, ref: { tokenId?: string; characterId?: string }): boolean {
  if (ref.tokenId !== undefined) {
    const t = state.tokens[ref.tokenId];
    return t !== undefined && ownsToken(state, viewer, t);
  }
  return ref.characterId !== undefined && (state.characters[ref.characterId]?.ownerIds.includes(viewer.memberId) ?? false);
}

/**
 * Wave 5's state (docs/design-v1-dm-tools.md 2.1): no DM-only page, no page
 * private to another player, no unrevealed secret block or a revealed one's
 * flag, no pin on a page the player cannot read or under the fog, no other
 * player's roll target, hidden DC or hidden result, no `monsterId`, and the
 * `party` flag exactly where a player owns the token.
 */
function assertNoWave5Leaks(state: RoomState, viewer: Viewer, p: ProjectedState, label: string): void {
  const text = JSON.stringify(p);
  const sceneId = viewerSceneId(state, viewer, { sceneId: "s2" });
  for (const page of Object.values(p.journal)) {
    const stored = state.journal[page.id]!;
    assert.ok(pageReadableBy(stored, viewer.memberId), `${label}: page ${page.id} for others leaked`);
    assert.equal(page.rev, 0, `${label}: page ${page.id} rev`);
    for (const block of page.blocks) assert.ok(!("secret" in block), `${label}: the secret flag of a block of ${page.id} leaked`);
  }
  for (const stored of Object.values(state.journal)) {
    for (const block of stored.blocks) if (block.secret && !block.secret.revealed) assert.ok(!text.includes(block.text), `${label}: hidden block ${block.id} of ${stored.id} leaked`);
  }
  const fog = mergedFog(state);
  for (const pin of Object.values(p.pins)) {
    assert.equal(pin.sceneId, sceneId, `${label}: pin ${pin.id} of another scene leaked`);
    assert.equal(pin.visibility, "all", `${label}: DM pin ${pin.id} leaked`);
    if (pin.pageId !== undefined) assert.ok(p.journal[pin.pageId], `${label}: pin ${pin.id} on a page the player cannot read leaked`);
    if (state.scenes[pin.sceneId]!.fogEnabled) {
      const r = pinCells(pin);
      assert.ok(!isCellFullyFogged(fog, pin.sceneId, { x: r.x0, y: r.y0 }), `${label}: pin ${pin.id} under fog leaked`);
    }
  }
  for (const request of Object.values(p.rolls)) {
    const stored = state.rolls[request.id]!;
    assert.equal(request.rev, 0, `${label}: roll ${request.id} rev`);
    if (!stored.dcShown) assert.ok(!("dc" in request), `${label}: hidden DC of ${request.id} leaked`);
    assert.equal(request.dcHidden === true, stored.dc !== undefined && !stored.dcShown, `${label}: dcHidden of ${request.id}`);
    for (const t of request.targets) {
      assert.ok(ownsCreature(state, viewer, t), `${label}: another's target in ${request.id} leaked`);
      assert.ok(!("by" in t) && !("previous" in t), `${label}: who answered ${request.id}, or what it replaced, leaked`);
      if (!stored.resultShown) assert.ok(!("result" in t), `${label}: hidden result in ${request.id} leaked`);
      // A player's own fail without rolling reaches them as a total does, and nothing else reads as one.
      const own = stored.targets.find((s) => (t.tokenId !== undefined ? s.tokenId === t.tokenId : s.characterId === t.characterId))!;
      assert.equal(t.noRoll === true, own.noRoll === true, `${label}: no-roll mark of ${request.id}`);
    }
  }
  assert.ok(!text.includes('"monsterId"'), `${label}: a room monster link leaked`);
  for (const [id, t] of Object.entries(p.tokens)) assert.equal(t.party === true, playersToken(state, state.tokens[id]!), `${label}: party flag of ${id}`);
}

describe("projection properties over random rooms", () => {
  test("no player projection leaks, and projectEntity agrees with projectState", () => {
    for (let seed = 1; seed <= 250; seed++) {
      const state = randomState(rng(seed));
      // A table display is a player who owns nothing (docs/design-v1-dm-tools.md 3.1), whose projection no ownership widens.
      assert.equal(stableStringify(projectState(state, DISPLAY, { sceneId: "s2" })), stableStringify(projectState(state, { memberId: "p-nobody", role: "player" }, { sceneId: "s2" })), `seed ${seed} display`);
      for (const viewer of [P1, P2, DISPLAY]) {
        const p = projectState(state, viewer, { sceneId: "s2" });
        assertNoLeaks(state, viewer, p, `seed ${seed} ${viewer.memberId}`);
        for (const key of allKeys(state)) {
          const single = projectEntity(key, state, viewer, { sceneId: "s2" });
          const inState = readEntity(p as unknown as RoomState, key);
          if (key === keys.encounterHistory) {
            assert.equal(single, null);
            continue;
          }
          assert.equal(stableStringify(single), stableStringify(inState), `seed ${seed} ${viewer.memberId} ${key}`);
        }
      }
      for (const sceneId of ["s1", "s2"]) {
        const p = projectState(state, DM, { sceneId });
        for (const [id, t] of Object.entries(state.tokens)) {
          assert.equal(p.tokens[id], t.sceneId === sceneId ? t : undefined, `seed ${seed} dm token ${id}`);
        }
        assert.equal(p.encounter, state.encounter);
        assert.equal(Object.keys(p.scenes).length, 2);
        assert.equal(Object.keys(p.fogDrafts).length, state.fogDrafts[sceneId] ? 1 : 0);
        // Room-level, so the same whatever scene the DM views.
        assert.deepEqual(p.monsters, state.monsters);
        assert.deepEqual(p.srdImages, state.srdImages);
        assert.deepEqual(p.savedEncounters, state.savedEncounters);
        // Stamps and lights of the scene in view, as stored.
        for (const [id, st] of Object.entries(state.stamps)) assert.equal(p.stamps[id], st.sceneId === sceneId ? st : undefined, `seed ${seed} dm stamp ${id}`);
        for (const [id, l] of Object.entries(state.lights)) assert.equal(p.lights[id], l.sceneId === sceneId ? l : undefined, `seed ${seed} dm light ${id}`);
        assert.equal(p.log.filter((e) => e.kind === "whisper").length, state.log.filter((e) => e.kind === "whisper" && (e.from === "dm1" || e.to?.includes("dm1"))).length);
        for (const key of allKeys(state)) {
          const single = projectEntity(key, state, DM, { sceneId });
          const inState = readEntity(p as unknown as RoomState, key);
          if (key === keys.encounterHistory) {
            assert.equal(single, state.encounterHistory.length === 0 ? null : state.encounterHistory);
            continue;
          }
          assert.equal(single, inState === null ? null : inState, `seed ${seed} dm ${key}`);
        }
      }
    }
  });
});

describe("projection properties over random rooms with a party that sees", () => {
  /*
   * Sight itself is part 4C's. A stand-in party that sees the creatures in
   * the scene's west half puts creatures on both sides of the line, so the
   * vision rule is checked on rooms where it matters.
   */
  const fake: VisionRules = {
    partySight: (): PartySight => ({ seesToken: (t) => t.x < 15, tiles: new Map([["1,0", { f: 1 }]]) }),
    sightFromTiles: () => ({ seesToken: () => false, tiles: new Map() }),
  };

  test("no player projection holds a creature out of the party's sight, and projectEntity agrees with projectState", () => {
    const real = { ...visionRules };
    Object.assign(visionRules, fake);
    try {
      let checked = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const state = randomState(rng(seed));
        for (const viewer of [P1, P2]) {
          const p = projectState(state, viewer, { sceneId: "s2" });
          assertNoLeaks(state, viewer, p, `seed ${seed} ${viewer.memberId}`);
          if (state.scenes[state.meta.playerSceneId!]?.vision?.on && !state.meta.view.blackout) checked++;
          for (const key of allKeys(state)) {
            if (key === keys.encounterHistory) continue;
            assert.equal(stableStringify(projectEntity(key, state, viewer, { sceneId: "s2" })), stableStringify(readEntity(p as unknown as RoomState, key)), `seed ${seed} ${viewer.memberId} ${key}`);
          }
        }
      }
      assert.ok(checked > 50, `only ${checked} projections of a vision scene were checked`);
    } finally {
      Object.assign(visionRules, real);
    }
  });
});

describe("duplicates over random rooms", () => {
  test("a copy shows players no kept drawing the original keeps from them, and every ruler stop where the original shows it", () => {
    let compared = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 7919);
      const state = randomState(rng(seed));
      for (const sceneId of ["s1", "s2"]) {
        const include = { creatures: chance(r, 0.5), characters: chance(r, 0.5), fog: chance(r, 0.5), drawings: true };
        const result = applyOp(state, { t: "scene.duplicate", sceneId, newSceneId: "copy", name: "Copy", include }, DM, env(1));
        assert.ok(result.ok, `seed ${seed} ${sceneId}: ${result.ok ? "" : result.message}`);
        // Each made the player scene in turn, so a player's projection is what players would get there.
        const original: RoomState = { ...state, meta: { ...state.meta, playerSceneId: sceneId } };
        const copy: RoomState = { ...result.state, meta: { ...result.state.meta, playerSceneId: "copy" } };
        const sources = new Map(Object.keys(state.drawings).map((id) => [derivedId("copy", id), id]));
        for (const viewer of [P1, P2]) {
          const label = `seed ${seed} ${sceneId} ${viewer.memberId}`;
          const before = projectState(original, viewer, { sceneId }).drawings;
          const after = projectState(copy, viewer, { sceneId: "copy" });
          assertNoLeaks(copy, viewer, after, `${label} copy`);
          for (const [id, d] of Object.entries(after.drawings)) {
            const source = sources.get(id)!;
            const shown = before[source];
            assert.ok(shown, `${label}: the copy of ${source} reached a player the original keeps it from`);
            assert.deepEqual(d.points, shown.points, `${label}: the copy of ${source} shows its stops elsewhere`);
            compared++;
          }
        }
      }
    }
    assert.ok(compared > 100, `only ${compared} copied drawings were compared`);
  });
});

describe("specific rules", () => {
  function setup() {
    const state = room();
    state.scenes.s1!.fogEnabled = true;
    state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ hp: { cur: 7, max: 20, temp: 0 } }) });
    state.tokens.pc1 = token("pc1", { kind: "pc", actor: { ref: "c1" }, x: 1, y: 1 });
    state.tokens.gob = token("gob", { x: 2, y: 2, hpVisibility: "bar", nameHidden: true, actor: { inline: actor({ hp: { cur: 7, max: 20, temp: 0 } }) } });
    state.tokens.dark = token("dark", { x: 30, y: 30 });
    state.tokens.exempt = token("exempt", { x: 31, y: 30, fogExempt: true });
    state.tokens.auto = token("auto", { x: 32, y: 30, fogExemptAuto: true });
    state.tokens.owned = token("owned", { x: 33, y: 30, ownerIds: ["p2"] });
    reveal(state, "s1", { x: 0, y: 0, w: 6, h: 6 });
    return state;
  }

  test("tokens under fog are withheld only when fog is enabled, and aboveFog follows the one rule", () => {
    const state = setup();
    let p = projectState(state, P1, { sceneId: "s1" });
    // A creature revealed on its turn (`auto`) is withheld under the fog like any other (decided 2026-10-14).
    assert.deepEqual(Object.keys(p.tokens).sort(), ["exempt", "gob", "owned", "pc1"]);
    assert.equal(p.tokens.gob!.aboveFog, false);
    assert.equal(p.tokens.exempt!.aboveFog, true);
    assert.equal(p.tokens.owned!.aboveFog, true);
    assert.equal(p.tokens.pc1!.aboveFog, true);
    state.tokens.auto = { ...state.tokens.auto!, x: 3, y: 3 };
    assert.equal(projectState(state, P1, { sceneId: "s1" }).tokens.auto?.aboveFog, false, "on revealed ground it shows, below the fog");
    state.scenes.s1!.fogEnabled = false;
    p = projectState(state, P1, { sceneId: "s1" });
    assert.ok(p.tokens.dark);
    assert.equal(p.tokens.dark!.aboveFog, false);
    const dm = projectState(state, DM, { sceneId: "s1" });
    assert.equal(dm.tokens.dark, state.tokens.dark);
  });

  test("a creature revealed on its turn in the fog reaches players only once it walks onto revealed ground, with nothing of where it was", () => {
    let state = setup();
    state.tokens.lurker = token("lurker", { name: "Lurker", x: 20, y: 20, visibility: "dm" });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "lurker", value: 10 }] });
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "encounter.next" }, DM, 3);
    assert.deepEqual([state.tokens.lurker!.visibility, state.tokens.lurker!.fogExemptAuto], ["all", true], "revealed");
    const turnLine = (p: ProjectedState) => p.log.some((e) => e.data?.type === "turn" && e.data.entryId === "n2");
    let p = projectState(state, P1, { sceneId: "s1" });
    assert.equal(p.tokens.lurker, undefined, "withheld in the fog");
    assert.deepEqual(p.encounter!.entries.map((e) => e.id), ["n1"], "its row too");
    assert.equal(p.encounter!.activeEntryId, null, "so the turn is another creature's");
    assert.equal(p.encounter!.started, true);
    assert.equal(turnLine(p), false);
    state = apply(state, { t: "token.move", tokenId: "lurker", x: 18, y: 20 }, DM, 4);
    assert.equal(projectState(state, P1, { sceneId: "s1" }).tokens.lurker, undefined, "still in the fog");
    state = apply(state, { t: "token.move", tokenId: "lurker", x: 4, y: 4 }, DM, 5);
    p = projectState(state, P1, { sceneId: "s1" });
    assert.equal(p.tokens.lurker?.aboveFog, false, "shown on revealed ground, below the fog");
    assert.equal(p.encounter!.activeEntryId, "n2");
    assert.equal(p.encounter!.turnStart, undefined, "not where its turn began in the fog");
    assert.deepEqual(p.tokens.lurker!.path?.stops, [{ x: 4, y: 4, elevation: 0 }], "only the stop players saw");
    assert.equal(turnLine(p), false, "nor the turn line nobody saw");
  });

  test("HP for non-owners: bar rounds to 1/20, label, hidden, exact, and the party setting for PCs", () => {
    const state = setup();
    const p = projectState(state, P2, { sceneId: "s1" });
    const gob = p.tokens.gob!.actor as { inline: ProjectedActor };
    assert.equal(gob.inline.hpBar, 0.35);
    assert.ok(!("hp" in gob.inline));
    assert.equal(p.tokens.gob!.name, "Unknown creature");
    state.tokens.gob!.number = 3;
    state.tokens.gob!.publicName = "Shadow";
    assert.ok(!("number" in projectState(state, P2, { sceneId: "s1" }).tokens.gob!), "a hidden name sends no number");
    assert.equal(projectState(state, DM, { sceneId: "s1" }).tokens.gob!.number, 3);
    state.tokens.gob!.nameHidden = false;
    assert.equal(projectState(state, P2, { sceneId: "s1" }).tokens.gob!.number, 3);
    state.tokens.gob!.nameHidden = true;
    delete state.tokens.gob!.number;
    delete state.tokens.gob!.publicName;
    assert.deepEqual(p.characters.c1!.actor.hp, { cur: 7, max: 20, temp: 0 });
    state.meta.settings.pcHpVisibleToParty = false;
    const party = projectState(state, P2, { sceneId: "s1" });
    assert.equal(party.characters.c1!.actor.hpLabel, "Bloodied");
    assert.ok(!("hp" in party.characters.c1!.actor));
    const owner = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(owner.characters.c1!.actor.hp, { cur: 7, max: 20, temp: 0 });
    assert.ok(!("dmNotes" in owner.characters.c1!.actor));
    state.tokens.gob!.hpVisibility = "label";
    assert.equal((projectState(state, P2, { sceneId: "s1" }).tokens.gob!.actor as { inline: ProjectedActor }).inline.hpLabel, "Bloodied");
    state.tokens.gob!.hpVisibility = "hidden";
    const hidden = (projectState(state, P2, { sceneId: "s1" }).tokens.gob!.actor as { inline: ProjectedActor }).inline;
    assert.ok(!("hp" in hidden) && !("hpLabel" in hidden) && !("hpBar" in hidden) && hidden.life === "alive");
    state.tokens.gob!.hpVisibility = "exact";
    assert.deepEqual((projectState(state, P2, { sceneId: "s1" }).tokens.gob!.actor as { inline: ProjectedActor }).inline.hp, { cur: 7, max: 20, temp: 0 });
  });

  test("a token's other images reach the DM and its owners, as data and as readable assets, and nobody else", () => {
    const state = setup();
    state.scenes.s1!.fogEnabled = false;
    const disguise = { assetId: "true-face", crop: { cx: 0, cy: 0, zoom: 1 } };
    state.tokens.gob!.image = { assetId: "merchant", crop: { cx: 0, cy: 0, zoom: 1 } };
    state.tokens.gob!.altImages = [disguise];
    state.tokens.owned!.altImages = [{ assetId: "wolf-form", crop: { cx: 0, cy: 0, zoom: 1 } }];
    const p1 = projectState(state, P1, { sceneId: "s1" });
    assert.equal("altImages" in p1.tokens.gob!, false);
    assert.equal("altImages" in p1.tokens.owned!, false);
    assert.ok(!visibleAssetIds(state, P1, { sceneId: "s1" }).has("true-face"));
    assert.ok(visibleAssetIds(state, P1, { sceneId: "s1" }).has("merchant"));
    const p2 = projectState(state, P2, { sceneId: "s1" });
    assert.deepEqual(p2.tokens.owned!.altImages, [{ assetId: "wolf-form", crop: { cx: 0, cy: 0, zoom: 1 } }]);
    assert.ok(visibleAssetIds(state, P2, { sceneId: "s1" }).has("wolf-form"));
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).tokens.gob!.altImages, [disguise]);
    assert.ok(visibleAssetIds(state, DM, { sceneId: "s2" }).has("true-face"), "the DM may use every token's images, on any scene");
  });

  test("a token's note for everyone reaches every player who sees it, and its note for the DM reaches none, owners included", () => {
    const state = setup();
    state.tokens.gob!.notes = "Wears a red cloak";
    state.tokens.owned!.notes = "Raging";
    state.tokens.owned!.actor = { inline: actor({ dmNotes: "will betray the party" }) };
    state.tokens.pc1!.notes = "Disguised as a guard";
    state.characters.c1!.actor.dmNotes = "the real duke";
    state.tokens.dark!.notes = "in the dark";
    for (const viewer of [P1, P2]) {
      const p = projectState(state, viewer, { sceneId: "s1" });
      assert.equal(p.tokens.gob!.notes, "Wears a red cloak");
      assert.equal(p.tokens.pc1!.notes, "Disguised as a guard");
      assert.equal(p.tokens.dark, undefined, "a note goes only with a token the player sees");
      const text = JSON.stringify(p);
      assert.ok(!text.includes("will betray") && !text.includes("the real duke") && !text.includes("secret plan"), `${viewer.memberId}: a note for the DM leaked`);
    }
    state.scenes.s1!.fogEnabled = false;
    const owner = projectState(state, P2, { sceneId: "s1" });
    assert.equal(owner.tokens.owned!.notes, "Raging");
    assert.ok(!JSON.stringify(owner).includes("will betray"));
    const dm = projectState(state, DM, { sceneId: "s1" });
    assert.equal((dm.tokens.owned!.actor as { inline: { dmNotes: string } }).inline.dmNotes, "will betray the party");
  });

  test("the encounter hides rows for hidden and unseen creatures and blanks the active row", () => {
    const state = setup();
    state.encounter = { rev: 0, round: 2, activeEntryId: "n2", entries: [entry("n1", { tokenId: "pc1", groupKey: "x" }), entry("n2", { tokenId: "dark", tieOrder: 1 }), entry("n3", { tokenId: "gob", hidden: true, tieOrder: 2 }), entry("n4", { label: "Lair", tieOrder: 3 })] };
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(p.encounter!.entries.map((e) => e.id), ["n1", "n4"]);
    assert.equal(p.encounter!.activeEntryId, null);
    assert.equal(p.encounter!.started, true, "a hidden row's turn is still a turn");
    assert.equal(p.encounter!.round, 2);
    state.encounter.activeEntryId = "n1";
    assert.equal(projectState(state, P1, { sceneId: "s1" }).encounter!.activeEntryId, "n1");
    assert.equal(projectState(state, P1, { sceneId: "s1" }).encounter!.started, true);
    state.encounter.activeEntryId = null;
    const before = projectState(state, P1, { sceneId: "s1" }).encounter!;
    assert.equal(before.activeEntryId, null);
    assert.equal(before.started, false, "before Start a player reads not started");
    assert.ok(!("started" in projectState(state, DM, { sceneId: "s1" }).encounter!), "the DM reads activeEntryId itself");
  });

  test("where a turn began reaches players only for a creature they could see there and see now", () => {
    let state = setup();
    state.tokens.hid = token("hid", { x: 4, y: 4, visibility: "dm" });
    state = apply(state, {
      t: "encounter.start",
      entries: [
        { id: "n1", tokenId: "pc1", value: 20 },
        { id: "n2", tokenId: "gob", value: 15 },
        { id: "n3", tokenId: "dark", value: 10 },
        { id: "n4", tokenId: "hid", value: 5, hidden: true },
      ],
    });
    const startOf = (viewer: typeof DM) => projectState(state, viewer, { sceneId: "s1" }).encounter!.turnStart;
    assert.equal(startOf(DM), undefined, "nothing before the first turn");

    state = apply(state, { t: "encounter.next" });
    assert.deepEqual(state.encounter!.turnStart, { entryId: "n1", tokenId: "pc1", sceneId: "s1", x: 1, y: 1, elevation: 0, seen: true, seq: 1 });
    state = apply(state, { t: "token.move", tokenId: "pc1", x: 4, y: 1 }, P1);
    assert.deepEqual(startOf(P1), { entryId: "n1", tokenId: "pc1", sceneId: "s1", x: 1, y: 1, elevation: 0, seq: 1 }, "the owner, without the mark");
    assert.deepEqual(startOf(P2), startOf(P1), "another player who saw it there");

    state = apply(state, { t: "encounter.next" });
    assert.equal(state.encounter!.turnStart!.tokenId, "gob");
    assert.ok(startOf(P2));
    state = apply(state, { t: "token.update", tokenId: "gob", patch: { visibility: "dm" } });
    assert.equal(startOf(P2), undefined, "a creature hidden since takes its spot with it");
    assert.ok(startOf(DM));

    // A creature in the dark when its turn began never shows players where that was, even once it walks into the light.
    state = apply(state, { t: "encounter.next" });
    assert.deepEqual(state.encounter!.turnStart, { entryId: "n3", tokenId: "dark", sceneId: "s1", x: 30, y: 30, elevation: 0, seq: 1 });
    state = apply(state, { t: "token.move", tokenId: "dark", x: 3, y: 4 });
    assert.equal(projectState(state, P2, { sceneId: "s1" }).encounter!.activeEntryId, "n3");
    assert.equal(startOf(P2), undefined);
    assert.equal(startOf(DM)!.x, 30);

    // A hidden row revealed on its turn starts in sight.
    state = apply(state, { t: "encounter.next" });
    assert.equal(state.encounter!.turnStart!.tokenId, "hid");
    assert.equal(state.encounter!.turnStart!.seen, true);
    assert.ok(startOf(P2));

    // Previous puts back the spot the earlier turn began on, and a removal that passes the turn records the next one's.
    state = apply(state, { t: "encounter.prev" });
    assert.deepEqual(state.encounter!.turnStart, { entryId: "n3", tokenId: "dark", sceneId: "s1", x: 30, y: 30, elevation: 0, seq: 1 });
    state = apply(state, { t: "encounter.remove", entryIds: ["n3"] });
    assert.equal(state.encounter!.activeEntryId, "n4");
    assert.equal(state.encounter!.turnStart!.tokenId, "hid");
    state = apply(state, { t: "encounter.remove", entryIds: ["n1"] });
    assert.equal(state.encounter!.turnStart!.tokenId, "hid", "a row leaving out of turn keeps the active one's spot");
    state = apply(state, { t: "token.update", tokenId: "hid", patch: { sceneId: "s2" } });
    assert.ok(startOf(DM), "the DM keeps the spot, which the canvas draws only on its scene");
    assert.equal(startOf(P2), undefined);
  });

  test("a player's rows are numbered without gaps, so tie order never hints at a hidden row", () => {
    const state = setup();
    const rows = [
      entry("n1", { tokenId: "pc1", value: 15, tieOrder: 0 }),
      entry("n2", { tokenId: "gob", value: 15, hidden: true, tieOrder: 1 }),
      entry("n3", { label: "Lair", value: 15, tieOrder: 2 }),
      entry("n4", { tokenId: "dark", value: 12, tieOrder: 3 }),
      entry("n5", { label: "Reinforcements", value: 8, tieOrder: 4 }),
    ];
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: rows };
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(
      p.encounter!.entries.map((e) => [e.id, e.tieOrder]),
      [
        ["n1", 0],
        ["n3", 1],
        ["n5", 2],
      ],
    );
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).encounter!.entries, rows, "the DM keeps the stored numbers");
    assert.equal(state.encounter.entries[2]!.tieOrder, 2, "the room's own rows are untouched");
  });

  test("a DM edit players cannot see changes nothing they receive about a creature, a character or the fight", () => {
    let state = room();
    state.tokens.gob = token("gob", { nameHidden: true, publicName: "Cloaked figure" });
    state.tokens.pet = token("pet", { kind: "npc", ownerIds: ["p1"] });
    state.characters.pc = character("pc");
    state.tokens.pcTok = token("pcTok", { kind: "pc", actor: { ref: "pc" } });
    state.tokens.lurker = token("lurker", { visibility: "dm" });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e1", { tokenId: "gob" }), entry("e2", { tokenId: "lurker", hidden: true, tieOrder: 1 })] };
    const watched = [keys.token("gob"), keys.token("pet"), keys.token("pcTok"), keys.character("pc"), keys.encounter];
    const held = (s: RoomState, viewer: Viewer) => watched.map((key) => hashValue(projectEntity(key, s, viewer, { sceneId: "s1" })));
    const before = { p1: held(state, P1), p2: held(state, P2) };
    const hidden = { id: "secret", key: "custom" as const, label: "Invisible", hiddenFromPlayers: true };
    let seq = 1;
    for (const op of [
      { t: "actor.effect.add", target: { tokenId: "gob" }, effect: hidden },
      { t: "actor.effect.add", target: { tokenId: "pet" }, effect: { ...hidden, id: "secret2" } },
      { t: "actor.effect.add", target: { characterId: "pc" }, effect: { ...hidden, id: "secret3" } },
      { t: "token.update", tokenId: "gob", patch: { name: "Vecna", actor: { dmNotes: "the real villain" } } },
      { t: "character.update", characterId: "pc", patch: { actor: { dmNotes: "owes the guild" } } },
      { t: "encounter.add", entries: [{ id: "e3", label: "Reinforcements", hidden: true }] },
      { t: "encounter.setValue", entryId: "e2", value: 19 },
    ] as Op[]) {
      state = apply(state, op, DM, seq++);
    }
    assert.deepEqual({ p1: held(state, P1), p2: held(state, P2) }, before);
  });

  test("templates, drawings, handouts and whispers", () => {
    const state = setup();
    state.templates.onDark = template("onDark", { attachedTo: "dark", ownerId: "dm1" });
    state.templates.caster = template("caster", { casterId: "dark", ownerId: "p1" });
    state.templates.p2s = template("p2s", { ownerId: "p2" });
    state.templates.dms = template("dms", { ownerId: "dm1" });
    state.templates.secret = template("secret", { ownerId: "dm1", visibility: "dm" });
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "a", title: "x", to: ["p2"], shownAt: "" };
    state.handouts.h2 = { id: "h2", rev: 0, assetId: "b", title: "x", to: "all", shownAt: "" };
    state.log = [
      { id: "1:0", at: "", kind: "whisper", from: "p2", to: ["p1"], text: "a" },
      { id: "1:1", at: "", kind: "whisper", from: "p2", to: ["dm1"], text: "b" },
      { id: "1:2", at: "", kind: "whisper", from: "p1", to: ["p2"], text: "c" },
    ];
    let p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(Object.keys(p.templates).sort(), ["caster", "dms", "p2s"]);
    assert.equal(p.templates.caster!.casterId, null);
    assert.deepEqual(Object.keys(p.handouts), ["h2"]);
    assert.deepEqual(p.log.map((e) => e.id), ["1:0", "1:2"]);
    state.meta.settings.playersSeeAoeOfOthers = false;
    p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(Object.keys(p.templates).sort(), ["caster", "dms"]);
    const dm = projectState(state, DM, { sceneId: "s1" });
    assert.deepEqual(dm.log.map((e) => e.id), ["1:1"]);
    assert.equal(dm.templates.caster!.casterId, "dark");
  });

  test("log events strip HP numbers the viewer may not see and keep the label", () => {
    const state = setup();
    state.log = [
      { id: "1:0", at: "", kind: "event", data: { type: "hp", tokenId: "gob", seen: true, change: "damage", amount: 9, label: "Bloodied" } },
      { id: "1:1", at: "", kind: "event", data: { type: "concentration", tokenId: "gob", seen: true, dc: 12 } },
      { id: "1:2", at: "", kind: "event", data: { type: "hp", characterId: "c1", change: "heal", amount: 4, label: "Healthy" } },
      { id: "1:3", at: "", kind: "event", data: { type: "hp", tokenId: "dark", seen: true, change: "damage", amount: 1 } },
      { id: "1:4", at: "", kind: "event", data: { type: "deathSave", tokenId: "gob", seen: true, ok: 1, fail: 2 } },
      { id: "1:5", at: "", kind: "event", data: { type: "deathSave", characterId: "c1", ok: 2, fail: 0 } },
    ];
    const p = projectState(state, P2, { sceneId: "s1" });
    assert.deepEqual(p.log.map((e) => e.data), [
      { type: "hp", tokenId: "gob", seen: true, change: "damage", label: "Bloodied" },
      { type: "concentration", tokenId: "gob", seen: true },
      { type: "hp", characterId: "c1", change: "heal", amount: 4, label: "Healthy" },
      { type: "deathSave", tokenId: "gob", seen: true },
      { type: "deathSave", characterId: "c1", ok: 2, fail: 0 },
    ]);
    state.tokens.gob!.hpVisibility = "hidden";
    assert.deepEqual(projectState(state, P2, { sceneId: "s1" }).log[0]!.data, { type: "hp", tokenId: "gob", seen: true, change: "damage" });
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).log.map((e) => e.data), state.log.map((e) => e.data));
  });

  test("events about hidden effects reach only the DM, owners included, in snapshots, fan-out and log pages", () => {
    let state = setup();
    state.tokens.gob!.ownerIds = ["p1"];
    const hidden = { hiddenFromPlayers: true };
    const ops: Op[] = [
      { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "wall", key: "concentrating", spell: "Wall of Force", ...hidden } },
      { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 4 } },
      { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "inv", key: "invisible", spell: "Greater Invisibility", ...hidden } },
      { t: "actor.effect.remove", target: { tokenId: "gob" }, effectId: "inv" },
      { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "stun", key: "stunned" } },
      { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob", value: 10 }] },
      { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "hex", key: "hexed", duration: { mode: "rounds", rounds: 1, of: { entryId: "n1" } }, ...hidden } },
      { t: "encounter.next" },
      { t: "actor.effect.add", target: { tokenId: "gob" }, effect: { id: "bane", key: "baned", duration: { mode: "rounds", rounds: 3, of: { entryId: "n1" } }, ...hidden } },
      { t: "encounter.remove", entryIds: ["n1"] },
    ];
    const before = state.log.length;
    ops.forEach((op, i) => {
      const r = applyOp(state, op, DM, env(10 + i));
      assert.ok(r.ok, `${op.t}: ${r.ok ? "" : r.message}`);
      // Fan-out projects each new entry on its own, and older log pages go through the same call.
      for (const entry of r.log) {
        const secret = entry.data && "hidden" in entry.data && entry.data.hidden === true;
        for (const viewer of [P1, P2]) {
          const single = projectEntity(keys.log(entry.id), r.state, viewer, { sceneId: "s1" });
          if (secret) assert.equal(single, null, `${op.t} ${viewer.memberId}`);
        }
        assert.deepEqual(projectEntity(keys.log(entry.id), r.state, DM, { sceneId: "s1" }), entry);
      }
      state = r.state;
    });
    const events = state.log.slice(before).map((e) => e.data!);
    const secret = events.filter((d) => "hidden" in d && d.hidden);
    assert.deepEqual(secret.map((d) => [d.type, "key" in d ? d.key : "", "action" in d ? d.action : "", "ended" in d ? d.ended : "dc" in d]), [
      ["effect", "concentrating", "add", false],
      ["concentration", "", "", true],
      ["effect", "invisible", "add", false],
      ["effect", "invisible", "remove", false],
      ["concentration", "", "", true],
      ["effect", "hexed", "add", false],
      ["effect", "hexed", "expire", false],
      ["effect", "baned", "add", false],
      ["effect", "baned", "pause", false],
    ]);
    for (const viewer of [P1, P2]) {
      const seen = projectState(state, viewer, { sceneId: "s1" }).log.map((e) => e.data!);
      assert.ok(!JSON.stringify(seen).match(/Wall of Force|Greater Invisibility|concentrat|hexed|baned/), `${viewer.memberId}: ${JSON.stringify(seen)}`);
      assert.ok(seen.some((d) => d.type === "effect" && d.key === "stunned" && d.action === "add"));
      assert.ok(seen.some((d) => d.type === "hp" && d.change === "damage"));
    }
    assert.equal(projectState(state, DM, { sceneId: "s1" }).log.length, state.log.length);
  });

  test("the turns of a row players could not see stay out of their log after the row is revealed", () => {
    const base = setup();
    base.meta.settings.revealHiddenOnTurn = false;
    base.tokens.gob!.visibility = "dm";
    // Inside the scene and under fog.
    base.tokens.dark!.y = 20;
    let state = apply(base, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob", value: 20 }, { id: "n2", tokenId: "pc1", value: 10 }, { id: "n3", tokenId: "dark", value: 5 }] }, DM, 1);
    assert.equal(state.encounter!.entries.find((e) => e.id === "n1")!.hidden, true);
    const turns: string[] = [];
    for (let seq = 2; seq <= 4; seq++) {
      const r = applyOp(state, { t: "encounter.next" }, DM, env(seq));
      assert.ok(r.ok);
      turns.push(r.log[0]!.id);
      state = r.state;
    }
    const turnRows = (s: RoomState, viewer: Viewer) =>
      projectState(s, viewer, { sceneId: "s1" }).log.flatMap((e) => (e.data?.type === "turn" ? [e.data.entryId] : []));
    assert.deepEqual(turnRows(state, P2), ["n2"]);
    // Reveal the hidden row and its token, and lift the fog off the dark one.
    state = apply(state, { t: "encounter.update", entryId: "n1", patch: { hidden: false } }, DM, 5);
    state = apply(state, { t: "token.update", tokenId: "gob", patch: { visibility: "all" } }, DM, 6);
    state = apply(state, { t: "fog.reset", sceneId: "s1", to: "revealed" }, DM, 7);
    assert.equal(projectState(state, P2, { sceneId: "s1" }).encounter!.entries.length, 3);
    assert.deepEqual(turnRows(state, P2), ["n2"]);
    for (const id of [turns[0]!, turns[2]!]) assert.equal(projectEntity(keys.log(id), state, P2, { sceneId: "s1" }), null);
    assert.equal(turnRows(state, DM).length, 3);
    // The PC's owner and everyone else saw the PC's turn.
    assert.deepEqual(turnRows(state, P1), ["n2"]);
    // With the setting on, the row is revealed by the same next, so its turn is seen.
    const on = deepClone(base);
    on.meta.settings.revealHiddenOnTurn = true;
    const started = apply(on, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob", value: 20 }] }, DM, 1);
    const r = applyOp(started, { t: "encounter.next" }, DM, env(2));
    assert.ok(r.ok);
    assert.deepEqual(r.log[0]!.data, { type: "turn", entryId: "n1", round: 1, seen: true });
  });

  test("Previous takes back a turn line players saw, and both leave their log when the step hides the row again", () => {
    const base = setup();
    let state = apply(base, { t: "encounter.start", entries: [{ id: "n1", tokenId: "pc1", value: 20 }, { id: "n2", tokenId: "gob", value: 10 }] }, DM, 1);
    state = apply(state, { t: "encounter.next" }, DM, 2);
    state = apply(state, { t: "encounter.prev" }, DM, 3);
    state = apply(state, { t: "encounter.next" }, DM, 4);
    const lines = (s: RoomState) =>
      projectState(s, P2, { sceneId: "s1" }).log.flatMap((e) => (e.data?.type === "turn" ? [`${e.data.entryId}${e.data.back ? " back" : ""}`] : []));
    assert.deepEqual(lines(state), ["n1", "n1 back", "n1"]);
    // A hidden row revealed by its turn is hidden again by Previous, and neither line stays.
    const hidden = setup();
    hidden.tokens.gob!.visibility = "dm";
    let h = apply(hidden, { t: "encounter.start", entries: [{ id: "n2", tokenId: "gob", value: 10 }] }, DM, 1);
    h = apply(h, { t: "encounter.next" }, DM, 2);
    assert.deepEqual(lines(h), ["n2"]);
    h = apply(h, { t: "encounter.prev" }, DM, 3);
    assert.deepEqual(lines(h), []);
    assert.equal(projectState(h, DM, { sceneId: "s1" }).log.filter((e) => e.data?.type === "turn").length, 2);
  });

  test("what happened to a creature while players could not see it stays out of their log after a reveal", () => {
    const base = setup();
    base.tokens.gob!.visibility = "dm";
    base.tokens.mine = token("mine", { x: 2, y: 3, visibility: "dm", ownerIds: ["p1"] });
    const damage = (tokenId: string) => ({ t: "actor.hp", target: { tokenId }, change: { kind: "damage", amount: 3 } }) as const;
    const logOf = (s: RoomState, viewer: Viewer) => projectState(s, viewer, { sceneId: "s1" }).log.map((e) => e.data);
    const seenMark = (e: { data?: object }) => e.data !== undefined && "seen" in e.data && e.data.seen === true;

    // Hidden: the DM's damage, then a reveal.
    let r = applyOp(base, damage("gob"), DM, env(1));
    assert.ok(r.ok);
    const hiddenHit = r.log[0]!;
    assert.equal("seen" in hiddenHit.data!, false);
    let state = apply(r.state, { t: "token.update", tokenId: "gob", patch: { visibility: "all" } }, DM, 2);
    assert.ok(projectState(state, P2, { sceneId: "s1" }).tokens.gob);
    assert.deepEqual(logOf(state, P2), []);
    // The fan-out re-projects the entry when the token changes, and it must still come out empty.
    assert.equal(projectEntity(keys.log(hiddenHit.id), state, P2, { sceneId: "s1" }), null);
    // A hit while visible is kept, hidden again with the creature, and back after the next reveal.
    r = applyOp(state, damage("gob"), DM, env(3));
    assert.ok(r.ok && seenMark(r.log[0]!));
    state = r.state;
    assert.equal(logOf(state, P2).length, 1);
    state = apply(state, { t: "token.update", tokenId: "gob", patch: { visibility: "dm" } }, DM, 4);
    assert.deepEqual(logOf(state, P2), []);
    state = apply(state, { t: "token.update", tokenId: "gob", patch: { visibility: "all" } }, DM, 5);
    assert.equal(logOf(state, P2).length, 1);

    // An owner sees its own creature's history. Other players do not.
    state = apply(base, damage("mine"), DM, 1);
    state = apply(state, { t: "token.update", tokenId: "mine", patch: { visibility: "all" } }, DM, 2);
    assert.equal(logOf(state, P1).length, 1);
    assert.deepEqual(logOf(state, P2), []);

    // Under fog, then revealed.
    const fogged = deepClone(base);
    fogged.tokens.dark!.y = 20;
    state = apply(fogged, damage("dark"), DM, 1);
    state = apply(state, { t: "fog.reset", sceneId: "s1", to: "revealed" }, DM, 2);
    assert.ok(projectState(state, P2, { sceneId: "s1" }).tokens.dark);
    assert.deepEqual(logOf(state, P2), []);

    // On another scene, then the players move there.
    const away = setup();
    away.tokens.far = token("far", { sceneId: "s2" });
    state = apply(away, damage("far"), DM, 1);
    state = apply(state, { t: "room.setPlayerScene", sceneId: "s2" }, DM, 2);
    assert.ok(projectState(state, P2, { sceneId: "s2" }).tokens.far);
    assert.deepEqual(projectState(state, P2, { sceneId: "s2" }).log, []);

    // Revealed by the op that logs: the hit lands after the reveal, so it was seen.
    r = applyOp(base, { t: "token.update", tokenId: "gob", patch: { visibility: "all", actor: { hp: { cur: 1 } } } }, DM, env(1));
    assert.ok(r.ok && r.log.length > 0 && r.log.every(seenMark));
  });

  test("labels fully under fog are withheld from players, and come back when the fog lifts", () => {
    const state = setup();
    state.labels.lit = { id: "lit", rev: 0, sceneId: "s1", x: 2, y: 2, text: "Hall", size: 1 };
    state.labels.trap = { id: "trap", rev: 0, sceneId: "s1", x: 30, y: 20, text: "Trap", size: 1 };
    // Centered at x 8, the text reaches back into the revealed cells.
    state.labels.edge = { id: "edge", rev: 0, sceneId: "s1", x: 8, y: 3, text: "Long corridor", size: 1 };
    assert.deepEqual(Object.keys(projectState(state, P1, { sceneId: "s1" }).labels).sort(), ["edge", "lit"]);
    assert.equal(projectEntity(keys.label("trap"), state, P1, { sceneId: "s1" }), null);
    assert.deepEqual(Object.keys(projectState(state, DM, { sceneId: "s1" }).labels).sort(), ["edge", "lit", "trap"]);
    // Fog changes re-project everything (global), so a reveal reaches players through the fan-out.
    const r = applyOp(state, { t: "fog.live", sceneId: "s1", ops: [{ id: "f", mode: "reveal", shape: { kind: "rect", x: 30, y: 20, w: 1, h: 1 } }] }, DM, env(1));
    assert.ok(r.ok && r.global);
    assert.deepEqual(projectEntity(keys.label("trap"), r.state, P1, { sceneId: "s1" }), state.labels.trap);
    const off = deepClone(state);
    off.scenes.s1!.fogEnabled = false;
    assert.equal(Object.keys(projectState(off, P1, { sceneId: "s1" }).labels).length, 3);
  });

  test("secret doors are walls for players until discovered", () => {
    const state = setup();
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: {}, edges: { "1,1,n": { kind: "door", state: "closed", secret: true, discovered: false }, "1,1,w": { kind: "door", state: "closed", secret: true, discovered: true } } };
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(p.buildChunks["s1:0,0"]!.edges["1,1,n"], { kind: "wall" });
    assert.equal(p.buildChunks["s1:0,0"]!.edges["1,1,w"]!.kind, "door");
    assert.equal(projectState(state, DM, { sceneId: "s1" }).buildChunks["s1:0,0"], state.buildChunks["s1:0,0"]);
  });

  test("a hidden secret door reaches players exactly as the wall they would see without it, and a lock never does", () => {
    const hidden = { kind: "door", state: "closed", secret: true, discovered: false } as const;
    const locked = { kind: "door", state: "locked", secret: false, discovered: false } as const;
    let state = setup();
    // A hall 2..9 by 2..5 with a drawn wall run across it at x = 6.
    state = apply(state, { t: "build.rect", sceneId: "s1", terrain: "stone", x: 2, y: 2, w: 8, h: 4 });
    state = apply(state, { t: "build.edge", sceneId: "s1", edges: [{ key: "6,2,w", feature: { kind: "wall" } }, { key: "6,4,w", feature: { kind: "wall" } }] });
    const plain = projectState(state, P1, { sceneId: "s1" }).buildChunks["s1:0,0"]!;
    const doors = apply(state, {
      t: "build.edge",
      sceneId: "s1",
      edges: [
        // On the hall's outer wall, which is automatic: floor on one side only.
        { key: "4,2,n", feature: hidden },
        // In the drawn wall run, floor on both sides.
        { key: "6,3,w", feature: hidden },
        { key: "9,4,w", feature: locked },
      ],
    });
    const p = projectState(doors, P1, { sceneId: "s1" }).buildChunks["s1:0,0"]!;
    assert.deepEqual(p.edges, { ...plain.edges, "6,3,w": { kind: "wall" }, "9,4,w": { ...locked, state: "closed" } });
    assert.equal(p.rev, 0);
    // Placing a hidden door on an automatic wall changes no chunk a player receives.
    const onlyAuto = apply(state, { t: "build.edge", sceneId: "s1", edges: [{ key: "4,2,n", feature: hidden }] });
    assert.equal(stableStringify(projectState(onlyAuto, P1, { sceneId: "s1" }).buildChunks), stableStringify(projectState(state, P1, { sceneId: "s1" }).buildChunks));
    // A chunk that holds nothing but such a door is withheld, like a chunk with nothing in it.
    const border = apply(apply(setup(), { t: "build.rect", sceneId: "s1", terrain: "stone", x: 2, y: 14, w: 3, h: 2 }), {
      t: "build.edge",
      sceneId: "s1",
      edges: [{ key: "3,16,n", feature: hidden }],
    });
    assert.ok(border.buildChunks["s1:0,1"]);
    assert.equal(projectState(border, P1, { sceneId: "s1" }).buildChunks["s1:0,1"], undefined);
    // Floor painted in the chunk above, across the border, makes the door a wall between two floors. That
    // changes the chunk below for players though the op never touched it, so the fan-out re-projects it.
    const below = apply(setup(), { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["3,16"] });
    const door = apply(below, { t: "build.edge", sceneId: "s1", edges: [{ key: "3,16,n", feature: hidden }] });
    assert.deepEqual(projectState(door, P1, { sceneId: "s1" }).buildChunks["s1:0,1"]!.edges, {});
    const r = applyOp(door, { t: "build.paint", sceneId: "s1", terrain: "stone", cells: ["3,15"] }, DM, env(50));
    assert.ok(r.ok);
    assert.deepEqual(projectState(r.state, P1, { sceneId: "s1" }).buildChunks["s1:0,1"]!.edges, { "3,16,n": { kind: "wall" } });
    assert.ok(!r.touched.includes(keys.chunk("s1", 0, 1)));
    assert.ok(dependents(r.state, r.touched).includes(keys.chunk("s1", 0, 1)));
  });

  test("an edit of a hidden secret door or a lock changes no scene or chunk a player receives", () => {
    let state = setup();
    state = apply(state, { t: "build.rect", sceneId: "s1", terrain: "stone", x: 2, y: 2, w: 8, h: 4 });
    state = apply(state, {
      t: "build.edge",
      sceneId: "s1",
      edges: [
        { key: "6,2,w", feature: { kind: "wall" } },
        { key: "6,3,w", feature: { kind: "door", state: "closed", secret: true, discovered: false } },
        { key: "6,4,w", feature: { kind: "door", state: "closed", secret: false, discovered: false } },
      ],
    });
    const seen = (s: RoomState) => [keys.scene("s1"), keys.chunk("s1", 0, 0)].map((key) => hashValue(projectEntity(key, s, P1, { sceneId: "s1" })));
    const before = seen(state);
    const edited = apply(state, {
      t: "build.edge",
      sceneId: "s1",
      edges: [
        { key: "6,3,w", feature: { kind: "door", state: "open", secret: true, discovered: false } },
        { key: "6,4,w", feature: { kind: "door", state: "locked", secret: false, discovered: false } },
      ],
    });
    assert.ok(edited.scenes.s1!.wallsVersion > state.scenes.s1!.wallsVersion);
    assert.deepEqual(seen(edited), before);
  });

  test("behind a blackout a player holds none of the table, a reload included, and the DM holds all of it", () => {
    const state = setup();
    state.scenes.s1!.map = { assetId: "map1", widthPx: 1, heightPx: 1, cellPx: 1, originPx: { x: 0, y: 0 } };
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "1,1": "stone" }, edges: {} };
    state.labels.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 2, y: 2, text: "Lair", size: 1 };
    state.templates.a1 = template("a1", { ownerId: "dm1" });
    state.drawings.d1 = { id: "d1", rev: 0, sceneId: "s1", kind: "line", points: [0, 0, 1, 1], style: { stroke: "#ffffff", width: 1, opacity: 1 }, ownerId: "dm1", visibility: "all" };
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "hand1", title: "The map", to: "all", shownAt: "" };
    // A row of its own can name what is coming.
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("n1", { label: "Ancient Red Dragon", value: 20 }), entry("n2", { characterId: "c1" })] };
    state.log = [
      { id: "1:0", at: "", kind: "event", data: { type: "hp", tokenId: "gob", seen: true, change: "damage", amount: 1, label: "Bloodied" } },
      { id: "1:1", at: "", kind: "event", data: { type: "encounter", action: "start" } },
      { id: "1:2", at: "", kind: "event", data: { type: "handout", handoutId: "h1" } },
      { id: "1:3", at: "", kind: "event", data: { type: "hp", characterId: "c1", change: "heal", amount: 2, label: "Healthy" } },
      { id: "1:4", at: "", kind: "chat", from: "dm1", text: "Back in five" },
    ];
    const open = projectState(state, P1, { sceneId: "s1" });
    assert.ok(open.scenes.s1 && open.tokens.gob && open.labels.l1 && open.encounter && open.handouts.h1);
    assert.equal(open.log.length, 5);

    state.meta.view.blackout = true;
    for (const viewer of [P1, P2]) {
      const p = projectState(state, viewer, { sceneId: "s1" });
      assertPaused(p, viewer.memberId);
      assert.equal(p.meta.view.blackout, true, "the pause screen needs the blackout itself");
      assert.deepEqual(Object.keys(p.members).sort(), Object.keys(state.members).sort());
      assert.deepEqual(p.log.map((e) => e.id), ["1:3", "1:4"], "chat and the party's own news stay");
      assert.deepEqual([...visibleAssetIds(state, viewer, { sceneId: "s1" })], [], "not even the map image");
      // The fan-out projects one entity at a time, and must agree with the snapshot.
      for (const key of allKeys(state)) {
        if (key === keys.encounterHistory) continue;
        assert.equal(stableStringify(projectEntity(key, state, viewer, { sceneId: "s1" })), stableStringify(readEntity(p as unknown as RoomState, key)), key);
      }
    }
    const dm = projectState(state, DM, { sceneId: "s1" });
    assert.ok(dm.scenes.s1 && dm.tokens.dark && dm.labels.l1 && dm.handouts.h1);
    assert.equal(dm.encounter, state.encounter);
    assert.equal(dm.log.length, 5);
  });

  test("players always get the player scene, whatever sceneId the caller passes", () => {
    const state = setup();
    state.tokens.far = token("far", { sceneId: "s2" });
    const p = projectState(state, P1, { sceneId: "s2" });
    assert.deepEqual(Object.keys(p.scenes), ["s1"]);
    assert.equal(p.tokens.far, undefined);
    assert.equal(projectEntity(keys.token("far"), state, P1, { sceneId: "s2" }), null);
    assert.equal(projectEntity(keys.fogDraft("s1"), state, P1, { sceneId: "s1" }), null);
    assert.equal(projectEntity(keys.encounterHistory, state, P1, { sceneId: "s1" }), null);
    assert.equal(projectEntity("bogus", state, DM, { sceneId: "s1" }), null);
  });

  test("visibleAssetIds and dependents", () => {
    const state = setup();
    state.scenes.s1!.map = { assetId: "map1", widthPx: 1, heightPx: 1, cellPx: 1, originPx: { x: 0, y: 0 } };
    state.scenes.s2!.map = { assetId: "map2", widthPx: 1, heightPx: 1, cellPx: 1, originPx: { x: 0, y: 0 } };
    state.tokens.gob!.image = { assetId: "gobpic", crop: { cx: 0, cy: 0, zoom: 1 } };
    state.tokens.dark!.image = { assetId: "darkpic", crop: { cx: 0, cy: 0, zoom: 1 } };
    state.characters.c1!.defaultImage = { assetId: "heropic", crop: { cx: 0, cy: 0, zoom: 1 } };
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "hand1", title: "x", to: ["p2"], shownAt: "" };
    assert.deepEqual([...visibleAssetIds(state, P1, { sceneId: "s1" })].sort(), ["gobpic", "heropic", "map1"]);
    assert.deepEqual([...visibleAssetIds(state, P2, { sceneId: "s1" })].sort(), ["gobpic", "hand1", "heropic", "map1"]);
    assert.deepEqual([...visibleAssetIds(state, DM, { sceneId: "s1" })].sort(), ["darkpic", "gobpic", "hand1", "heropic", "map1", "map2"]);

    state.templates.a1 = template("a1", { attachedTo: "gob" });
    state.templates.a2 = template("a2", { casterId: "pc1" });
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("n1", { characterId: "c1" })] };
    state.log = [
      { id: "1:0", at: "", kind: "event", data: { type: "hp", tokenId: "gob", change: "damage", amount: 1 } },
      { id: "1:1", at: "", kind: "event", data: { type: "turn", entryId: "n1", round: 1 } },
      { id: "1:2", at: "", kind: "event", data: { type: "handout", handoutId: "h1" } },
      { id: "1:3", at: "", kind: "chat", text: "x" },
    ];
    assert.deepEqual(dependents(state, [keys.token("gob")]), [keys.template("a1"), keys.log("1:0")]);
    assert.deepEqual(dependents(state, [keys.character("c1")]), [keys.token("pc1"), keys.template("a2"), keys.encounter, keys.log("1:1")]);
    assert.deepEqual(dependents(state, [keys.handout("h1")]), [keys.log("1:2")]);
    assert.deepEqual(dependents(state, [keys.encounter]), [keys.log("1:1")]);
    assert.deepEqual(dependents(state, [keys.token("gob"), keys.template("a1")]), [keys.log("1:0")]);
  });

  test("range rings go with the token to everyone who sees it, and with it out of sight", () => {
    const state = setup();
    state.tokens.gob!.rangeRings = [30, 60];
    state.tokens.dark!.rangeRings = [120];
    const p = projectState(state, P2, { sceneId: "s1" });
    assert.deepEqual(p.tokens.gob!.rangeRings, [30, 60]);
    assert.equal(p.tokens.dark, undefined);
  });

  test("a kept ruler reaches players only while they see every token it stands on", () => {
    const state = setup();
    state.tokens.hid = token("hid", { x: 4, y: 4, visibility: "dm" });
    const kept = (id: string, anchors: (string | null)[], over: Partial<Drawing> = {}) => {
      state.drawings[id] = drawing(id, { kind: "ruler", points: anchors.flatMap((_, i) => [i + 0.5, 0.5]), anchors, ...over });
    };
    kept("free", [null, null]);
    kept("seen", ["pc1", "gob"]);
    kept("dark", ["pc1", "dark"]);
    kept("hidden", ["gob", null, "hid"]);
    kept("gone", ["pc1", "deleted-token"]);
    kept("private", ["pc1", "gob"], { ownerId: "dm1", visibility: "dm" });
    const shown = (viewer: typeof DM) => Object.keys(projectState(state, viewer, { sceneId: "s1" }).drawings).sort();
    assert.deepEqual(shown(P2), ["free", "seen"], "the stop on a token gone is where it stood when kept, so it counts as unseen");
    assert.deepEqual(shown(DM), ["dark", "free", "gone", "hidden", "private", "seen"]);
    assert.deepEqual(dependents(state, [keys.token("gob")]), [keys.drawing("seen"), keys.drawing("hidden"), keys.drawing("private")]);
    // Into the dark, and the ruler on it leaves the players' maps with it.
    state.tokens.gob!.x = 30;
    assert.deepEqual(shown(P2), ["free"]);
  });

  test("a kept ruler's stop on a token reaches players where they see the token now, never where it stood unseen", () => {
    const state = setup();
    state.tokens.hid = token("hid", { x: 30, y: 25, visibility: "dm" });
    state.tokens.ogre = token("ogre", { x: 4, y: 1, size: "large" });
    const stored = [1.5, 1.5, 30.5, 25.5, 9.5, 2.5, 4, 2];
    state.drawings.r = drawing("r", { kind: "ruler", points: stored, anchors: ["pc1", "hid", null, "ogre"] });
    const ruler = (s: RoomState, viewer: Viewer) => projectState(s, viewer, { sceneId: "s1" }).drawings.r;
    assert.equal(ruler(state, P1), undefined, "on a hidden token");

    let shown = apply(state, { t: "token.move", tokenId: "hid", x: 3, y: 3 });
    shown = apply(shown, { t: "token.update", tokenId: "hid", patch: { visibility: "all" } }, DM, 2);
    assert.deepEqual(ruler(shown, P1)!.points, [1.5, 1.5, 3.5, 3.5, 9.5, 2.5, 5, 2], "token middles, the large one's included, and the free stop as kept");
    assert.ok(!JSON.stringify(projectState(shown, P1, { sceneId: "s1" })).includes("25.5"), "where the hidden token stood never reaches a player");
    assert.deepEqual(ruler(shown, DM)!.points, stored, "the DM gets the stops as kept");

    // A move of a token the ruler is on reaches players through the fan-out's dependents.
    const moved = applyOp(shown, { t: "token.move", tokenId: "pc1", x: 2, y: 4 }, DM, env(3));
    assert.ok(moved.ok);
    assert.ok(dependents(moved.state, moved.touched).includes(keys.drawing("r")));
    assert.deepEqual((projectEntity(keys.drawing("r"), moved.state, P1, { sceneId: "s1" }) as Drawing).points, [2.5, 4.5, 3.5, 3.5, 9.5, 2.5, 5, 2]);
  });

  test("a kept ruler's ground heights reach players as stored, in the snapshot a reconnect gets", () => {
    const state = setup();
    state.drawings.r = drawing("r", { kind: "ruler", points: [1.5, 1.5, 2.5, 1.5, 6.5, 1.5], anchors: ["pc1", null, null], z: [0, 10, -5] });
    for (const viewer of [P1, P2, DM]) {
      const snapshot = JSON.parse(JSON.stringify(projectState(state, viewer, { sceneId: "s1" }))) as { drawings: Record<string, Drawing> };
      assert.deepEqual(snapshot.drawings.r?.z, [0, 10, -5], viewer.memberId);
    }
  });

  test("monster images reach only DMs, and players meet one only on a token they see", () => {
    const state = setup();
    state.monsters.mon = customMonster("mon", { defaultImage: imageRef("lurkerpic") });
    state.srdImages["goblin-warrior"] = srdImage("goblin-warrior", "gobpic");
    state.srdImages.owlbear = srdImage("owlbear", "owlpic");
    for (const viewer of [P1, P2]) {
      const p = projectState(state, viewer, { sceneId: "s1" });
      assert.deepEqual(p.srdImages, {});
      assert.deepEqual(p.monsters, {});
      assert.equal(projectEntity(keys.srdImage("owlbear"), state, viewer, { sceneId: "s1" }), null);
      assert.deepEqual([...visibleAssetIds(state, viewer, { sceneId: "s1" })], []);
    }
    // The goblin on the map wears the SRD image: players may read it there, and only there.
    state.tokens.gob!.image = imageRef("gobpic");
    assert.deepEqual([...visibleAssetIds(state, P1, { sceneId: "s1" })], ["gobpic"]);
    assert.deepEqual([...visibleAssetIds(state, DM, { sceneId: "s2" })].sort(), ["gobpic", "lurkerpic", "owlpic"]);
    assert.deepEqual(projectEntity(keys.srdImage("owlbear"), state, DM, { sceneId: "s2" }), state.srdImages.owlbear);
  });

  test("hashing is stable across key order and diffs report only real changes", () => {
    assert.equal(stableStringify({ b: 1, a: [1, { d: undefined, c: "x" }] }), '{"a":[1,{"c":"x"}],"b":1}');
    assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
    assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
    assert.equal(hash128("").length, 32);
    assert.notEqual(hash128("abc"), hash128("abd"));
    assert.equal(hash128("hello world, this is a longer string"), hash128("hello world, this is a longer string"));
    const held = new Map([["token:a", hashValue({ x: 1 })], ["token:b", hashValue({ x: 2 })]]);
    const next = new Map<string, unknown>([["token:a", { x: 1 }], ["token:b", { x: 3 }], ["token:c", { x: 4 }], ["token:d", null]]);
    const diff = diffProjection(held, next);
    assert.deepEqual(diff.changes, [{ key: "token:b", value: { x: 3 } }, { key: "token:c", value: { x: 4 } }]);
    assert.equal(diff.held.size, 3);
    assert.equal(held.size, 2);
    const removal = diffProjection(diff.held, new Map([["token:a", null]]));
    assert.deepEqual(removal.changes, [{ key: "token:a", deleted: true }]);
    assert.ok(!removal.held.has("token:a"));
  });

  test("hash128 gives fixed digests, the ones it gave before it read whole code units", () => {
    // Undo guards are these digests (guardHash), stored in sys.restore ops that replay recomputes, so they can never change.
    // Computed with the byte-by-byte implementation as it stood at wave 4's vision rules (wpuslqux).
    const cases: string[] = ["", ...Array.from({ length: 17 }, (_, n) => "abcdefghijklmnopq".slice(0, n + 1)), "梟 the owlbear, élan, ñ", "a\uD800b", "\uDC00"];
    assert.deepEqual(cases.map(hash128), [
      "00000000000000000000000000000000",
      "033bb196ccef4fe1ccef4fe1ccef4fe1",
      "260fb953af22b6fdaf22b6fdaf22b6fd",
      "2b5b97a320f75fb55012c2b45012c2b4",
      "95ef82c7e4ec9aa20a8cb00d0a8cb00d",
      "4b3605de6cd4a2059a7ed1750af158b2",
      "606aa1e086f87a046d0a007998aceaac",
      "851fde5ef81a9aab2a351f32fa8e8ca7",
      "6c3576558df898a1a76d230d42147114",
      "17a3d73237eee48604d39ee1ee7f6ddc",
      "53abf878bb832bb3d1c9c9909d7fff86",
      "14ab0cf2e193d814170d73120a84af8d",
      "c5c32a161a414a029e155627825292f2",
      "0b31507ac25a520edf7582f73a360631",
      "a3926961453b08c3c9aa615f2e3dfefd",
      "6d2a38537f1251126d8b3115bc98d783",
      "a132e65523e3b4188b21842ef114d982",
      "fec38c83ea62e9e1c69074d667a5f76d",
      "ccc8a32823f06707b1350af7f1174592",
      "c0b7184989ef3b258a271a088a271a08",
      "ae0796eaa591e78aa591e78aa591e78a",
    ]);
  });

  test("heldOf covers exactly what a snapshot holds", () => {
    const state = setup();
    const p = projectState(state, P1, { sceneId: "s1" });
    const held = heldOf(p);
    assert.ok(held.has(keys.meta));
    assert.ok(held.has(keys.token("pc1")));
    assert.ok(!held.has(keys.token("dark")));
    assert.ok(!held.has(keys.encounter));
    assert.ok(!held.has(keys.encounterHistory));
    assert.equal(held.get(keys.token("pc1")), hashValue(p.tokens.pc1));
  });
});

describe("wave 3 projection", () => {
  const door = { kind: "door" as const, state: "closed" as const, secret: true, discovered: false };

  test("a hidden secret door goes only where the scene's rule puts an automatic wall, across a chunk border too", () => {
    const state = room();
    // Stone at 15,3 in chunk 0 beside nothing at 16,3 in chunk 1; water at 16,5 beside nothing at 15,5; stone beside water at 16,7.
    state.buildChunks["s1:0,0"] = { sceneId: "s1", cx: 0, cy: 0, rev: 0, cells: { "15,3": "stone", "15,7": "stone" }, edges: {} };
    state.buildChunks["s1:1,0"] = {
      sceneId: "s1",
      cx: 1,
      cy: 0,
      rev: 0,
      cells: { "16,5": "water", "16,7": "water" },
      edges: { "16,3,w": door, "16,5,w": door, "16,7,w": door, "16,9,w": door },
    };
    const shown = (rule: "all" | "floor" | "off" | undefined) => {
      if (rule === undefined) delete state.scenes.s1!.autoWalls;
      else state.scenes.s1!.autoWalls = rule;
      return projectState(state, P1, { sceneId: "s1" }).buildChunks["s1:1,0"]!.edges;
    };
    const wall = { kind: "wall" };
    // Floor beside nothing, an overlay beside nothing, floor beside an overlay, nothing on either side.
    assert.deepEqual(shown(undefined), { "16,7,w": wall, "16,9,w": wall });
    assert.deepEqual(shown("all"), { "16,7,w": wall, "16,9,w": wall });
    assert.deepEqual(shown("floor"), { "16,5,w": wall, "16,7,w": wall, "16,9,w": wall });
    assert.deepEqual(shown("off"), { "16,3,w": wall, "16,5,w": wall, "16,7,w": wall, "16,9,w": wall });
  });

  test("free walls arrive sorted, a hidden secret free door as a wall and a locked one closed, and a chunk of only free walls is sent", () => {
    const state = room();
    const w = (id: string, x: number, f: FreeWall["f"]): FreeWall => ({ id, a: [x, 1], b: [x, 2], f });
    state.buildChunks["s1:0,0"] = {
      sceneId: "s1",
      cx: 0,
      cy: 0,
      rev: 5,
      cells: {},
      edges: {},
      walls: [w("ccccccccccc3", 3, door), w("aaaaaaaaaaa1", 1, { ...door, secret: false, state: "locked" }), w("bbbbbbbbbbb2", 2, { kind: "window" })],
    };
    const chunk = projectState(state, P1, { sceneId: "s1" }).buildChunks["s1:0,0"]!;
    assert.equal(chunk.rev, 0);
    assert.deepEqual(chunk.walls, [
      w("aaaaaaaaaaa1", 1, { ...door, secret: false, state: "closed" }),
      w("bbbbbbbbbbb2", 2, { kind: "window" }),
      w("ccccccccccc3", 3, { kind: "wall" }),
    ]);
    assert.equal(projectState(state, DM, { sceneId: "s1" }).buildChunks["s1:0,0"], state.buildChunks["s1:0,0"]);
  });

  test("a player's scene is an allowlist: no folder, thumbnail or phases, and edits of them change nothing players receive", () => {
    const state = room();
    const map = { assetId: "day", widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } };
    state.scenes.s1 = { ...state.scenes.s1!, rev: 7, order: 3, map, autoWalls: "floor", folder: "Act 1", thumb: "th", phases: [{ id: "p1", name: "Day", assetId: "day", widthPx: 100, heightPx: 100 }, { id: "p2", name: "On fire", assetId: "fire", widthPx: 100, heightPx: 100 }], phaseId: "p1", phaseGrid: { refWidthPx: 100, refHeightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 } } };
    const scene = projectState(state, P1, { sceneId: "s1" }).scenes.s1!;
    const { rev: _rev, order: _order, folder: _folder, thumb: _thumb, phases: _phases, phaseId: _phaseId, phaseGrid: _grid, ...kept } = state.scenes.s1!;
    assert.deepEqual(scene, { ...kept, rev: 0, order: 0 });
    const before = hashValue(scene);
    const edited = apply(state, { t: "scene.update", sceneId: "s1", patch: { folder: "Act 2", thumb: "th2" } });
    assert.equal(hashValue(projectEntity(keys.scene("s1"), edited, P1, { sceneId: "s1" })), before);
    const players = visibleAssetIds(state, P1, { sceneId: "s1" });
    assert.ok(players.has("day") && !players.has("fire") && !players.has("th"));
    const dm = visibleAssetIds(state, DM, { sceneId: "s2" });
    assert.ok(dm.has("day") && dm.has("fire") && dm.has("th"));
  });

  test("a stamp is withheld when hidden or when every cell under its turned box is fogged, and its image goes with it", () => {
    const state = room();
    state.scenes.s1!.fogEnabled = true;
    reveal(state, "s1", { x: 4, y: 0, w: 1, h: 1 });
    const stamp = (id: string, overrides: Partial<Stamp>): Stamp => ({ id, rev: 0, sceneId: "s1", art: { assetId: `img-${id}` }, x: 2, y: 0.5, w: 2, h: 1, rotation: 0, z: 0, visibility: "all", ...overrides });
    // Lying flat it covers cells 1 to 2, all fogged. Stood on end with its turned box reaching x = 4.5, it touches the revealed cell.
    state.stamps.flat = stamp("flat", {});
    state.stamps.long = stamp("long", { x: 3, w: 1, h: 3, rotation: 90 });
    state.stamps.hidden = stamp("hidden", { x: 4.5, visibility: "dm" });
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(Object.keys(p.stamps), ["long"]);
    const visible = visibleAssetIds(state, P1, { sceneId: "s1" });
    assert.ok(visible.has("img-long") && !visible.has("img-flat") && !visible.has("img-hidden"));
    assert.deepEqual(stampCells(state.stamps.long!), { x0: 1, y0: 0, x1: 5, y1: 1 });
    state.scenes.s1!.fogEnabled = false;
    assert.deepEqual(Object.keys(projectState(state, P1, { sceneId: "s1" }).stamps).sort(), ["flat", "long"]);
    assert.equal(Object.keys(projectState(state, DM, { sceneId: "s1" }).stamps).length, 3);
  });

  test("a copy of a map scene whose fog is off, made with Fog left off, shows players none of its creatures", () => {
    const state = room();
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: false, map: { assetId: "m", widthPx: 400, heightPx: 300, cellPx: 10, originPx: { x: 0, y: 0 } } };
    state.tokens.gob = token("gob", { x: 2, y: 2 });
    state.labels.lab = { id: "lab", rev: 0, sceneId: "s1", x: 3, y: 3, text: "Trap", size: 1 };
    assert.deepEqual(Object.keys(projectState(state, P1, { sceneId: "s1" }).tokens), ["gob"], "the original shows it");
    let copy = apply(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: true, characters: false, fog: false, drawings: false } });
    copy = apply(copy, { t: "room.setPlayerScene", sceneId: "s3" }, DM, 2);
    const p = projectState(copy, P1, { sceneId: "s3" });
    assert.equal(p.scenes.s3?.fogEnabled, true);
    assert.deepEqual(p.tokens, {});
    assert.deepEqual(p.labels, {});
    assert.deepEqual(p.fogTiles, {});
    assertNoLeaks(copy, P1, p, "copy");
  });

  test("a public ruler on a DM-only token, copied without the creatures, never reaches players", () => {
    const state = room();
    state.tokens.hid = token("hid", { x: 8, y: 8, visibility: "dm" });
    state.drawings.r = drawing("r", { kind: "ruler", points: [1.5, 1.5, 3.5, 3.5], anchors: [null, "hid"], visibility: "all" });
    assert.equal(projectState(state, P1, { sceneId: "s1" }).drawings.r, undefined, "the original keeps it from players");
    let copy = apply(state, { t: "scene.duplicate", sceneId: "s1", newSceneId: "s3", name: "Copy", include: { creatures: false, characters: false, fog: false, drawings: true } });
    copy = apply(copy, { t: "room.setPlayerScene", sceneId: "s3" }, DM, 2);
    for (const viewer of [P1, P2]) {
      const p = projectState(copy, viewer, { sceneId: "s3" });
      assert.deepEqual(p.drawings, {});
      assert.ok(!JSON.stringify(p).includes("8.5"), "where the hidden token stands never reaches a player");
      assertNoLeaks(copy, viewer, p, viewer.memberId);
    }
    assert.deepEqual(projectState(copy, DM, { sceneId: "s3" }).drawings[derivedId("s3", "r")]?.points, [1.5, 1.5, 8.5, 8.5], "the DM keeps it, measured from where the token stands");
  });

  test("lights reach only the DM, on the scene in view", () => {
    const state = room();
    state.lights.l1 = { id: "l1", rev: 0, sceneId: "s1", x: 1, y: 1, bright: 20, dim: 20, on: true, walls: true };
    assert.deepEqual(projectState(state, P1, { sceneId: "s1" }).lights, {});
    assert.equal(projectState(state, DM, { sceneId: "s1" }).lights.l1, state.lights.l1);
    assert.deepEqual(projectState(state, DM, { sceneId: "s2" }).lights, {});
    assert.equal(projectEntity(keys.light("l1"), state, P1, { sceneId: "s1" }), null);
  });
});

/*
 * What the stat summary and the AC shield may show rests on these
 * (docs/design-v1-token-panel.md 3.2 and 3.9): they read only the viewer's
 * copy, so a number the projection holds back can never reach a screen.
 */
describe("the stats a player's copy holds, for the stat summary and the AC shield", () => {
  const inlineOf = (t: { actor: unknown } | undefined) => (t?.actor as { inline?: ProjectedActor } | undefined)?.inline;

  test("a monster the player does not own reaches them without its AC, speeds, Passive Perception or stat block links", () => {
    const state = room();
    state.tokens.g = token("g", { actor: { inline: actor({ ac: 15, srdId: "goblin-warrior", passivePerception: 9 }) } });
    state.tokens.m = token("m", { actor: { inline: actor({ ac: 13, monsterId: "mon1" }) } });
    for (const viewer of [P1, DISPLAY]) {
      const p = projectState(state, viewer, { sceneId: "s1" });
      for (const id of ["g", "m"]) {
        const a = inlineOf(p.tokens[id]) as Record<string, unknown> | undefined;
        assert.ok(a, `${viewer.memberId} sees ${id}`);
        for (const key of ["ac", "speeds", "passivePerception", "srdId", "monsterId"]) assert.equal(key in a, false, `${viewer.memberId}'s ${id} has no ${key}`);
      }
    }
  });

  test("an owner's copy of an SRD-linked token with its own actor has its AC and SRD id, never a room monster's id", () => {
    const state = room();
    state.tokens.w = token("w", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ ac: 13, srdId: "brown-bear", speeds: { walk: 40, climb: 30 }, passivePerception: 13 }) } });
    state.tokens.r = token("r", { kind: "npc", ownerIds: ["p1"], actor: { inline: actor({ ac: 12, monsterId: "mon1" }) } });
    const p = projectState(state, P1, { sceneId: "s1" });
    const w = inlineOf(p.tokens.w)!;
    assert.equal(w.ac, 13);
    assert.equal(w.srdId, "brown-bear");
    assert.deepEqual(w.speeds, { walk: 40, climb: 30 });
    assert.equal(w.passivePerception, 13);
    assert.equal("monsterId" in w, false);
    const r = inlineOf(p.tokens.r)!;
    assert.equal(r.ac, 12);
    assert.equal("monsterId" in r, false, "owners never get monsterId");
  });

  test("a character's token owned without its character carries only the reference, and the character comes without its AC", () => {
    const state = room();
    state.characters.c2 = character("c2", { ownerIds: ["p2"], actor: actor({ ac: 17, passivePerception: 15 }) });
    state.tokens.t2 = token("t2", { kind: "pc", ownerIds: ["p1"], actor: { ref: "c2" } });
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(p.tokens.t2?.actor, { ref: "c2" });
    const c = p.characters.c2?.actor as Record<string, unknown> | undefined;
    assert.ok(c, "the character reaches them as any other player's");
    for (const key of ["ac", "speeds", "passivePerception", "srdId", "sheetUrl"]) assert.equal(key in c, false, `no ${key}`);
    assert.equal((projectState(state, P2, { sceneId: "s1" }).characters.c2?.actor as Partial<RoomState["characters"][string]["actor"]>).ac, 17, "its own player holds it");
  });

  test("a hidden token reaches its owners and no other player", () => {
    const state = room();
    state.tokens.h = token("h", { kind: "npc", visibility: "dm", ownerIds: ["p1"], actor: { inline: actor({ ac: 14 }) } });
    assert.equal(inlineOf(projectState(state, P1, { sceneId: "s1" }).tokens.h)?.ac, 14);
    assert.equal(projectState(state, P2, { sceneId: "s1" }).tokens.h, undefined);
    assert.equal(projectState(state, DISPLAY, { sceneId: "s1" }).tokens.h, undefined);
  });
});

describe("companions (docs/design-v1-combat-flow.md 3.6.5 and 4.5)", () => {
  /** Bree (Ana, p1) with a spirit (a creature) and a weapon (an effect), and Cy (p2), a player who owns neither. */
  function party(): RoomState {
    const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
    state.tokens.bt = token("bt", { kind: "pc", actor: { ref: "bree" }, x: 2, y: 2 });
    state.tokens.ws = token("ws", { kind: "npc", ownerIds: ["p1"], hpVisibility: "hidden", companion: { of: "bree", turn: "shared", reactionUsed: true }, actor: { inline: actor({ hp: { cur: 9, max: 15, temp: 0 } }) }, x: 3, y: 2 });
    state.tokens.sw = token("sw", { kind: "object", ownerIds: ["p1"], hpVisibility: "exact", companion: { of: "bree", turn: "none" }, actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 }, ac: 0 }) }, x: 4, y: 2 });
    return state;
  }
  const seen = (state: RoomState, viewer: Viewer, id: string) => projectState(state, viewer, { sceneId: "s1" }).tokens[id];
  const inline = (t: { actor: { ref: string } | { inline: ProjectedActor } } | undefined): ProjectedActor => {
    assert.ok(t && "inline" in t.actor);
    return t.actor.inline;
  };

  test("owners get companion, its Reaction included, and another player gets it only while a player owns the token", () => {
    const state = party();
    assert.deepEqual(seen(state, P1, "ws")?.companion, { of: "bree", turn: "shared", reactionUsed: true });
    assert.deepEqual(seen(state, P2, "ws")?.companion, { of: "bree", turn: "shared", reactionUsed: true });
    assert.deepEqual(seen(state, DISPLAY, "ws")?.companion, { of: "bree", turn: "shared", reactionUsed: true });
    // Ana leaves the roster: the member leaves every owner list, so no player plays the spirit any more.
    const left = apply(state, { t: "sys.memberRemove", memberId: "p1" });
    assert.equal(seen(left, P2, "ws")?.companion, undefined);
    // A companion of a character no player plays reaches players as a plain token.
    const dms = party();
    dms.characters.bree = { ...dms.characters.bree!, ownerIds: [] };
    dms.tokens.ws = { ...dms.tokens.ws!, ownerIds: [] };
    assert.equal(seen(dms, P2, "ws")?.companion, undefined);
    assert.equal(seen(dms, P2, "ws")?.party, undefined);
  });

  test("never to a player who cannot see the token, and the encounter carries no companion ids while saved steps reach only the DM", () => {
    const state = party();
    state.tokens.ws = { ...state.tokens.ws!, visibility: "dm" };
    assert.equal(seen(state, P2, "ws"), undefined);
    state.encounter = { rev: 0, round: 1, activeEntryId: null, entries: [entry("e1", { tokenId: "bt" })] };
    state.encounterHistory = [{ encounter: structuredClone(state.encounter), effects: {}, revealed: [], companionReactions: ["ws"], at: "x" }];
    const p = projectState(state, P1, { sceneId: "s1" });
    assert.deepEqual(p.encounterHistory, []);
    assert.ok(!JSON.stringify(p.encounter).includes("ws"));
    assert.deepEqual(projectState(state, DM, { sceneId: "s1" }).encounterHistory[0]?.companionReactions, ["ws"]);
  });

  test("a creature companion's HP follows Players see the party's HP while a player plays it, and its own setting once none does", () => {
    const state = party();
    assert.deepEqual(inline(seen(state, P2, "ws")).hp, { cur: 9, max: 15, temp: 0 }, "hidden on the token, yet the party's rule says exact");
    state.meta.settings = { ...state.meta.settings, pcHpVisibleToParty: false };
    assert.equal(inline(seen(state, P2, "ws")).hpLabel, "Healthy");
    assert.equal(inline(seen(state, P2, "ws")).hp, undefined);
    const nobody = party();
    nobody.tokens.ws = { ...nobody.tokens.ws!, ownerIds: [] };
    nobody.characters.bree = { ...nobody.characters.bree!, ownerIds: [] };
    const a = inline(seen(nobody, P2, "ws"));
    assert.equal("hp" in a || "hpLabel" in a || "hpBar" in a, false, "its own hidden HP again");
  });

  test("hpAccess gives no HP for any token hpLess holds for, and a plain object with HP keeps its own rule", () => {
    const state = party();
    assert.equal(hpAccess(state, P2, { token: state.tokens.sw }), "none", "an effect");
    state.tokens.zero = token("zero", { hpVisibility: "exact", actor: { inline: actor({ hp: { cur: 0, max: 0, temp: 0 } }) } });
    assert.equal(hpAccess(state, P2, { token: state.tokens.zero }), "none", "a maximum of 0");
    state.tokens.chest = token("chest", { kind: "object", hpVisibility: "exact", actor: { inline: actor({ hp: { cur: 10, max: 10, temp: 0 } }) } });
    assert.equal(hpAccess(state, P2, { token: state.tokens.chest }), "exact");
    assert.equal(hpAccess(state, P1, { token: state.tokens.sw }), "exact", "its owner");
    const a = inline(seen(state, P2, "sw"));
    assert.equal("hp" in a || "hpLabel" in a || "hpBar" in a, false, "0 of 0 never reaches them as Bloodied");
  });

  test("an effect companion reaches a non-owning player and the table display alive, a dead one included, while its owner and the DM get its stored life", () => {
    const state = party();
    state.tokens.sw = { ...state.tokens.sw!, actor: { inline: actor({ hp: { cur: 0, max: 15, temp: 0 }, ac: 13, life: "dead" }) } };
    assert.equal(inline(seen(state, P2, "sw")).life, "alive");
    assert.equal(inline(seen(state, DISPLAY, "sw")).life, "alive");
    assert.equal(inline(seen(state, P1, "sw")).life, "dead");
    assert.equal(inline(seen(state, DM, "sw")).life, "dead");
    // Its life lines say nothing to non-owners either.
    state.log = [{ id: "1:0", at: "x", kind: "event", data: { type: "life", tokenId: "sw", seen: true, life: "dead" } }];
    assert.equal(projectState(state, P2, { sceneId: "s1" }).log.length, 0);
    assert.equal(projectState(state, P1, { sceneId: "s1" }).log.length, 1);
    // The control: an ordinary creature with hidden HP keeps its real life for everyone.
    const control = party();
    control.tokens.gob = token("gob", { hpVisibility: "hidden", actor: { inline: actor({ hp: { cur: 0, max: 7, temp: 0 }, life: "dead" }) } });
    assert.equal(inline(seen(control, P2, "gob")).life, "dead");
  });

  test("the companion line reaches only the DM", () => {
    const state = party();
    state.log = [{ id: "1:0", at: "x", kind: "event", data: { type: "companion", tokenId: "ws", characterId: "bree", memberId: "p1", name: "Wildfire Spirit" } }];
    assert.equal(projectState(state, P1, { sceneId: "s1" }).log.length, 0, "not even the player who added it");
    assert.equal(projectState(state, P2, { sceneId: "s1" }).log.length, 0);
    assert.equal(projectState(state, DM, { sceneId: "s1" }).log.length, 1);
  });
});

describe("an effect companion lends no sight (docs/design-v1-combat-flow.md 3.6.5, SOL-01)", () => {
  /** A bright vision scene with no player character on it: Ana's companion beside a goblin is the party's only member there. */
  function weaponBeside(kind: "object" | "npc", partyVision: boolean): RoomState {
    const state = room({ characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1"] }) } });
    state.scenes.s1 = { ...state.scenes.s1!, fogEnabled: true, vision: { on: true, light: "bright" } };
    state.tokens.sw = token("sw", { kind, name: "Spiritual Weapon", ownerIds: ["p1"], x: 5, y: 5, companion: { of: "bree", turn: "none" }, ...(partyVision ? { partyVision: true } : {}) });
    state.tokens.gob = token("gob", { name: "Goblin", x: 7, y: 5 });
    return state;
  }

  test("even with the DM's party mark, the goblin beside a Spiritual Weapon stays withheld, and the mark is kept for a creature again", () => {
    for (const viewer of [P1, P2]) {
      assert.equal(projectState(weaponBeside("object", true), viewer, { sceneId: "s1" }).tokens.gob, undefined, `${viewer.memberId}: marked effect`);
      assert.equal(projectState(weaponBeside("object", false), viewer, { sceneId: "s1" }).tokens.gob, undefined, `${viewer.memberId}: unmarked effect`);
      assert.ok(projectState(weaponBeside("npc", true), viewer, { sceneId: "s1" }).tokens.gob, `${viewer.memberId}: a creature companion lends sight`);
    }
    // A plain object the DM marked still lends sight, as before companions.
    const lamp = weaponBeside("object", true);
    delete lamp.tokens.sw!.companion;
    lamp.tokens.sw!.ownerIds = [];
    assert.ok(projectState(lamp, P2, { sceneId: "s1" }).tokens.gob, "a marked plain object lends sight");
  });
});

describe("pdf handouts (docs/design-v1-pdf-handouts.md 3.4)", () => {
  const pages = [
    { assetId: "page1", width: 1584, height: 2048 },
    { assetId: "page2", width: 2048, height: 1584 },
    { assetId: "page3", width: 1448, height: 2048 },
  ];
  function shown(to: "all" | string[]): RoomState {
    const state = room();
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "page1", pages, title: "Strange letter", to, shownAt: "" };
    return state;
  }
  const ON_S1 = { sceneId: "s1" };

  test("a player shown the handout gets it whole, every page with its size, and every page in their visible set", () => {
    const state = shown(["p1"]);
    assert.deepEqual(projectState(state, P1, ON_S1).handouts.h1?.pages, pages);
    for (const id of ["page1", "page2", "page3"]) assert.ok(visibleAssetIds(state, P1, ON_S1).has(id), id);
    // A table display gets the handouts shown to everyone, by the same set.
    const all = shown("all");
    assert.deepEqual(projectState(all, DISPLAY, ON_S1).handouts.h1?.pages, pages);
    for (const id of ["page1", "page2", "page3"]) assert.ok(visibleAssetIds(all, DISPLAY, ON_S1).has(id), `display: ${id}`);
  });

  test("a player not shown it, a display for chosen players and anyone behind a blackout get no handout and no page", () => {
    const chosen = shown(["p1"]);
    const blackout = shown("all");
    blackout.meta.view.blackout = true;
    for (const [state, viewer, label] of [
      [chosen, P2, "a player not shown it"],
      [chosen, DISPLAY, "a display, for chosen players"],
      [blackout, P1, "a player behind a blackout"],
      [blackout, DISPLAY, "a display behind a blackout"],
    ] as const) {
      assert.deepEqual(projectState(state, viewer, ON_S1).handouts, {}, label);
      const visible = visibleAssetIds(state, viewer, ON_S1);
      for (const id of ["page1", "page2", "page3"]) assert.ok(!visible.has(id), `${label}: ${id}`);
    }
  });

  test("closed, it takes every page out of the visible set", () => {
    const state = shown("all");
    delete state.handouts.h1;
    for (const id of ["page1", "page2", "page3"]) assert.ok(!visibleAssetIds(state, P1, ON_S1).has(id), id);
  });

  test("documents are the DM's alone: whole for the DM, none for a player or a display, and their pages reach a player only by being shown", () => {
    const state = room();
    state.handoutDocs.d1 = { id: "d1", rev: 0, title: "Strange letter", pages, createdAt: "" };
    assert.deepEqual(projectState(state, DM, ON_S1).handoutDocs, state.handoutDocs);
    assert.equal(projectEntity(keys.handoutDoc("d1"), state, DM, ON_S1), state.handoutDocs.d1);
    for (const viewer of [P1, P2, DISPLAY]) {
      assert.deepEqual(projectState(state, viewer, ON_S1).handoutDocs, {}, viewer.memberId);
      assert.equal(projectEntity(keys.handoutDoc("d1"), state, viewer, ON_S1), null, viewer.memberId);
      for (const id of ["page1", "page2", "page3"]) assert.ok(!visibleAssetIds(state, viewer, ON_S1).has(id), `${viewer.memberId}: ${id}`);
    }
    for (const id of ["page1", "page2", "page3"]) assert.ok(visibleAssetIds(state, DM, ON_S1).has(id), `DM: ${id}`);
    assert.ok(allKeys(state).includes(keys.handoutDoc("d1")));
    // Shown to one player as a handout, its pages reach that player and no one else.
    state.handouts.h1 = { id: "h1", rev: 0, assetId: "page1", pages, title: "Strange letter", to: ["p1"], shownAt: "" };
    assert.ok(visibleAssetIds(state, P1, ON_S1).has("page2"));
    assert.ok(!visibleAssetIds(state, P2, ON_S1).has("page2"));
  });
});

describe("companion stat blocks (docs/design-v1-companion-stat-blocks.md 4.2)", () => {
  const ON_S1 = { sceneId: "s1" };
  /** Bree, played by p1 and a third player together, with a token p2 owns but not Bree, and a block with a picture. */
  function bree(): RoomState {
    const state = room({
      members: { dm1: member("dm1", "dm"), p1: member("p1"), p2: member("p2"), p3: member("p3") },
      characters: { bree: character("bree", { name: "Bree", ownerIds: ["p1", "p3"] }), cy: character("cy", { name: "Cy", ownerIds: ["p2"] }) },
      tokens: { bt: token("bt", { kind: "pc", actor: { ref: "bree" }, ownerIds: ["p2"] }) },
    });
    state.companionBlocks.moth = companionBlock("moth", "bree", { rev: 4, defaultImage: imageRef("moth-picture") });
    state.companionBlocks.wolf = companionBlock("wolf", "cy", { name: "Wolf" });
    return state;
  }
  const P3: Viewer = { memberId: "p3", role: "player" };

  test("the DM gets every block whole, and the character's owners, co-owners included, theirs with rev 0", () => {
    const state = bree();
    assert.deepEqual(projectState(state, DM, ON_S1).companionBlocks, state.companionBlocks);
    assert.equal(projectEntity(keys.companionBlock("moth"), state, DM, ON_S1), state.companionBlocks.moth);
    for (const viewer of [P1, P3]) {
      assert.deepEqual(projectState(state, viewer, ON_S1).companionBlocks, { moth: { ...state.companionBlocks.moth!, rev: 0 } }, viewer.memberId);
      assert.deepEqual(projectEntity(keys.companionBlock("moth"), state, viewer, ON_S1), { ...state.companionBlocks.moth!, rev: 0 }, viewer.memberId);
      assert.ok(visibleAssetIds(state, viewer, ON_S1).has("moth-picture"), viewer.memberId);
    }
    assert.ok(visibleAssetIds(state, DM, ON_S1).has("moth-picture"));
    assert.ok(allKeys(state).includes(keys.companionBlock("moth")));
  });

  test("another player, a player who owns the character's token but not the character, and a display get none, nor their pictures", () => {
    const state = bree();
    for (const [viewer, label] of [
      [P2, "a player who owns Bree's token but not Bree"],
      [DISPLAY, "a table display"],
      [{ memberId: "p-nobody", role: "player" } as Viewer, "a player who owns nothing"],
    ] as const) {
      const blocks = projectState(state, viewer, ON_S1).companionBlocks;
      assert.deepEqual(Object.keys(blocks), viewer === P2 ? ["wolf"] : [], label);
      assert.equal(projectEntity(keys.companionBlock("moth"), state, viewer, ON_S1), null, label);
      assert.ok(!visibleAssetIds(state, viewer, ON_S1).has("moth-picture"), label);
    }
  });

  test("they follow the character's owners: the new owner gets them and the old one does not", () => {
    const state = apply(bree(), { t: "character.update", characterId: "bree", patch: { ownerIds: ["p2"] } });
    assert.deepEqual(Object.keys(projectState(state, P2, ON_S1).companionBlocks).sort(), ["moth", "wolf"]);
    assert.deepEqual(projectState(state, P1, ON_S1).companionBlocks, {});
  });

  test("a companion's link reaches its owners and the DM, and never another player or a display, even while the companion is the party's", () => {
    const state = bree();
    state.tokens.moth = token("moth", { kind: "npc", companion: { of: "bree", turn: "shared" }, ownerIds: ["p1", "p3"], actor: { inline: actor({ blockId: "moth", monsterId: "m1" }) } });
    const actorOf = (viewer: Viewer) => {
      const a = projectState(state, viewer, ON_S1).tokens.moth?.actor;
      assert.ok(a && "inline" in a, viewer.memberId);
      return a.inline;
    };
    assert.equal(actorOf(DM).blockId, "moth");
    for (const viewer of [P1, P3]) {
      assert.equal(actorOf(viewer).blockId, "moth", viewer.memberId);
      assert.equal("monsterId" in actorOf(viewer), false, `${viewer.memberId}: a room monster's link stays the DM's`);
    }
    for (const viewer of [P2, DISPLAY]) assert.equal("blockId" in actorOf(viewer), false, viewer.memberId);
  });

  test("behind a blackout a player keeps their characters' blocks, as they keep their characters", () => {
    const state = bree();
    state.meta.view.blackout = true;
    assert.deepEqual(Object.keys(projectState(state, P1, ON_S1).companionBlocks), ["moth"]);
    assert.ok(projectState(state, P1, ON_S1).characters.bree);
  });
});
