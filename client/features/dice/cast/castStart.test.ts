import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CastAsk, PcStats, RoomState } from "#shared/model.ts";
import { ASK_CLOSED } from "#shared/permissions.ts";
import { castAsk, castTable, character, template } from "#shared/testutil.ts";
import type { DiceView } from "../creature.ts";
import { castSeen, closeSettled, closeTheAsk, CLOSED_UNREAD, damageSent, newPage, RESOLVED_ELSEWHERE, restoredPage, settleTag, type Page } from "../groupSave/chain.ts";
import { amountsOf } from "../groupSave/plan.ts";
import { holdsRolls, sentAny } from "../groupSave/start.ts";
import { castCardText, castFill, castStart, castWho, deskAsks, foldedWithAsks, readingWords } from "./castStart.ts";

/** The group save a player's ask opens (docs/design-v1-player-save-spell.md 3.3 and 8). */

const LONG = "Searing Breath of the Ancient Brass Dragon Matriarch Unbound";

const THORN: PcStats = {
  abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
  saves: ["int", "wis"],
  skills: {},
  spellAbility: "int",
  adjust: {},
  defenses: {},
  rolls: [
    { id: "fb", name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] },
    { id: "hp", name: "Hold Person", kind: "spell", ability: "spell", level: 2, save: { ability: "wis" }, dice: [] },
    { id: "long", name: LONG, kind: "spell", ability: "spell", level: 1, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "4d6", type: "fire" }, { formula: "2d8", type: "radiant" }] },
  ],
};

function view(): RoomState {
  const base = castTable();
  return { ...base, characters: { ...base.characters, "thorn-c": character("thorn-c", { name: "Thorn", ownerIds: ["p1"], level: 7, stats: THORN }) } };
}
const dice = (v: RoomState = view()): DiceView => ({ you: { memberId: "dm1", role: "dm" }, view: v, srd: { monsters: [], rolls: {} } });
const ROLLED_31 = { damage: { tag: "r1", parts: 1 }, rolled: [{ formula: "9d6", total: 31, type: "fire" as const }] };

function pageOf(ask: CastAsk, d: DiceView = dice()): Page {
  const input = castStart(d, ask);
  return newPage({
    id: "page",
    sceneId: ask.sceneId,
    source: input.source,
    test: input.test,
    dc: input.dc,
    secret: true,
    spell: input.spell ?? false,
    switches: { dcShown: false, resultShown: true },
    fill: input.fill ?? null,
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.cast ? { cast: input.cast } : {}),
    ...(input.damage ? { damage: input.damage } : {}),
  });
}

describe("the group save an ask opens", () => {
  test("an area ask: its area followed in the Areas panel, filled as the area's Save and damage with the ask's caster, at its level, with the caster's roll", () => {
    // The area names no caster, so the ask's caster gives the DC and the dice.
    const v = view();
    v.templates.a1 = template("a1", { ownerId: "p1", spell: "Fireball" });
    const input = castStart(dice(v), castAsk("k1", { slot: 4, ...ROLLED_31 }));
    assert.deepEqual(input.source, { kind: "area", templateId: "a1" });
    assert.equal(input.panel, "areas");
    assert.deepEqual([input.test, input.dc, input.spell], [{ kind: "save", ability: "dex" }, 15, true]);
    assert.equal(input.outcome?.damage, "9d6 Fire");
    assert.equal(input.outcome?.slot, 4);
    assert.equal(input.fill?.caster, "thorn");
    assert.equal(input.fill?.from, "From Thorn's Fireball at level 4: Dexterity save, DC 15 (Thorn's spell save DC), 9d6 Fire, rolled 31 (Thorn's roll), half on a pass.");
    assert.deepEqual(input.damage, { tag: "r1", state: "committed", amounts: [31], imported: true });
    assert.equal(input.cast?.who, "Thorn");
    assert.equal(input.cast?.ask.id, "k1");
  });

  test("a targets ask: its tokens, never the DM's selection, in the Dice panel, filled from the caster's row at the level", () => {
    const input = castStart(dice(), castAsk("k2", { area: undefined, targets: ["g1", "g2"], roll: "hp", spell: "Hold Person", slot: 3 }));
    assert.deepEqual(input.source, { kind: "selection", tokenIds: ["g1", "g2"] });
    assert.equal(input.panel, "dice");
    assert.deepEqual([input.test, input.dc, input.outcome?.slot, input.outcome?.damage], [{ kind: "save", ability: "wis" }, 15, 3, ""]);
    assert.equal(input.fill?.from, "From Thorn's Hold Person at level 3: Wisdom save, DC 15 (Thorn's spell save DC).");
    assert.equal(input.damage, undefined, "no roll, nothing seeded");
  });

  test("a targets Fireball scales its dice at the level, as the row does", () => {
    const filled = castFill(dice(), castAsk("k3", { area: undefined, targets: ["g1"], roll: "fb", slot: 5 }));
    assert.deepEqual([filled.input.outcome.damage, filled.input.outcome.slot], ["10d6 Fire", 5]);
  });

  test("a rider of another type on: the field is the roll's own parts and types, each part's amount seeded", () => {
    const filled = castFill(dice(), castAsk("k4", { slot: 3, damage: { tag: "r2", parts: 2 }, rolled: [{ formula: "8d6", total: 31, type: "fire" }, { formula: "2d8", total: 9, type: "radiant" }] }));
    assert.equal(filled.input.outcome.damage, "8d6 Fire + 2d8 Radiant");
    assert.deepEqual(filled.damage, { tag: "r2", state: "committed", amounts: [31, 9], imported: true });
    assert.match(filled.input.fill.from, /8d6 Fire \+ 2d8 Radiant, rolled 31 \+ 9 \(Thorn's roll\), half on a pass\.$/);
    assert.deepEqual(amountsOf({ outcome: filled.input.outcome as Page["outcome"], damage: filled.damage }, filled.input.fill.damageType), [
      { amount: 31, type: "fire" },
      { amount: 9, type: "radiant" },
    ]);
  });

  test("a long-named roll whose label lost its types, or any untyped part among several, imports nothing and says so (SS-O-27)", () => {
    const says = "Thorn's roll could not be read part by part. Roll it here or type it.";
    const untyped = castFill(dice(), castAsk("k5", { area: undefined, targets: ["g1"], roll: "long", spell: LONG.slice(0, 60), slot: 1, damage: { tag: "r3", parts: 2 }, rolled: [{ formula: "4d6", total: 14 }, { formula: "2d8", total: 9 }] }));
    assert.equal(untyped.damage, null);
    assert.equal(untyped.says, says);
    assert.equal(untyped.input.outcome.damage, "4d6 Fire + 2d8 Radiant", "the fill's own formula stays");
    assert.doesNotMatch(untyped.input.fill.from, /rolled/);
    const mixed = castFill(dice(), castAsk("k6", { area: undefined, targets: ["g1"], roll: "long", spell: LONG.slice(0, 60), slot: 1, damage: { tag: "r4", parts: 2 }, rolled: [{ formula: "4d6", total: 14, type: "fire" }, { formula: "2d8", total: 9 }] }));
    assert.deepEqual([mixed.damage, mixed.says], [null, says], "a typed part then an untyped one reads as one part with the next, so nothing goes in");
  });

  test("a lone untyped part takes the fill's type, as a typed 28 does", () => {
    const filled = castFill(dice(), castAsk("k7", { slot: 3, damage: { tag: "r5", parts: 1 }, rolled: [{ formula: "8d6", total: 28 }] }));
    assert.equal(filled.says, null);
    assert.equal(filled.input.outcome.damage, "8d6");
    assert.deepEqual(amountsOf({ outcome: filled.input.outcome as Page["outcome"], damage: filled.damage }, filled.input.fill.damageType), [{ amount: 28, type: "fire" }]);
  });

  test("a slot change refills the formula from the fill and drops the roll", () => {
    const filled = castFill(dice(), castAsk("k8", { slot: 3, ...ROLLED_31 }), 5, { imported: false });
    assert.equal(filled.damage, null);
    assert.equal(filled.input.outcome.damage, "10d6 Fire");
    assert.equal(filled.input.fill.from, "From Thorn's Fireball at level 5: Dexterity save, DC 15 (Thorn's spell save DC), 10d6 Fire, half on a pass.");
  });

  test("the caster's block without that roll fills from the area's preset, else opens on Dexterity with no DC", () => {
    const preset = castFill(dice(), castAsk("k9", { area: undefined, targets: ["g1"], roll: "gone", spell: "Lightning Bolt", slot: 3 }));
    assert.equal(preset.input.fill.name, "Lightning Bolt");
    assert.equal(preset.input.outcome.damage, "8d6 Lightning");
    const bare = castFill(dice(), castAsk("k10", { area: undefined, targets: ["g1"], roll: "gone", spell: "Mystery Bolt", slot: undefined }));
    assert.deepEqual([bare.input.test, bare.input.dc, bare.input.outcome.slot], [{ kind: "save", ability: "dex" }, null, undefined]);
    assert.equal(bare.input.fill.from, "From Thorn's Mystery Bolt: not on Thorn's stat block, so set the save and the damage.");
  });

  test("a row gone or renamed before Open, with no preset, still takes the caster's stored roll (SSB-A-05)", () => {
    const ask = castAsk("k13", { area: undefined, targets: ["g1"], roll: "gone", spell: "Mystery Bolt", slot: undefined, damage: { tag: "r6", parts: 1 }, rolled: [{ formula: "8d6", total: 28, type: "fire" }] });
    const filled = castFill(dice(), ask);
    assert.deepEqual([filled.input.test, filled.input.dc], [{ kind: "save", ability: "dex" }, null], "the DM sets the save");
    assert.equal(filled.input.outcome.damage, "8d6 Fire");
    assert.deepEqual(filled.damage, { tag: "r6", state: "committed", amounts: [28], imported: true });
    assert.equal(filled.says, null);
    assert.equal(filled.input.fill.from, "From Thorn's Mystery Bolt: not on Thorn's stat block, so set the save. 8d6 Fire, rolled 28 (Thorn's roll).");
    assert.deepEqual(castStart(dice(), ask).damage, filled.damage, "Open seeds it");
  });

  test("the seeded roll is left out of holdsRolls and rolledAny until the DM rolls or the page sends anything", () => {
    const page = pageOf(castAsk("k11", { slot: 3, ...ROLLED_31 }));
    assert.equal(page.damage?.imported, true);
    assert.equal(sentAny(page), false);
    assert.equal(holdsRolls(page), false, "opening another ask never asks to discard this one's roll");
    const again = damageSent(page, "dm-roll");
    assert.equal(sentAny(again), true, "Roll again makes it the page's own");
    assert.equal(holdsRolls(again), true);
  });

  test("the draft keeps the amounts through a reload, and a typed amount still wins", () => {
    const page = pageOf(castAsk("k12", { slot: 3, ...ROLLED_31 }));
    const restored = restoredPage(JSON.parse(JSON.stringify(page)) as Page);
    assert.deepEqual(amountsOf(restored, restored.fill?.damageType), [{ amount: 31, type: "fire" }]);
    assert.deepEqual(amountsOf({ ...restored, outcome: { ...restored.outcome, damage: "28 Fire" } }, restored.fill?.damageType), [{ amount: 28, type: "fire" }]);
  });
});

describe("the page and its ask", () => {
  const rolled = (ask: CastAsk, outcome: Partial<Page["outcome"]> = {}): Page => {
    const page = pageOf(ask);
    return { ...page, phase: "rolled", outcome: { ...page.outcome, ...outcome } };
  };

  test("Close the ask closes the page's open requests, then the ask as done, and settles as Applied", () => {
    const page = { ...rolled(castAsk("c1", { area: undefined, targets: ["g1"], roll: "hp", spell: "Hold Person", slot: 2 })), requests: [{ rollId: "q1", holders: ["c:bree-c"], state: "open" as const }] };
    const step = closeTheAsk(page);
    assert.deepEqual(
      step.send.map((c) => (c.kind === "op" ? c.op : null)),
      [
        // The page's own close records no Undo step (docs/design-v1-undo-scope.md 5.3).
        { t: "roll.close", rollIds: ["q1"], reason: "savePage" },
        { t: "cast.close", castId: "c1", end: "done" },
      ],
    );
    assert.equal(step.page.phase, "applying");
    assert.ok(step.page.requests.every((q) => q.state === "closed"));
    assert.deepEqual(closeTheAsk(step.page).send, [], "never twice while it is on its way");
    assert.equal(closeSettled(step.page, { state: "taken" }).phase, "applied");
    const refused = closeSettled(step.page, { state: "refused", says: "The ask was closed meanwhile.", message: ASK_CLOSED });
    assert.deepEqual([refused.phase, refused.applySays], ["rolled", "Thorn's ask was closed meanwhile."]);
  });

  test("an unknown close is settled by the view, or sent again, which the server refuses once the first one landed", () => {
    const sent = closeTheAsk(rolled(castAsk("c2"))).page;
    const unknown = closeSettled(sent, { state: "unknown" });
    assert.equal(unknown.apply, "unknown");
    assert.equal(castSeen(unknown, { present: false, end: "done" }).phase, "applied");
    assert.equal(closeTheAsk(unknown).send.length, 1, "Close the ask again");
    // A reload loses the answer, so a close on its way reads as unknown.
    assert.equal(restoredPage(sent).apply, "unknown");
  });

  test("a withdrawal or a dismissal under the page lets the ask go, and Apply works as a plain group save", () => {
    const page = rolled(castAsk("c3"));
    const withdrawn = castSeen(page, { present: false, end: "withdrawn" });
    assert.equal(withdrawn.cast, undefined);
    assert.equal(withdrawn.castNote, "Thorn withdrew the ask.");
    assert.equal(castSeen(page, { present: false, end: "dismissed" }).castNote, "Another DM set it aside.");
  });

  test("a resolve elsewhere, or an end the page cannot read, stops Apply with the reason, and the ask coming back frees it", () => {
    const page = rolled(castAsk("c4"), { damage: "9 Fire" });
    const done = castSeen(page, { present: false, end: "done" });
    assert.equal(done.cast?.blocked, RESOLVED_ELSEWHERE);
    const pruned = castSeen(page, { present: false, end: null });
    assert.equal(pruned.cast?.blocked, CLOSED_UNREAD);
    assert.deepEqual(closeTheAsk(pruned).send, []);
    assert.equal(castSeen(pruned, { present: true }).cast?.blocked, undefined, "an undo brought it back");
  });

  test("an Apply refused because the ask closed meanwhile reads in the caster's name", () => {
    const page: Page = { ...rolled(castAsk("c5")), phase: "applying", apply: "sending", plan: { t: "actor.outcome", plan: "plan-1", cast: "c5", targets: [{ target: { tokenId: "g1" }, amount: 9 }] } };
    const next = settleTag(page, "plan-1", { state: "refused", says: "The ask was closed meanwhile.", message: ASK_CLOSED }, () => "");
    assert.deepEqual([next.phase, next.applySays], ["rolled", "Thorn's ask was closed meanwhile."]);
    // While its own Apply is on its way, the page leaves the ask's end to the answer.
    assert.equal(castSeen(page, { present: false, end: "done" }), page);
  });
});

describe("the DM's card", () => {
  test("names the ask, the roll and the area's count, with Open and Dismiss named for it", () => {
    const text = castCardText(view(), castAsk("d1", { slot: 4, ...ROLLED_31 }), { viewing: "s1", caught: 4 });
    assert.deepEqual(
      [text.title, text.short, text.rolled, text.where, text.gone, text.open, text.openName, text.dismissName],
      ["Thorn asks for saves: Fireball, level 4", "Thorn asks for saves: Fireball", "Thorn rolled 31 Fire", "In the area: 4", null, "Open", "Open the group save for Thorn's Fireball", "Dismiss Thorn's Fireball"],
    );
  });

  test("a targets ask names its targets, and one with no roll says so", () => {
    const text = castCardText(view(), castAsk("d2", { area: undefined, targets: ["g1", "g2"], spell: "Hold Person", slot: 3 }), { viewing: "s1", caught: null });
    assert.deepEqual([text.rolled, text.where], ["No damage rolled", "Targets: Goblin 1, Goblin 2"]);
    const reversed = castCardText(view(), castAsk("d2", { area: undefined, targets: ["g2", "g1"], spell: "Hold Person" }), { viewing: "s1", caught: null });
    assert.equal(reversed.where, "Targets: Goblin 1, Goblin 2", "by name and number, whatever order the ask holds (LP10-SAVE-3)");
  });

  test("an ask on another scene goes there to open, and only an ask here reads its area or caster as gone", () => {
    const v = view();
    delete v.templates.a1;
    const away = castCardText(v, castAsk("d3"), { viewing: "s2", caught: null });
    assert.deepEqual([away.where, away.gone, away.open], ["On s1", null, "Go to s1 and open"]);
    assert.equal(castCardText(v, castAsk("d3"), { viewing: "s1", caught: null }).gone, "Its area is gone");
    delete v.tokens.thorn;
    assert.equal(castCardText(v, castAsk("d4", { area: undefined, targets: ["g1"] }), { viewing: "s1", caught: null }).gone, "Its caster is gone");
    assert.equal(castWho(v, castAsk("d4")), "p1", "with no token in view, the player who asked");
    assert.equal(readingWords(v, castAsk("d4")), "Reading the caster's stat block…", "Open on its way to the scene names no player's stat block");
    assert.equal(readingWords(view(), castAsk("d4")), "Reading Thorn's stat block…");
    delete v.scenes.s1;
    assert.equal(castCardText(v, castAsk("d5"), { viewing: "s2", caught: null }).gone, "Its scene is gone");
  });

  test("the desk shows the newest first, less the ask the open page holds", () => {
    const casts = { a: castAsk("a", { at: "2026-10-18T10:00:00.000Z" }), b: castAsk("b", { at: "2026-10-18T11:00:00.000Z" }), c: castAsk("c", { at: "2026-10-18T09:00:00.000Z" }) };
    assert.deepEqual(deskAsks(casts, null).map((a) => a.id), ["b", "a", "c"]);
    assert.deepEqual(deskAsks(casts, "a").map((a) => a.id), ["b", "c"]);
  });

  test("the folded button counts the asks beside the requests, its name starting with its text", () => {
    assert.deepEqual(foldedWithAsks(null, 2, "sheet"), { text: "2 asks", label: "2 asks: 2 asks for saves. Close the sheet to see them." });
    const both = foldedWithAsks({ text: "Rolls 1/3", label: "Rolls 1/3: 2 more roll requests, 1 of 3 answered." }, 1, "more")!;
    assert.equal(both.text, "Rolls 1/3, 1 ask");
    assert.ok(both.label.startsWith(both.text));
    assert.equal(both.label, "Rolls 1/3, 1 ask: 1 more ask for saves, 2 more roll requests, 1 of 3 answered.");
    assert.equal(foldedWithAsks(null, 0, "sheet"), null);
  });
});
