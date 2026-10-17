import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import { AREA_SPELLS } from "#shared/srd/area-spells.ts";
import { actor, character, template, token } from "#shared/testutil.ts";
import {
  areaCreatures,
  castFrom,
  draftCaster,
  fromOffers,
  fromShows,
  idleTapPicks,
  pickedPress,
  savedChoice,
  seeSelection,
  tappedToken,
  tokenTap,
  withoutCreature,
  withoutDeparted,
  type AreaCreature,
  type SavedChoice,
} from "./caster.ts";
import { draftFromTemplate, draftTemplate, newDraft, withShape, type AreaDraft } from "./placement.ts";
import { presetDraft } from "./presets.ts";

describe("a tap with nothing in progress", () => {
  test("a token inside a placed area casts from the token", () => {
    assert.equal(idleTapPicks({ token: true, template: true }), "token");
    assert.equal(idleTapPicks({ token: false, template: true }), "template");
    assert.equal(idleTapPicks({ token: false, template: false }), "map");
  });
});

describe("a press on the picked placed area", () => {
  const nowhere = { directional: true, onCaster: false, handle: false, casterToken: false, inside: false, nearOrigin: false, attached: false, otherArea: false };

  test("a cone cast from a creature turns around it from the creature or inside, never moving off it", () => {
    const cast = { ...nowhere, onCaster: true };
    assert.equal(pickedPress({ ...cast, casterToken: true }), "turn", "a press on the creature's middle, far from the cone's edge origin");
    assert.equal(pickedPress({ ...cast, nearOrigin: true }), "turn");
    assert.equal(pickedPress({ ...cast, inside: true }), "turn");
    assert.equal(pickedPress({ ...cast, handle: true }), "turn");
    assert.equal(pickedPress({ ...cast, inside: true, otherArea: true }), "turn", "an area overlapping it never takes a press inside it");
  });

  test("a free cone moves from inside and turns from its handle", () => {
    assert.equal(pickedPress({ ...nowhere, inside: true }), "move");
    assert.equal(pickedPress({ ...nowhere, nearOrigin: true }), "move");
    assert.equal(pickedPress({ ...nowhere, handle: true }), "turn");
  });

  test("anywhere else a cone turns on a drag and lets go on a tap, unless another area is there to pick", () => {
    assert.equal(pickedPress(nowhere), "turnOrLetGo");
    assert.equal(pickedPress({ ...nowhere, onCaster: true }), "turnOrLetGo");
    assert.equal(pickedPress({ ...nowhere, otherArea: true }), null);
  });

  test("a sphere moves from inside, and anywhere else is left to the tap rules", () => {
    const sphere = { ...nowhere, directional: false };
    assert.equal(pickedPress({ ...sphere, inside: true }), "move");
    assert.equal(pickedPress({ ...sphere, handle: true }), null);
    assert.equal(pickedPress(sphere), null);
    assert.equal(pickedPress({ ...sphere, inside: true, attached: true }), null, "an aura on a token moves with the token");
  });
});

// ------------------------------------------------ the From control (docs/design-v1-area-from-character.md)

const FPC = 5;
const PAT = { memberId: "p1", role: "player" as const };
const DANA = { memberId: "dm1", role: "dm" as const };

/** Pat's Thorn at 3,3, his companion Pip at 6,3, and three goblins, on scene s1. */
function table(extra: Record<string, Token> = {}): Pick<RoomState, "tokens" | "characters"> {
  return {
    characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"] }), ash: character("ash", { name: "Ash", ownerIds: ["p1"] }), bree: character("bree", { name: "Bree", ownerIds: ["p2"] }) },
    tokens: {
      t: token("t", { kind: "pc", name: "Thorn", x: 3, y: 3, actor: { ref: "thorn" }, disposition: "ally" }),
      g1: token("g1", { name: "Goblin", number: 1, x: 10, y: 3 }),
      g2: token("g2", { name: "Goblin", number: 2, x: 12, y: 3 }),
      g3: token("g3", { name: "Goblin", number: 3, x: 14, y: 3 }),
      ...extra,
    },
  };
}
const pip = token("pip", { kind: "npc", name: "Pip", x: 6, y: 3, ownerIds: ["p1"], companion: { of: "thorn", turn: "shared" }, disposition: "ally" });
const mine = (view: Pick<RoomState, "tokens" | "characters">, sceneId = "s1") => areaCreatures({ view, sceneId, you: PAT });
const names = (list: readonly AreaCreature[]) => list.map((c) => c.name);
const resolve = (view: Pick<RoomState, "tokens" | "characters">, choice: SavedChoice, selected: { id: string | null; fresh: boolean } = { id: null, fresh: false }, sceneId = "s1") =>
  savedChoice({ creatures: mine(view, sceneId), tokens: view.tokens, sceneId, choice, selected, role: "player" });
const draft = (shape: AreaDraft["shape"], patch: Partial<AreaDraft> = {}): AreaDraft => ({ ...newDraft("d", shape, "#fff"), ...patch });
const spell = (name: string) => AREA_SPELLS.find((s) => s.name === name)!;

describe("the creatures an area may be cast from (3.1)", () => {
  test("a player's own, directly or through the character, a companion and a hidden one, characters first then by name", () => {
    const view = table({
      pip,
      own: token("own", { kind: "npc", name: "Ally", ownerIds: ["p1"], visibility: "dm" }),
      crate: token("crate", { kind: "object", name: "Crate", ownerIds: ["p1"] }),
      away: token("away", { kind: "pc", name: "Thorn", actor: { ref: "thorn" }, sceneId: "s2" }),
      breeT: token("breeT", { kind: "pc", name: "Bree", actor: { ref: "bree" } }),
    });
    const list = mine(view);
    assert.deepEqual(names(list), ["Thorn", "Ally", "Pip"], "no object, nothing on another scene, nothing of someone else's");
    assert.deepEqual(list.map((c) => c.kind), ["character", "other", "companion"]);
    assert.equal(list[0]!.characterId, "thorn");
  });

  test("a second token of one character reads Thorn 2, and the DM has none", () => {
    const view = table({ t2: token("t2", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } }) });
    assert.deepEqual(names(mine(view)), ["Thorn", "Thorn 2"]);
    assert.deepEqual(areaCreatures({ view, sceneId: "s1", you: DANA }), []);
  });

  test("a dying or dead creature is offered, but is not living", () => {
    const view = table();
    view.characters.thorn = character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ life: "dying" }) });
    assert.deepEqual(mine(view).map((c) => [c.name, c.living]), [["Thorn", false]]);
  });
});

describe("the saved choice (3.3)", () => {
  test("a fresh selection of one of yours wins and becomes the choice", () => {
    const view = table({ pip });
    assert.deepEqual(resolve(view, "none", { id: "pip", fresh: true }), { casterId: "pip", choice: { tokenId: "pip" } });
    assert.deepEqual(resolve(view, null, { id: "t", fresh: true }), { casterId: "t", choice: { tokenId: "t", characterId: "thorn" } });
  });

  test("an old selection does not: off with Thorn still selected stays off", () => {
    assert.deepEqual(resolve(table(), "none", { id: "t", fresh: false }), { casterId: null, choice: "none" });
  });

  test("a fresh selection of one of yours on another scene is not here, and the DM's selection never counts", () => {
    const view = table({ away: token("away", { kind: "npc", name: "Ally", ownerIds: ["p1"], sceneId: "s2" }) });
    assert.deepEqual(resolve(view, "none", { id: "away", fresh: true }), { casterId: null, choice: "none" });
    assert.deepEqual(savedChoice({ creatures: mine(view), tokens: view.tokens, sceneId: "s1", choice: null, selected: { id: "t", fresh: true }, role: "dm" }).casterId, null);
  });

  test("someone else's selection is ignored, as the DM's goblin", () => {
    assert.deepEqual(resolve(table(), "none", { id: "g1", fresh: true }), { casterId: null, choice: "none" });
    assert.deepEqual(resolve(table(), null, { id: "g1", fresh: true }).casterId, "t", "the default instead");
  });

  test("the choice by token, then by its character on another scene, and none holds", () => {
    const view = table({ pip, there: token("there", { kind: "pc", name: "Thorn", actor: { ref: "thorn" }, sceneId: "s2" }) });
    assert.equal(resolve(view, { tokenId: "pip" }).casterId, "pip");
    assert.equal(resolve(view, { tokenId: "t", characterId: "thorn" }, undefined, "s2").casterId, "there", "Thorn's token on the second scene, by his character");
    assert.equal(resolve(view, "none").casterId, null);
  });

  test("the default: your only living character, else your only living creature, else none", () => {
    assert.equal(resolve(table({ pip }), null).casterId, "t", "a companion never wins over a character");
    const away = table({ pip: { ...pip }, t: token("t", { kind: "pc", name: "Thorn", actor: { ref: "thorn" }, sceneId: "s2" }) });
    assert.equal(resolve(away, null).casterId, "pip", "Pip only, Thorn elsewhere");
    const two = table({ a: token("a", { kind: "pc", name: "Ash", actor: { ref: "ash" } }) });
    assert.equal(resolve(two, null).casterId, null, "two characters wait for a pick");
    const none = table({ t: token("t", { kind: "monster", name: "Rock", sceneId: "s2" }) });
    assert.equal(resolve(none, null).casterId, null);
  });

  test("a dying, stable or dead creature is never the default", () => {
    for (const life of ["dying", "stable", "dead"] as const) {
      const view = table();
      view.characters.thorn = character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ life }) });
      assert.equal(resolve(view, null).casterId, null, life);
      assert.equal(resolve(view, { tokenId: "t", characterId: "thorn" }).casterId, "t", `${life}, but chosen`);
    }
  });

  test("a choice whose creature is gone falls to the default, and the DM has none", () => {
    assert.equal(resolve(table({ pip }), { tokenId: "gone" }).casterId, "t");
    const view = table();
    assert.deepEqual(savedChoice({ creatures: [], tokens: view.tokens, sceneId: "s1", choice: null, selected: { id: "t", fresh: true }, role: "dm" }), { casterId: null, choice: null });
  });

  test("every change of the selection counts, and the same selection again does not", () => {
    let seen = { ids: [] as readonly string[], count: 0 };
    seen = seeSelection(seen, ["t"]);
    assert.equal(seen.count, 1);
    assert.equal(seeSelection(seen, ["t"]), seen, "a bar opened on the same selection");
    seen = seeSelection(seeSelection(seen, []), ["t"]);
    assert.equal(seen.count, 3, "letting go and selecting again");
  });
});

describe("what the control shows (3.3)", () => {
  const view = table({ pip });
  const tokens = view.tokens;

  test("idle shows the saved choice, placing the area's caster", () => {
    assert.equal(fromShows({ draft: null, saved: "t" }), "t");
    assert.equal(fromShows({ draft: castFrom(draft("cone"), "t", tokens, FPC), saved: null }), "t");
    assert.equal(fromShows({ draft: draft("cone"), saved: "t" }), null, "a draft with no caster is off, whatever the choice");
  });

  test("Copy of a goblin's area, Set caster on a goblin, None, and the caster deleted", () => {
    const placed = template("a", { shape: "sphere", casterId: "g1" });
    assert.equal(fromShows({ draft: draftFromTemplate(placed, "c", tokens, FPC), saved: "t" }), "g1");
    assert.equal(fromShows({ draft: castFrom(castFrom(draft("cone"), "t", tokens, FPC), "g1", tokens, FPC), saved: "t" }), "g1");
    assert.equal(fromShows({ draft: castFrom(castFrom(draft("cone"), "t", tokens, FPC), null, tokens, FPC), saved: "t" }), null);
    assert.equal(fromShows({ draft: withoutCreature(castFrom(draft("cone"), "t", tokens, FPC), "t"), saved: "pip" }), null, "off, no substitute");
  });

  test("Ice Knife's target is never its caster", () => {
    assert.equal(draftCaster({ targetsOther: true, fromId: "g1" }), null);
    assert.equal(draftCaster({ targetsOther: true, fromId: "g1", casterId: "t" }), "t");
  });
});

describe("the control's form (3.1, 3.2)", () => {
  const offers = (view: Pick<RoomState, "tokens" | "characters">, d: AreaDraft | null, saved: string | null = null, you: typeof PAT | typeof DANA = PAT) =>
    fromOffers({ creatures: areaCreatures({ view, sceneId: "s1", you }), draft: d, saved, view, sceneId: "s1", you });

  test("one creature is a toggle, two a chip, and none a disabled toggle with its words", () => {
    const one = offers(table(), null, "t");
    assert.equal(one.form, "toggle");
    assert.ok(one.form === "toggle" && one.on && one.offer.name === "Thorn");
    const two = offers(table({ pip }), null, "t");
    assert.ok(two.form === "chip" && two.on === "t" && names(two.offers).join() === "Thorn,Pip");
    const away = { ...table(), tokens: { t: token("t", { kind: "pc", name: "Thorn", actor: { ref: "thorn" }, sceneId: "s2" }) } };
    assert.deepEqual(offers(away, null), { form: "disabled", name: "Ash", characterId: "ash" }, "the first character by name, wherever it is");
    assert.deepEqual(offers({ characters: {}, tokens: {} }, null), { form: "disabled", name: null });
  });

  test("two characters: the chip reads No caster until one is picked. Pip alone, Thorn elsewhere: the toggle From Pip, on", () => {
    const two = table({ a: token("a", { kind: "pc", name: "Ash", actor: { ref: "ash" } }) });
    const saved = resolve(two, null).casterId;
    const chip = offers(two, null, saved);
    assert.ok(chip.form === "chip" && chip.on === null && names(chip.offers).join() === "Ash,Thorn");
    const away = table({ pip: { ...pip }, t: token("t", { kind: "pc", name: "Thorn", actor: { ref: "thorn" }, sceneId: "s2" }) });
    const toggle = offers(away, null, resolve(away, null).casterId);
    assert.ok(toggle.form === "toggle" && toggle.on && toggle.offer.name === "Pip");
  });

  test("the area's caster joins when it is not yours, and stays after off", () => {
    const view = table();
    const fromGoblin = castFrom(draft("cone"), "g1", view.tokens, FPC);
    const chip = offers(view, fromGoblin, "t");
    assert.ok(chip.form === "chip" && chip.on === "g1" && names(chip.offers).join() === "Thorn,Goblin 1");
    const off = offers(view, castFrom(fromGoblin, null, view.tokens, FPC), "t");
    assert.ok(off.form === "chip" && off.on === null && names(off.offers).join() === "Thorn,Goblin 1", "a dropped caster can come back");
  });

  test("the DM: nothing while idle, the toggle once an area is cast from a token", () => {
    const view = table();
    assert.deepEqual(offers(view, null, null, DANA), { form: "none" });
    assert.deepEqual(offers(view, draft("cone"), null, DANA), { form: "none" });
    const on = offers(view, castFrom(draft("cone"), "g1", view.tokens, FPC), null, DANA);
    assert.ok(on.form === "toggle" && on.on && on.offer.name === "Goblin 1");
    const off = offers(view, castFrom(castFrom(draft("cone"), "g1", view.tokens, FPC), null, view.tokens, FPC), null, DANA);
    assert.ok(off.form === "toggle" && !off.on, "the toggle stays for that area");
  });

  test("two offers that would read the same are numbered, the area's caster included", () => {
    const view = table({ t2: token("t2", { kind: "monster", name: "Thorn", x: 20, y: 3 }) });
    const chip = offers(view, castFrom(draft("cone"), "t2", view.tokens, FPC), "t");
    assert.ok(chip.form === "chip" && names(chip.offers).join() === "Thorn,Thorn 2");
  });
});

describe("on and off while placing (3.4)", () => {
  const view = table();
  const tokens = view.tokens;
  const on = (d: AreaDraft) => castFrom(d, "t", tokens, FPC);
  const off = (d: AreaDraft) => castFrom(d, null, tokens, FPC);

  test("a cone or line starts at the caster's edge keeping its aim, and off stays where it stands", () => {
    for (const shape of ["cone", "line"] as const) {
      const d = on(draft(shape, { point: { x: 20, y: 20, z: 0 }, yaw: 90, pitch: shape === "cone" ? 10 : 0 }));
      assert.equal(d.fromId, "t");
      assert.equal(d.casterId, "t");
      assert.equal(d.point, null);
      assert.equal(d.yaw, 90);
      const placed = draftTemplate(d, tokens, FPC)!;
      const free = off(d);
      assert.equal(free.fromId, undefined);
      assert.equal(free.casterId, undefined);
      assert.equal(free.lastCaster, "t");
      assert.deepEqual(draftTemplate(free, tokens, FPC)!.origin, placed.origin, "the free one stands where the cast one did");
    }
  });

  test("a cube from the caster's edge, and a cube spell placed at a point stays there with the caster recorded", () => {
    const cube = on(draft("cube", { point: { x: 20, y: 20, z: 0 } }));
    assert.equal(cube.fromId, "t");
    assert.equal(cube.point, null);
    const centered = off(cube);
    assert.ok(centered.point, "free, centered where it stood");
    const entangle = presetDraft(spell("Entangle"), draft("cube", { point: { x: 20, y: 20, z: 0 } }), undefined);
    const cast = on(entangle);
    assert.equal(cast.fromId, undefined);
    assert.equal(cast.casterId, "t");
    assert.deepEqual(cast.point, entangle.point);
    assert.deepEqual(off(cast).point, entangle.point);
  });

  test("an emanation surrounds the caster, and off keeps the square it surrounded", () => {
    const aura = on(draft("emanation", { point: { x: 20, y: 20, z: 0 } }));
    assert.equal(aura.fromId, "t");
    assert.equal(aura.attached, true, "Moves with token on for a new area");
    const free = off(aura);
    assert.equal(free.fromId, undefined);
    assert.ok(free.footprint, "the token's footprint kept");
    assert.deepEqual(draftTemplate(free, tokens, FPC)!.origin, draftTemplate(aura, tokens, FPC)!.origin);
  });

  test("Ice Knife keeps its target either way", () => {
    const knife = presetDraft(spell("Ice Knife"), draft("sphere"), undefined);
    const aimed = { ...knife, fromId: "g1" };
    const cast = on(aimed);
    assert.equal(cast.fromId, "g1");
    assert.equal(cast.casterId, "t");
    const dropped = off(cast);
    assert.equal(dropped.fromId, "g1");
    assert.equal(dropped.casterId, undefined);
    assert.equal(dropped.lastCaster, "t");
  });

  test("a sphere or cylinder stays where it is placed, or waits, with the caster recorded", () => {
    for (const shape of ["sphere", "cylinder"] as const) {
      const placed = on(draft(shape, { point: { x: 20, y: 20, z: 0 } }));
      assert.deepEqual(placed.point, { x: 20, y: 20, z: 0 });
      assert.equal(placed.casterId, "t");
      assert.equal(on(draft(shape)).point, null);
      assert.deepEqual(off(placed).point, placed.point);
      assert.equal(off(placed).casterId, undefined);
    }
  });
});

describe("a creature that leaves while an area is placed (3.3)", () => {
  const tokens = table().tokens;
  const on = (d: AreaDraft) => castFrom(d, "t", tokens, FPC);

  test("the active caster of a cone: no caster, no origin, waiting for a tap", () => {
    const d = withoutCreature(on(draft("cone")), "t");
    assert.equal(d.casterId, undefined);
    assert.equal(d.fromId, undefined);
    assert.equal(d.lastCaster, undefined);
    assert.equal(draftTemplate(d, tokens, FPC), null);
  });

  test("of a sphere or an Entangle cube: no caster, the area stays", () => {
    const sphere = withoutCreature(on(draft("sphere", { point: { x: 9, y: 9, z: 0 } })), "t");
    assert.deepEqual(sphere.point, { x: 9, y: 9, z: 0 });
    assert.equal(sphere.casterId, undefined);
    const entangle = withoutCreature(on(presetDraft(spell("Entangle"), draft("cube", { point: { x: 9, y: 9, z: 0 } }), undefined)), "t");
    assert.deepEqual(entangle.point, { x: 9, y: 9, z: 0 });
    assert.equal(entangle.casterId, undefined);
  });

  test("Ice Knife's caster: the target stays. Its target: the caster stays, on", () => {
    const knife = on({ ...presetDraft(spell("Ice Knife"), draft("sphere"), undefined), fromId: "g1" });
    const noCaster = withoutCreature(knife, "t");
    assert.equal(noCaster.fromId, "g1");
    assert.equal(draftCaster(noCaster), null);
    const noTarget = withoutCreature(knife, "g1");
    assert.equal(noTarget.fromId, undefined);
    assert.equal(fromShows({ draft: noTarget, saved: null }), "t", "From stays on with its caster");
  });

  test("an Ice Knife on a goblin with From off: only the offer to turn Thorn back on goes", () => {
    const off = castFrom(on({ ...presetDraft(spell("Ice Knife"), draft("sphere"), undefined), fromId: "g1" }), null, tokens, FPC);
    const after = withoutCreature(off, "t");
    assert.deepEqual(after, (({ lastCaster: _, ...rest }) => rest)(off));
    assert.equal(after.fromId, "g1", "still around the goblin");
    assert.equal(withoutCreature(after, "t"), after, "nothing to clear is the same draft");
  });

  test("every creature no longer on the scene goes at once", () => {
    const knife = on({ ...presetDraft(spell("Ice Knife"), draft("sphere"), undefined), fromId: "g1" });
    assert.deepEqual(withoutDeparted(knife, (id) => id !== "t" && id !== "g1"), (({ casterId: _c, fromId: _f, lastCaster: _l, ...rest }) => rest)(knife));
    assert.equal(withoutDeparted(knife, () => true), knife);
  });
});

describe("a tap on a token while placing (3.5)", () => {
  const view = table({ pip });
  const tokens = view.tokens;
  const base = { tokens, snap: "15" as const, chunks: {}, sceneId: "s1", feetPerCell: FPC };
  const fromThorn = (shape: AreaDraft["shape"]) => castFrom(draft(shape), "t", tokens, FPC);

  test("with your creature casting, another token aims a cone, line or edge cube at its center, and the caster grabs the aim", () => {
    for (const shape of ["cone", "line", "cube"] as const) {
      assert.equal(tokenTap(fromThorn(shape), "g1", true), "aim", shape);
      assert.equal(tokenTap(fromThorn(shape), "pip", true), "aim", `${shape}, at Pip`);
      assert.equal(tokenTap(fromThorn(shape), "t", true), "grab", shape);
    }
    const r = tappedToken({ ...base, draft: fromThorn("cone"), token: tokens.g1!, yours: true });
    assert.equal(r.draft.fromId, "t", "still from Thorn");
    assert.equal(r.draft.yaw, 0, "toward the goblin, east");
    assert.deepEqual(r.gesture, { kind: "aim", pivot: { x: 3.5, y: 3.5 } }, "a drag from that press keeps aiming");
    const up = tappedToken({ ...base, draft: fromThorn("cone"), token: token("n", { x: 3, y: 0 }), yours: true });
    assert.equal(up.draft.yaw, 270);
  });

  test("Entangle with Thorn as caster centers on the tapped token, fresh or standing elsewhere, and a drag moves it", () => {
    const fresh = castFrom(presetDraft(spell("Entangle"), draft("cube"), undefined), "t", tokens, FPC);
    const elsewhere = { ...fresh, point: { x: 30, y: 30, z: 0 } };
    for (const d of [fresh, elsewhere]) {
      for (const tapped of ["g1", "t"]) {
        assert.equal(tokenTap(d, tapped, true), "center");
        const r = tappedToken({ ...base, draft: d, token: tokens[tapped]!, yours: true });
        const t = tokens[tapped]!;
        // Entangle is 20 ft, four cells, so it centers on the grid line through the token's middle.
        assert.deepEqual(r.draft.point, { x: Math.round(t.x + 0.5), y: Math.round(t.y + 0.5), z: 0 });
        assert.equal(r.draft.casterId, "t");
        assert.equal(r.draft.fromId, undefined);
        assert.deepEqual(r.gesture, { kind: "center" });
      }
    }
  });

  test("a sphere goes on the token, an emanation stays around its caster, and Ice Knife picks its target", () => {
    for (const yours of [true, false]) assert.equal(tokenTap(fromThorn("sphere"), "g1", yours), "place");
    assert.equal(tokenTap(fromThorn("emanation"), "g1", true), "stay");
    const knife = castFrom(presetDraft(spell("Ice Knife"), draft("sphere"), undefined), "t", tokens, FPC);
    assert.equal(tokenTap(knife, "g1", true), "target");
    assert.equal(tappedToken({ ...base, draft: knife, token: tokens.g1!, yours: true }).draft.fromId, "g1");
  });

  test("with no caster, someone else's, or for the DM, a tap casts from the token, as it always has", () => {
    for (const shape of ["cone", "line", "cube", "emanation"] as const) {
      assert.equal(tokenTap(draft(shape), "g1", false), "cast", shape);
      assert.equal(tokenTap(castFrom(draft(shape), "g1", tokens, FPC), "g2", false), "cast", `${shape} from a goblin`);
    }
    const r = tappedToken({ ...base, draft: draft("cone", { point: { x: 9, y: 9, z: 0 } }), token: tokens.g1!, yours: false });
    assert.equal(r.draft.fromId, "g1");
    assert.equal(r.draft.casterId, "g1");
    assert.equal(r.draft.lastCaster, "g1");
    assert.equal(r.draft.point, null);
    assert.equal(tokenTap(castFrom(draft("cone"), "g1", tokens, FPC), "g1", false), "grab");
    assert.equal(tokenTap(castFrom(draft("emanation"), "g1", tokens, FPC), "g1", false), "stay");
  });
});

describe("rebuilt drafts keep the caster (3.4)", () => {
  const tokens = table({ pip }).tokens;

  test("off, a shape change, on: from the same creature. Off, a spell, on: the same", () => {
    const off = castFrom(castFrom(draft("cone"), "t", tokens, FPC), null, tokens, FPC);
    for (const rebuilt of [withShape(off, "line"), withShape(off, "sphere"), presetDraft(spell("Burning Hands"), off, draftCaster(off) ?? undefined)]) {
      assert.equal(draftCaster(rebuilt), null, "still off");
      assert.equal(rebuilt.lastCaster, "t");
    }
  });

  test("a shape change from Ice Knife starts from its caster, not from its target", () => {
    const knife = castFrom({ ...presetDraft(spell("Ice Knife"), draft("sphere"), undefined), fromId: "g1" }, "t", tokens, FPC);
    const cone = withShape(knife, "cone");
    assert.equal(cone.fromId, "t");
    assert.equal(cone.casterId, "t");
  });

  test("Ice Knife's target never becomes its caster: From off, or its caster deleted, then any other shape stays off", () => {
    const knife = castFrom({ ...presetDraft(spell("Ice Knife"), draft("sphere"), undefined), fromId: "g1" }, "t", tokens, FPC);
    const off = castFrom(knife, null, tokens, FPC);
    const gone = withoutCreature(knife, "t");
    for (const [label, d, last] of [["From off", off, "t"], ["its caster deleted", gone, undefined]] as const) {
      // Ice Knife is an emanation already, so every other shape.
      for (const shape of ["cone", "line", "cube", "sphere", "cylinder"] as const) {
        const next = withShape(d, shape);
        assert.equal(draftCaster(next), null, `${label}, to a ${shape}: still off`);
        assert.equal(next.casterId, undefined, `${label}, to a ${shape}`);
        assert.equal(next.fromId, undefined, `${label}, to a ${shape}: never cast from the goblin`);
        assert.equal(next.lastCaster, last, `${label}, to a ${shape}: the one to turn on again`);
        assert.equal(draftTemplate(next, tokens, FPC), null, `${label}, to a ${shape}: waits for a tap`);
      }
    }
  });

  test("Ice Knife placed with From off copies as a target with no caster, and its template names no caster", () => {
    const off = castFrom(castFrom({ ...presetDraft(spell("Ice Knife"), draft("sphere"), undefined), fromId: "g1" }, "t", tokens, FPC), null, tokens, FPC);
    const placed = draftTemplate(off, tokens, FPC)!;
    assert.equal(placed.casterId, undefined);
    assert.equal(placed.attachedTo, "g1");
    const copy = draftFromTemplate(template("k", { shape: "emanation", size: 5, attachedTo: "g1", origin: placed.origin }), "c", tokens, FPC);
    assert.equal(copy.targetsOther, true);
    assert.equal(copy.fromId, "g1");
    assert.equal(draftCaster(copy), null, "From off on the copy too");
    assert.equal(fromShows({ draft: copy, saved: "t" }), null);
    const withCaster = draftFromTemplate(template("k2", { shape: "emanation", size: 5, attachedTo: "g1", casterId: "t", origin: placed.origin }), "c2", tokens, FPC);
    assert.equal(withCaster.targetsOther, true);
    assert.equal(draftCaster(withCaster), "t");
    const aura = draftFromTemplate(template("k3", { shape: "emanation", size: 10, attachedTo: "t", casterId: "t", origin: placed.origin }), "c3", tokens, FPC);
    assert.equal(aura.targetsOther, false, "an aura around its own caster is no target");
    assert.equal(draftCaster(aura), "t");
  });

  test("a target emanation that stays put still never names its target as caster", () => {
    const knife = { ...presetDraft(spell("Ice Knife"), draft("sphere"), undefined), fromId: "g1", attached: false };
    assert.equal(draftTemplate(knife, tokens, FPC)!.casterId, undefined);
    assert.equal(draftTemplate({ ...knife, casterId: "t" }, tokens, FPC)!.casterId, "t");
  });

  /**
   * Random runs of on, off, a shape change, a spell, a tap on a token and a
   * creature deleted, checking after each step what must always hold: the
   * control never names a creature that is gone, on names the creature
   * turned on, off names no one and keeps the one to turn on again, a
   * rebuilt draft keeps both, and a tap never takes the caster from your
   * creature.
   */
  test("random runs of on, off, shapes, spells, taps and departures", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const shapes = ["cone", "line", "cube", "sphere", "cylinder", "emanation"] as const;
    const spells = ["Burning Hands", "Fireball", "Entangle", "Ice Knife", "Spirit Guardians", "Thunderwave", "Lightning Bolt", "Moonbeam"].map(spell);
    for (let run = 0; run < 300; run++) {
      const present = new Set(["t", "pip", "g1", "g2"]);
      let d = draft(shapes[rand(shapes.length)]!);
      for (let step = 0; step < 25; step++) {
        const ids = [...present];
        const kind = rand(6);
        const before = d;
        if (kind === 0 && ids.length > 0) {
          const id = ids[rand(ids.length)]!;
          d = castFrom(d, id, tokens, FPC);
          assert.equal(draftCaster(d), id, "on names the creature turned on");
          assert.equal(d.lastCaster, id);
        } else if (kind === 1) {
          d = castFrom(d, null, tokens, FPC);
          assert.equal(draftCaster(d), null, "off names no one");
          assert.equal(d.lastCaster, before.lastCaster, "and keeps the one to turn on again");
        } else if (kind === 2) {
          d = withShape(d, shapes[rand(shapes.length)]!);
          assert.equal(d.lastCaster, before.lastCaster);
          assert.equal(draftCaster(d), draftCaster(before), "a shape change keeps the caster, and never makes Ice Knife's target one");
        } else if (kind === 3) {
          d = presetDraft(spells[rand(spells.length)]!, d, draftCaster(d) ?? undefined);
          assert.equal(d.casterId ?? null, draftCaster(before), "a spell takes the area's caster, never another");
          assert.equal(d.lastCaster, draftCaster(before) ?? before.lastCaster);
        } else if (kind === 4 && ids.length > 0) {
          const id = ids[rand(ids.length)]!;
          const yours = draftCaster(d) === "t" || draftCaster(d) === "pip";
          d = tappedToken({ draft: d, token: tokens[id]!, yours, tokens, snap: "15", chunks: {}, sceneId: "s1", feetPerCell: FPC }).draft;
          if (yours && !before.targetsOther) assert.equal(draftCaster(d), draftCaster(before), "a tap never takes the caster from your creature");
        } else if (ids.length > 0) {
          const id = ids[rand(ids.length)]!;
          present.delete(id);
          d = withoutDeparted(d, (x) => present.has(x));
        }
        for (const ref of [d.casterId, d.fromId, d.lastCaster]) if (ref !== undefined) assert.ok(present.has(ref), `no reference to a gone creature (${ref}, step ${step} of run ${run})`);
      }
    }
  });
});
