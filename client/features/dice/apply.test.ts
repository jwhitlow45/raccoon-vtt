import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { DiceRoll, LogEntry, RoomState, Token } from "#shared/model.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { actor, character, diceLine, room, token } from "#shared/testutil.ts";
import type { OnAnswer, OpRefusal } from "../../state/types.ts";

/*
 * The DM's Apply to chip applies at once and a player's fills their HP
 * entry (QOL audit Q2, D-261106-101 and 174): one op with the roll's parts,
 * busy until its answer, the chip gone from its row once it landed, and a
 * refusal's words in its place.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { ApplyTo } = await import("./ApplyTo.tsx");
const { applyNow, applySlot, APPLY_BUSY, APPLY_GONE, APPLY_UNKNOWN, toastChips } = await import("./apply.ts");
const { createRoomStore } = await import("../../state/store.ts");
const { rollChip } = await import("./targets.ts");

function table(playersApplyDamage = false): RoomState {
  const base = room({
    characters: { "c-thorn": character("c-thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor() }) },
    tokens: {
      g1: token("g1", { name: "Goblin Warrior", number: 1, x: 5, y: 5 }),
      g2: token("g2", { name: "Goblin Warrior", number: 2, x: 4, y: 5 }),
      thorn: token("thorn", { kind: "pc", name: "Thorn", x: 6, y: 5, disposition: "ally", actor: { ref: "c-thorn" } }) as Token,
    },
  });
  return { ...base, meta: { ...base.meta, settings: { ...base.meta.settings, playersApplyDamage } } };
}

const slash = (by: string, extra: Partial<DiceRoll> = {}): LogEntry =>
  diceLine("9:0", "tag", [{ formula: "1d6+2", faces: [4], total: 6, label: "Scimitar damage, Slashing", type: "slashing", tokenId: "g1", ...extra }], { by });

/** An env over a fixed room whose dispatch keeps what it was given, for the test to answer. */
function harness(view: RoomState, you = { memberId: "dm1", role: "dm" as const }) {
  const sent: { op: ClientOp; onAnswer?: OnAnswer; quiet?: boolean }[] = [];
  const marked: string[][] = [];
  const env = {
    room: () => ({ view, you }),
    actions: { dispatch: (op: ClientOp, opts?: { onAnswer?: OnAnswer; quiet?: boolean }) => (sent.push({ op, ...opts }), sent.length), newId: () => "g" },
    applies: applySlot.create(),
    markApplied: (ids: readonly string[]) => void marked.push([...ids]),
  };
  return { env, sent, marked };
}

const thorn = { tokenId: "thorn", holder: "character:c-thorn", name: "Thorn" };

describe("applyNow, the DM's chip", () => {
  test("one quiet actor.hp with the roll's parts, busy until taken, then the creature is applied and Use's chip for the roll goes", async () => {
    const { env, sent, marked } = harness(table());
    const chip = rollChip([slash("dm1")])!;
    const done = applyNow(env, chip, thorn);
    assert.equal(sent.length, 1);
    const op = clientOpSchema.parse(sent[0]!.op);
    assert.deepEqual(op, { t: "actor.hp", target: { tokenId: "thorn" }, change: { kind: "damage", amount: 6, parts: [{ amount: 6, type: "slashing" }] } });
    assert.equal(sent[0]!.quiet, true, "the row says a refusal, not a toast");
    assert.equal(env.applies.getState().rolls["9:0"]!.busy, "character:c-thorn");
    // A second tap while it waits sends nothing and says so, so a toast's chip keeps its toast.
    assert.equal(await applyNow(env, chip, thorn), APPLY_BUSY);
    assert.equal(await applyNow(env, chip, { tokenId: "g1", holder: "token:g1", name: "Goblin 1" }), APPLY_BUSY, "another creature's chip of the roll");
    assert.equal(sent.length, 1);
    assert.equal(env.applies.getState().rolls["9:0"]!.said, null, "the waiting chip's row says nothing of it");
    sent[0]!.onAnswer!("taken");
    assert.equal(await done, null);
    assert.deepEqual(env.applies.getState().rolls["9:0"], { busy: null, said: null, applied: [{ holder: "character:c-thorn", name: "Thorn" }] });
    assert.deepEqual(marked, [["9:0"]]);
    // Landed once: a tap again, from another surface, sends nothing.
    await applyNow(env, chip, thorn);
    assert.equal(sent.length, 1);
  });

  test("a refusal says its words and leaves the creature to try again, a lost answer says so, and a gone token sends nothing", async () => {
    const { env, sent, marked } = harness(table());
    const chip = rollChip([slash("dm1")])!;
    const refused = applyNow(env, chip, thorn);
    const refusal: OpRefusal = { code: "invalid", message: "that creature is gone", text: "Not saved. That creature is gone." };
    sent[0]!.onAnswer!("refused", refusal);
    assert.equal(await refused, "That creature is gone.");
    assert.deepEqual(env.applies.getState().rolls["9:0"], { busy: null, said: "That creature is gone.", applied: [] });
    const lost = applyNow(env, chip, thorn);
    sent[1]!.onAnswer!("unknown");
    assert.equal(await lost, APPLY_UNKNOWN);
    assert.equal(await applyNow(env, chip, { ...thorn, tokenId: "nobody" }), APPLY_GONE);
    assert.equal(sent.length, 2);
    assert.deepEqual(marked, []);
  });

  test("a critical roll counts as the entry's ticked Crit on a creature at 0 HP, and only there", async () => {
    const view = table();
    const down = { ...view, characters: { "c-thorn": character("c-thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ hp: { cur: 0, max: 20, temp: 0 }, life: "dying" }) }) } };
    const crit = rollChip([slash("dm1", { crit: "doubleDice" })])!;
    const a = harness(down);
    void applyNow(a.env, crit, thorn);
    assert.equal((a.sent[0]!.op as Extract<ClientOp, { t: "actor.hp" }>).change.kind === "damage" && (a.sent[0]!.op as { change: { crit?: boolean } }).change.crit, true);
    const b = harness(view);
    void applyNow(b.env, crit, thorn);
    assert.equal((b.sent[0]!.op as { change: { crit?: boolean } }).change.crit, undefined);
  });
});

describe("toastChips, a toast's chips on the DM's device", () => {
  test("the ranked creatures, each applying at once, and none for a player or a roll that is no damage", () => {
    const { env } = harness(table());
    const chips = toastChips(env, [slash("p1", { tokenId: "thorn" })], { sceneId: "s1", selected: [] });
    assert.deepEqual(chips.map((c) => [c.label, c.name]), [
      ["Goblin Warrior 1", "Apply 6 Slashing damage to Goblin Warrior 1"],
      ["Goblin Warrior 2", "Apply 6 Slashing damage to Goblin Warrior 2"],
    ]);
    const player = harness(table(true), { memberId: "p1", role: "player" as never });
    assert.deepEqual(toastChips(player.env, [slash("p2")], { sceneId: "s1", selected: [] }), [], "never on a player's toast");
    assert.deepEqual(toastChips(env, [diceLine("9:1", "t", [{ formula: "1d20+4", faces: [12], total: 16, label: "Scimitar", tokenId: "g1" }])], { sceneId: "s1", selected: [] }), []);
  });

  test("a toast's chip pressed while the Dice panel's chip of the roll waits says so, sends nothing and keeps the toast", async () => {
    const { env, sent } = harness(table());
    const lines = [slash("p1", { tokenId: "thorn" })];
    void applyNow(env, rollChip(lines)!, { tokenId: "g1", holder: "token:g1", name: "Goblin Warrior 1" });
    const room = createRoomStore({ roomId: "room", you: { memberId: "dm1", role: "dm" }, clientId: "device" });
    try {
      room.ui.notify("Bree rolled 6 for Scimitar damage.", "info", undefined, { label: "Apply to", buttons: toastChips(env, lines, { sceneId: "s1", selected: [] }) }, true);
      const toast = () => room.store.getState().toasts[0];
      room.ui.toastsDrawn([toast()!.id]);
      room.ui.pressToast!(toast()!.id, 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(sent.length, 1, "only the panel's apply went");
      assert.deepEqual([toast()?.said, toast()?.busy], [APPLY_BUSY, undefined], "the toast stays, saying why, its chips live again");
    } finally {
      room.dispose();
    }
  });
});

describe("the ApplyTo row", () => {
  const made = new Map<unknown, unknown>();
  const memo = (slot: { create(): unknown }) => {
    if (!made.has(slot)) made.set(slot, slot.create());
    return made.get(slot);
  };
  function render(view: RoomState, you: { memberId: string; role: "dm" | "player" }, lines: LogEntry[], applied?: { holder: string; name: string }[]): string {
    // A server render reads a store's first state, so the landed roll is made the slot's first state here.
    const scope = new RoomScope();
    const slot = applied ? { create: () => createStore(() => ({ rolls: { "9:0": { applied, busy: null, said: null } } })) } : applySlot;
    if (applied) Object.assign(scope, { get: (s: unknown) => (s === applySlot ? memo(slot) : RoomScope.prototype.get.call(scope, s as never)) });
    const store = createStore(() => ({ view, you, sceneId: "s1", roomId: "r1", connection: "open", pending: [], local: { selectedIds: [], multi: false, panel: null, panelList: false, sheetHidden: false } }));
    return renderToStaticMarkup(
      createElement(RoomProvider, {
        store: store as never,
        actions: { dispatch: () => 1, newId: () => "x" } as never,
        ui: {} as never,
        assets: { url: () => "" } as never,
        children: createElement(RoomScopeProvider, { scope, children: createElement(ApplyTo, { lines }) }),
      }),
    );
  }

  test("the DM's row: Apply to, then each creature named to apply, the first the likeliest", () => {
    const html = render(table(), { memberId: "dm1", role: "dm" }, [slash("dm1")]);
    assert.match(html, /role="group" aria-label="Apply to"/);
    assert.match(html, /aria-label="Apply 6 Slashing damage to Thorn"/);
    assert.doesNotMatch(html, /Goblin Warrior 1</, "never the roller");
  });

  test("once landed on Thorn, Thorn leaves the row and the row says so", () => {
    const html = render(table(), { memberId: "dm1", role: "dm" }, [slash("dm1")], [{ holder: "character:c-thorn", name: "Thorn" }]);
    assert.doesNotMatch(html, /to Thorn"/);
    assert.match(html, /Applied to Thorn\./);
  });

  test("a player's chips fill, only under their own roll and only with the setting on", () => {
    const own = slash("p1", { tokenId: "thorn" });
    assert.match(render(table(true), { memberId: "p1", role: "player" }, [own]), /aria-label="Fill 6 Slashing damage for Goblin Warrior 1"/);
    assert.equal(render(table(false), { memberId: "p1", role: "player" }, [own]), "");
    assert.equal(render(table(true), { memberId: "p1", role: "player" }, [slash("p2", { tokenId: "thorn" })]), "");
  });
});
