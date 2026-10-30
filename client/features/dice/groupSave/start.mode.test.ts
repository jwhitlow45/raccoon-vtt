import assert from "node:assert/strict";
import { test } from "node:test";
import { quickRollNow } from "./start.ts";
import { newPage, replace, restoredPage, roll, rollSettled } from "./chain.ts";
import { advantageFields } from "#shared/dice/formula.ts";
import type { RowBase } from "./rows.ts";
import { pick, rng } from "#shared/testutil.ts";

for (const override of ["adv", "dis", "normal", "secret"] as const) test(`quick ${override} freezes its choices and initializes the fresh switch`, () => {
  const taken = { sources: [{ kind: "dis" as const, from: "pressed" }], secret: false };
  const frozen = structuredClone(taken);
  const invocation = quickRollNow(taken, true, override);
  assert.deepEqual(taken, frozen);
  assert.equal(invocation.secret, override === "secret" || override === "normal");
  assert.deepEqual(invocation.sources, override === "normal" ? [] : override === "secret" ? taken.sources : [{ kind: override, from: "roll-menu" }]);
});

test("seeded replacement, keep, reload and mixed-ask sequences isolate every invocation", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const random = rng(seed);
    let page = newPage({ id: "old", sceneId: "s", source: { kind: "selection", tokenIds: [] }, test: { kind: "save", ability: "dex" }, dc: 15, secret: false, spell: false, switches: { dcShown: false, resultShown: true } });
    const monster: RowBase = { holder: "token:g", target: { tokenId: "g" }, tokenId: "g", name: "Guard", ways: ["server"], bonus: 3, skip: false };
    const player: RowBase = { ...monster, holder: "character:p", tokenId: "p", target: { characterId: "p" }, askRef: { characterId: "p" }, ways: ["ask"] };
    let pending: ReturnType<typeof quickRollNow> | null = null;
    for (let i = 0; i < 100; i++) {
      const before = structuredClone(page);
      const event = pick(random, ["pick", "keep", "reload", "replace", "ask"] as const);
      if (event === "pick") {
        pending = quickRollNow({ sources: [{ kind: "dis", from: "pressed" }], secret: false }, true, pick(random, ["adv", "dis", "secret", "normal"] as const));
        assert.deepEqual(page, before, "pending confirmation never edits the existing page");
      } else if (event === "keep") pending = null;
      else if (event === "reload") {
        page = restoredPage(JSON.parse(JSON.stringify(page)) as typeof page);
        pending = null;
        assert.deepEqual(page, before, "reload retains only the created page's existing shape");
      } else if (event === "replace" && pending) {
        const invocation: ReturnType<typeof quickRollNow> = pending;
        assert.ok(replace(page).ok);
        page = newPage({ ...page, id: `p${seed}-${i}`, secret: invocation.secret, rollNow: { sources: invocation.sources } });
        pending = null;
        assert.equal(page.secret, invocation.secret, "the fresh visible switch matches the invocation");
        assert.deepEqual(page.rollNow?.sources, invocation.sources);
        assert.equal("override" in page, false, "no new stored menu state");
      } else if (event === "ask") {
        const override = pick(random, ["adv", "dis", "secret", "normal"] as const);
        const step = roll(page, { rows: [monster, player], server: [{ holder: monster.holder, target: monster.target, bonus: 3, sources: [{ kind: "dis", from: "restrained" }], extra: ["+1d4"] }], tag: `tag${seed}-${i}`, requestIds: () => `ask${seed}-${i}`, openRequests: 0, taken: [{ kind: "adv", from: "pressed" }], at: "now", override });
        assert.equal(step.page.secret, before.secret, "an existing page's baseline survives every invocation");
        if (before.phase !== "setup") assert.equal(step.send.length, 0, "reloads and repeated actions never repeat the initial roll");
        for (const command of step.send) {
          if (command.kind === "dice") {
            assert.equal(command.to, override === "secret" || before.secret ? "dm" : "all");
            assert.deepEqual(advantageFields(command.rolls[0]!.sources ?? []), override === "adv" || override === "secret" ? { cancelled: true } : { mode: "dis" });
          } else if (command.kind === "op" && command.op.t === "roll.ask") {
            assert.equal("mode" in command.op.request, false, "future answers have no invocation mode");
            assert.deepEqual(command.op.request.targets, [player.askRef]);
          }
        }
        page = step.page;
        if (page.rolls.length > 0) page = rollSettled(page, page.rolls.at(-1)!.tag, pick(random, [{ state: "unknown" as const }, { state: "refused" as const, says: "No" }]), (target) => target.tokenId ? `token:${target.tokenId}` : `character:${target.characterId}`);
        assert.equal(page.secret, before.secret, "late refusal and unknown receipts preserve the original envelope");
      }
    }
  }
});
