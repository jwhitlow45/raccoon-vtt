import assert from "node:assert/strict";
import { test } from "node:test";
import { advantageFields } from "#shared/dice/formula.ts";
import { newPage, roll, rollAgain, type ServerRoll } from "./chain.ts";
import type { RowBase } from "./rows.ts";

const monster: RowBase = { holder: "t:g", tokenId: "g", target: { tokenId: "g" }, name: "Guard", bonus: 2, ways: ["server"], skip: false };
const player: RowBase = { ...monster, holder: "c:p", tokenId: "p", target: { characterId: "p" }, askRef: { characterId: "p" }, ways: ["ask"] };
const server: ServerRoll = { holder: monster.holder, target: monster.target, bonus: 2, sources: [{ kind: "dis", from: "restrained" }], extra: ["+1d4"] };
const page = () => newPage({ id: "p", sceneId: "s", source: { kind: "selection", tokenIds: ["g", "p"] }, test: { kind: "save", ability: "dex" }, dc: 17, secret: false, spell: true, switches: { dcShown: false, resultShown: false }, fill: { name: "Hidden blades", publicName: "Trap", from: "Trap" } });

for (const override of ["adv", "dis", "secret", "normal"] as const) test(`one-roll group ${override} retains the page and isolates asks`, () => {
  const before = page();
  const step = roll(before, { rows: [monster, player], server: [server], tag: "dice", requestIds: () => "ask", openRequests: 0, taken: [{ kind: "adv", from: "pressed" }], at: "now", override });
  assert.equal(step.page.secret, false);
  assert.equal(step.page.rollNow, undefined);
  const dice = step.send.find((c) => c.kind === "dice");
  assert.ok(dice?.kind === "dice");
  assert.equal(dice.to, override === "secret" ? "dm" : "all");
  assert.equal(dice.dc, override === "secret" ? 17 : undefined);
  assert.match(dice.rolls[0]!.label!, override === "secret" ? /Hidden blades/ : /^Trap,/);
  assert.equal(dice.rolls[0]!.formula, "1d20+2+1d4");
  assert.deepEqual(advantageFields(dice.rolls[0]!.sources ?? []), override === "adv" || override === "secret" ? { cancelled: true } : { mode: "dis" });
  const ask = step.send.find((c) => c.kind === "op");
  assert.ok(ask?.kind === "op" && ask.op.t === "roll.ask");
  assert.equal(ask.op.request.note, "Trap");
  assert.equal("mode" in ask.op.request, false);
  const retry = rollAgain({ ...step.page, states: { ...step.page.states, [monster.holder]: { way: "server", status: "unknown" } } }, { holders: [monster.holder], server: [server], tag: "retry", override });
  const sent = retry.send[0];
  assert.ok(sent?.kind === "dice");
  assert.equal(sent.to, override === "secret" ? "dm" : "all");
  assert.deepEqual(advantageFields(sent.rolls[0]!.sources ?? []), override === "adv" ? { cancelled: true } : { mode: "dis" });
  assert.equal(retry.page.secret, false);
});
