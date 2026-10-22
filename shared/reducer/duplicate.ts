import { keys, tileKey } from "../keys.ts";
import type { AreaTemplate, Drawing, Effect, Label, Light, Pin, RoomState, Scene, Stamp, Token, Trap, TrapAction } from "../model.ts";
import { hash128, inSightOfNonOwners } from "../project.ts";
import type { OpOf } from "../protocol.ts";
import { footprintRect } from "../rules/footprint.ts";
import { sortedById } from "./tokens.ts";
import { invalid, type Env, type Tx } from "./tx.ts";

/**
 * Duplicate a scene (docs/design-v1-maps-vision.md section 3.2), in one op.
 *
 * The map with its phases, the build, labels, stamps, lights, map pins
 * (wave 5) and traps are always copied. A copied pin keeps its page, so it reaches
 * exactly whom the original does. Monsters, NPCs and objects, player characters, the fog and the
 * drawings with placed areas come along when the op says so.
 *
 * A copy's id is derived from the new scene's id and the original's, never
 * sent: an op carrying thousands of ids would pass the 64 KiB frame. A
 * derived id that is taken already refuses the op. Free walls keep their
 * ids, which are only unique within their chunk.
 *
 * Nothing of a fight is copied: no initiative rows, no paths, and no
 * `fogExemptAuto`, which belongs to the original's fight and would never be
 * cleared on the copy. A copied creature's own effects count down against
 * the copy, paused until it joins a fight, or advancing the original's fight
 * would tick them (every actor ticks against its anchor). A PC token shares
 * its character's effects on purpose, so those stay as they are.
 *
 * The copy goes right after the original in the scene order, in the same
 * folder, and the scenes after it move down one.
 */
export function sceneDuplicate(tx: Tx, op: OpOf<"scene.duplicate">): void {
  const original = tx.scene(op.sceneId);
  if (tx.state.scenes[op.newSceneId]) throw invalid("scene already exists");
  const s = tx.state;
  const to = op.newSceneId;
  const copyId = (id: string) => derivedId(to, id);
  const fresh = (collection: Record<string, unknown>, id: string) => {
    if (collection[id] !== undefined) throw invalid("a copied id is taken");
    return id;
  };

  for (const scene of sortedById(Object.values(s.scenes))) {
    if (scene.order > original.order) tx.write(keys.scene(scene.id), { ...scene, order: scene.order + 1 });
  }
  const copy: Scene = { ...original, id: to, rev: 0, name: op.name, order: original.order + 1, wallsVersion: 0, fogEnabled: copyFogEnabled(original, op.include.fog) };
  tx.write(keys.scene(to), copy);

  for (const chunk of Object.values(s.buildChunks).filter((c) => c.sceneId === original.id)) {
    tx.write(keys.chunk(to, chunk.cx, chunk.cy), { ...chunk, sceneId: to });
  }
  for (const label of sortedById(Object.values(s.labels).filter((l) => l.sceneId === original.id))) {
    const id = fresh(s.labels, copyId(label.id));
    tx.write(keys.label(id), { ...label, id, sceneId: to } satisfies Label);
  }
  for (const stamp of sortedById(Object.values(s.stamps).filter((st) => st.sceneId === original.id))) {
    const id = fresh(s.stamps, copyId(stamp.id));
    tx.write(keys.stamp(id), { ...stamp, id, sceneId: to } satisfies Stamp);
  }
  for (const light of sortedById(Object.values(s.lights).filter((l) => l.sceneId === original.id))) {
    const id = fresh(s.lights, copyId(light.id));
    tx.write(keys.light(id), { ...light, id, sceneId: to } satisfies Light);
  }
  for (const pin of sortedById(Object.values(s.pins).filter((p) => p.sceneId === original.id))) {
    const id = fresh(s.pins, copyId(pin.id));
    tx.write(keys.pin(id), { ...pin, id, sceneId: to } satisfies Pin);
  }

  const copied = new Map<string, string>();
  for (const token of sortedById(Object.values(s.tokens).filter((t) => t.sceneId === original.id))) {
    if (!(token.kind === "pc" ? op.include.characters : op.include.creatures)) continue;
    copied.set(token.id, fresh(s.tokens, copyId(token.id)));
  }
  for (const token of sortedById(Object.values(s.tokens))) {
    const id = copied.get(token.id);
    if (id === undefined) continue;
    const { path: _path, attached, ...kept } = token;
    const next: Token = { ...kept, id, sceneId: to, fogExemptAuto: false };
    // A link joins the copies of the two tokens, and goes when the holder was not copied (docs/design-v1-attach.md 5.2).
    const holder = attached ? copied.get(attached.to) : undefined;
    if (attached && holder !== undefined) next.attached = { ...attached, to: holder };
    if ("inline" in token.actor) {
      const actor = token.actor.inline;
      next.actor = { inline: { ...actor, effects: actor.effects.map((e) => pausedOn(e, id)) } };
    }
    tx.write(keys.token(id), next);
  }

  // Traps come with the map (docs/design-v1-traps.md 6.8), their actions naming the copies. A token left behind is
  // dropped from them, and a door stays, since free walls keep their ids. What the reducer wrote on a trap stays behind.
  const ownCopy = new Map<string, string>();
  for (const stamp of Object.values(s.stamps)) if (stamp.sceneId === original.id) ownCopy.set(`stamp:${stamp.id}`, copyId(stamp.id));
  for (const light of Object.values(s.lights)) if (light.sceneId === original.id) ownCopy.set(`light:${light.id}`, copyId(light.id));
  for (const trap of sortedById(Object.values(s.traps ?? {}).filter((t) => t.sceneId === original.id))) {
    const id = fresh(s.traps, copyId(trap.id));
    const next: Trap = { ...trap, id, rev: 0, sceneId: to };
    if (trap.rig) {
      const { noticedBy: _noticed, due: _due, ...rig } = trap.rig;
      next.rig = { ...rig, actions: rig.actions.flatMap((a) => copiedAction(a, ownCopy, copied)) };
    }
    tx.write(keys.trap(id), next);
  }

  if (op.include.fog) {
    for (const tile of Object.values(s.fogTiles).filter((t) => t.sceneId === original.id)) {
      if (s.fogTiles[tileKey(to, tile.tx, tile.ty)]) throw invalid("a copied id is taken");
      tx.write(keys.fog(to, tile.tx, tile.ty), { ...tile, sceneId: to });
    }
    // The party's explored layer comes with the fog (section 3.2), as bookkeeping: it has no undo, and undoing the copy
    // takes it with the scene (shared/reducer/misc.ts restore).
    for (const key of Object.keys(s.exploredTiles).sort()) {
      const tile = s.exploredTiles[key]!;
      if (tile.sceneId !== original.id) continue;
      if (s.exploredTiles[tileKey(to, tile.tx, tile.ty)]) throw invalid("a copied id is taken");
      tx.writeBookkeeping(keys.explored(to, tile.tx, tile.ty), { ...tile, sceneId: to });
    }
  }

  if (op.include.drawings) {
    for (const drawing of sortedById(Object.values(s.drawings).filter((d) => d.sceneId === original.id))) {
      const id = fresh(s.drawings, copyId(drawing.id));
      const next: Drawing = { ...drawing, id, sceneId: to };
      if (drawing.anchors) Object.assign(next, copiedRuler(s, original.id, drawing, copied, tx.env));
      tx.write(keys.drawing(id), next);
    }
    for (const template of sortedById(Object.values(s.templates).filter((t) => t.sceneId === original.id))) {
      // An area that follows a token goes with its token, or not at all: its own origin is stale while attached.
      const attachedTo = template.attachedTo === undefined ? undefined : copied.get(template.attachedTo);
      if (template.attachedTo !== undefined && attachedTo === undefined) continue;
      const id = fresh(s.templates, copyId(template.id));
      const { casterId, attachedTo: _attached, ...kept } = template;
      const next: AreaTemplate = { ...kept, id, sceneId: to };
      if (attachedTo !== undefined) next.attachedTo = attachedTo;
      const caster = casterId === undefined ? undefined : copied.get(casterId);
      if (caster !== undefined) next.casterId = caster;
      tx.write(keys.template(id), next);
    }
  }
}

/**
 * A kept ruler's stops on the copy. A stop on a copied token stays on the
 * copy of it. A stop on a token left behind becomes a free stop where that
 * token stands now, the middle of its footprint, which is where the ruler
 * measured from: the stored point is only where the token stood when the
 * ruler was kept. A token that is gone, or on another scene, has no place
 * here, so its stop keeps the stored point.
 *
 * Players get a free stop wherever it is, while the original reaches them
 * only while they see every token it is on (projectDrawingCtx). So a ruler
 * with a stop left behind on a token kept from players who do not own it
 * (hidden, under fog, behind a blackout, gone or on another scene) is the
 * DM's alone on the copy, or the stop would show where that token stands.
 */
function copiedRuler(state: RoomState, sceneId: string, drawing: Drawing, copied: ReadonlyMap<string, string>, env: Env): Pick<Drawing, "anchors" | "points" | "visibility"> {
  const points = [...drawing.points];
  let withheld = false;
  const anchors = (drawing.anchors ?? []).map((tokenId, i) => {
    if (tokenId === null) return null;
    const copy = copied.get(tokenId);
    if (copy !== undefined) return copy;
    const token = state.tokens[tokenId];
    if (token?.sceneId === sceneId) {
      const r = footprintRect(token);
      points[2 * i] = r.x + r.w / 2;
      points[2 * i + 1] = r.y + r.h / 2;
    }
    if (token?.sceneId !== sceneId || !inSightOfNonOwners(state, token, env)) withheld = true;
    return null;
  });
  return { anchors, points, visibility: withheld ? "dm" : drawing.visibility };
}

/**
 * Whether the copy has fog. Copied fog keeps the original's setting with its
 * tiles. Without it, a map scene's copy gets fog like any new map scene
 * (`sceneCreate`), so it starts fully fogged even when the original's fog is
 * off. A blank mat's copy keeps the original's setting, fully fogged when
 * that is on.
 */
export function copyFogEnabled(original: Pick<Scene, "map" | "fogEnabled">, includeFog: boolean): boolean {
  if (includeFog) return original.fogEnabled;
  return original.map !== undefined || original.fogEnabled;
}

/**
 * A copy's id: the 128-bit hash of the new scene's id and the original's,
 * as a UUID. Both ids go in as a JSON pair, so no two pairs hash the same
 * text.
 */
export function derivedId(sceneId: string, originalId: string): string {
  const h = hash128(JSON.stringify([sceneId, originalId]));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A trap's action on the copy: a light or stamp on its copy, a token on its copy or dropped, a door as it is. */
function copiedAction(action: TrapAction, ownCopy: ReadonlyMap<string, string>, tokens: ReadonlyMap<string, string>): TrapAction[] {
  if ("door" in action) return [action];
  if ("light" in action) {
    const light = ownCopy.get(`light:${action.light}`);
    return light === undefined ? [] : [{ ...action, light }];
  }
  if ("tokenId" in action.show) {
    const tokenId = tokens.get(action.show.tokenId);
    return tokenId === undefined ? [] : [{ show: { tokenId } }];
  }
  const stampId = ownCopy.get(`stamp:${action.show.stampId}`);
  return stampId === undefined ? [] : [{ show: { stampId } }];
}

/** An effect of a copied creature, its duration paused on the copy with what remained. */
function pausedOn(effect: Effect, tokenId: string): Effect {
  if (!effect.duration) return effect;
  return { ...effect, duration: { ...effect.duration, anchor: { tokenId } } };
}
