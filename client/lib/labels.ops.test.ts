import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState } from "#shared/model.ts";
import { castAsk, character, numbered, room, template, token } from "#shared/testutil.ts";
import { castStart } from "../features/dice/cast/castStart.ts";
import type { DiceView } from "../features/dice/creature.ts";
import { closeTheAsk, mark, newPage, roll, type Command, type ServerRoll } from "../features/dice/groupSave/chain.ts";
import { buildPlan } from "../features/dice/groupSave/plan.ts";
import { groupRows } from "../features/dice/groupSave/rows.ts";
import { addCandidates } from "../features/encounter/logic.ts";
import { duplicateToken } from "../features/tokens/factory.ts";
import { fightOps } from "../features/tokens/groupEdit.ts";
import { hpOps, hpTargets } from "../features/tokens/groupHp.ts";
import { labelsFor, labelSuffix, labelText, type Labels } from "./labels.ts";
import { displayName } from "./scene.ts";

/*
 * The ops a DM's screens build from creatures the label map names (the
 * creature numbers design, section 4): a cast's group save, whose caster
 * the map names in brackets, group HP, a fight's rows and a duplicate.
 * With brackets on the DM's board, no op holds a bracketed number or a
 * disguise's bracketed name as the board shows them. A name that holds
 * brackets of its own, "Goblin (Captain)", is a name like any other.
 */

const AT = "2026-11-10T20:00:00.000Z";

/**
 * Goblins 1 and 2 met. Goblins `g3` and `g4` and an Orc shown as a Goblin
 * not yet met, so the DM's board reads them "Goblin (3)", "Goblin (4)" and
 * "Orc (as Goblin (5))". `g3` casts Fireball at area `a1`, which Thorn,
 * p1's character, stands in. "Goblin (Captain)" has no namesake, so it
 * takes no bracketed number.
 */
function table(): RoomState {
  return numbered(
    room({
      characters: { "thorn-c": character("thorn-c", { name: "Thorn", ownerIds: ["p1"] }) },
      tokens: {
        thorn: token("thorn", { kind: "pc", name: "Thorn", ownerIds: [], actor: { ref: "thorn-c" }, x: 4, y: 4 }),
        g1: token("g1", { name: "Goblin", number: 1, x: 5, y: 5 }),
        g2: token("g2", { name: "Goblin", number: 2, x: 6, y: 5 }),
        g3: token("g3", { name: "Goblin", ownerIds: ["p1"], x: 7, y: 5 }),
        g4: token("g4", { name: "Goblin", x: 8, y: 5 }),
        orc: token("orc", { name: "Orc", nameHidden: true, publicName: "Goblin", x: 9, y: 5 }),
        cap: token("cap", { name: "Goblin (Captain)", x: 10, y: 5 }),
      },
      templates: { a1: template("a1", { ownerId: "p1", casterId: "g3", spell: "Fireball" }) },
    }),
  );
}

/** Every bracketed text the DM's board shows: each such label whole, and a disguise's bracket alone. */
function shownPreviews(view: RoomState, labels: Labels): string[] {
  const out: string[] = [];
  for (const t of Object.values(view.tokens)) {
    const label = labels.get(t.id);
    if (!label || label.preview === undefined) continue;
    out.push(labelText(label));
    if (label.as !== undefined) out.push(labelSuffix(label).trim());
  }
  return out;
}

function holdsNone(ops: readonly unknown[], shown: readonly string[], what: string): void {
  assert.ok(ops.length > 0, `${what}: built an op to read`);
  for (const op of ops) {
    const text = JSON.stringify(op);
    for (const words of shown) assert.ok(!text.includes(words), `${what}: ${text.slice(0, 300)} holds ${JSON.stringify(words)}`);
  }
}

const opsOf = (send: readonly Command[]) => send.map((c) => (c.kind === "dice" ? c.rolls : c.op));

describe("ops a DM's screens build hold no bracketed number", () => {
  const view = table();
  const labels = labelsFor(view, "dm");
  const shown = shownPreviews(view, labels);
  const dice: DiceView = { you: { memberId: "dm1", role: "dm" }, view, srd: { monsters: [], rolls: {} } };

  test("the DM's board shows the brackets the ops are read for, and none on a name that holds its own", () => {
    assert.deepEqual(shown, ["Goblin (3)", "Goblin (4)", "Orc (as Goblin (5))", "(as Goblin (5))"]);
    assert.equal(displayName(view.tokens.cap!, labels), "Goblin (Captain)");
  });

  test("a cast's group save, from its rolls and requests to its outcome and the ask's close, though its card names the caster in brackets", () => {
    const input = castStart(dice, castAsk("k1", { caster: "g3", area: "a1", at: AT }), labels);
    assert.ok(input.cast?.who.includes("Goblin (3)"), "the card names the caster as the board does");
    let page = newPage({
      id: "page",
      sceneId: "s1",
      source: input.source,
      test: input.test,
      dc: 15,
      secret: false,
      spell: input.spell ?? false,
      switches: { dcShown: true, resultShown: true },
      fill: input.fill ?? null,
      ...(input.outcome ? { outcome: { ...input.outcome, damage: "9 fire" } } : { outcome: { damage: "9 fire" } }),
      ...(input.cast ? { cast: input.cast } : {}),
    });
    const ids = ["thorn", "g4", "orc", "cap"];
    const rows = groupRows(dice, ids, page.test, page.spell, labels);
    assert.ok(rows.some((r) => r.name === "Goblin (4)"), "the rows name creatures as the board does");
    const server: ServerRoll[] = rows.filter((r) => !("characterId" in r.target)).map((r) => ({ holder: r.holder, target: r.target, bonus: 1, sources: [], extra: [] }));
    let n = 0;
    const rolled = roll(page, { rows, server, tag: "t1", requestIds: () => `0199f0a0-0000-7000-8000-${String(++n).padStart(12, "0")}`, openRequests: 0, taken: [], at: AT });
    assert.equal(rolled.error, undefined);
    holdsNone(opsOf(rolled.send), shown, "the save's rolls and request");
    page = rolled.page;
    for (const r of rows) page = mark(page, r.holder, "fail");
    const plan = buildPlan(page, dice, [{ amount: 9, type: "fire" }], { plan: "0199f0a0-0000-7000-8000-0000000000a1", newId: () => `0199f0a0-0000-7000-8000-${String(++n).padStart(12, "0")}` });
    assert.ok(plan, "the outcome is built");
    holdsNone([plan], shown, "the outcome");
    holdsNone(opsOf(closeTheAsk(page).send), shown, "the ask's close");
  });

  test("group HP, a fight's rows and a duplicate, built from creatures the board names in brackets", () => {
    const targets = hpTargets(["g3", "g4", "orc", "cap"].map((id) => view.tokens[id]!), { role: "dm", memberId: "dm1", characters: view.characters, playersApplyDamage: false, labels });
    assert.ok(targets.some((t) => t.name === "Orc (as Goblin (5))"), "the targets name creatures as the board does");
    holdsNone(hpOps(targets, { kind: "damage", amount: 5 }, false), shown, "group HP");
    let n = 0;
    const candidates = addCandidates(view, "s1", "scene", null, labels);
    holdsNone(fightOps(candidates, null, () => `0199f0a0-0000-7000-8000-${String(++n).padStart(12, "0")}`), shown, "a fight's rows");
    const copies = ["g3", "orc", "cap"].map((id) => ({ t: "token.create", token: duplicateToken(view.tokens[id]!, { id: `copy-${id}`, at: { x: 12, y: 5 }, chunks: view.buildChunks }) }));
    holdsNone(copies, shown, "duplicates");
    assert.ok(JSON.stringify(copies).includes("Goblin (Captain)"), "a name's own brackets go out as the name");
  });
});
