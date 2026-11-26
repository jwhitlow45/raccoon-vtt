import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test, type TestContext } from "node:test";
import type { RoomState, TrapDue } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { FrameReader } from "#shared/seqTestutil.ts";
import { scene, token, trap } from "#shared/testutil.ts";
import { scopeActor, scopeFixture, scopeObserver } from "./undoScopeTesting.ts";

/*
 * What a player receives depends only on what they see
 * (docs/design/design-v1-traps.md 6.4). A trap's occurrence is the DM's in
 * every projection, so its Apply per creature, the gate's refusal of a
 * whole Apply from a page older than change format 66, and a remnant's end
 * of a hidden hold change only DM state. The twins differ in one thing the
 * players never see: the occurrence also hits a lurker the DM hid and
 * moved to another scene. The DM sends the same Apply naming Bree in both,
 * which settles the occurrence whole in one twin and leaves the lurker
 * waiting in the other, then P1's hidden imp sets the same trap off in
 * private. P1's, the other player's and the table display's every frame
 * are the same in both, with the trap found and not.
 */

const DISPLAY = "display:abcdefghijkl";
const PLAN = "0192f0a8-6c1e-7a4b-9c3d-0000000000a1";
const DUE = "3:0";

/** The fixture both twins load, the lurker on the vault their hidden difference: built once, so both hold the same ids. */
function pitRoom() {
  const f = scopeFixture();
  const vault = "vault";
  f.state.scenes[vault] = scene(vault, { order: 9 });
  f.state.scenes[f.sceneId] = { ...f.state.scenes[f.sceneId]!, fogEnabled: false };
  f.state.tokens.imp = token("imp", { sceneId: f.sceneId, name: "Imp", kind: "npc", ownerIds: [f.player.id], visibility: "dm", x: 0, y: 6 });
  f.state.tokens.lurker = token("lurker", { sceneId: vault, name: "Lurker", visibility: "dm" });
  return { ...f, vault };
}

type Fixture = ReturnType<typeof pitRoom>;

/** The room with the pit and its waiting occurrence: on Bree alone, or with the hidden lurker on the vault too. */
function withPit(f: Fixture, opts: { lurker: boolean; found: boolean; hidden: boolean }): RoomState {
  const state = structuredClone(f.state);
  const base = trap("pit", { sceneId: f.sceneId, found: opts.found, zone: { cells: [{ x: 3, y: 6, w: 1, h: 1 }] } });
  const due: TrapDue = { id: DUE, at: "2026-11-26T10:00:00.000Z", how: "enter", by: [f.pc], hits: (opts.lurker ? ["lurker", f.pc] : [f.pc]).sort(), ...(opts.hidden ? { hidden: true as const } : { acted: true as const }) };
  state.traps = { pit: { ...base, rig: { ...base.rig!, stops: false, damage: [{ formula: "1d6", type: "fire" }], due: [due] } } };
  return state;
}

/** One twin's run: the DM's Apply, then P1's imp over the pit, and every frame the players and the display were sent. */
async function run(t: TestContext, state: RoomState, f: Fixture, apply: Op): Promise<{ frames: string[]; due: TrapDue[]; answer: string }> {
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const h = await scopeActor(t, state, { now, idGate: false });
  const dm = await h.connect(f.dm, "dm", now);
  const p1 = await h.connect(f.player, "player", now);
  const other = await h.connect(f.unrelated, "player", now);
  const display = await scopeObserver(h.actor, { memberId: DISPLAY, role: "player", display: true });
  const settle = async () => {
    for (let i = 0; i < 20 && h.actor.queueLength > 0; i++) await delay(10);
    await delay(20);
  };
  clock.now += 1_000;
  const ev = await dm.send(apply);
  await settle();
  clock.now += 1_000;
  const walked = await p1.send({ t: "token.moveMany", moves: [{ tokenId: "imp", x: 6, y: 6 }] });
  assert.equal(walked.rejects, undefined, "P1's walk is taken");
  await settle();
  const reader = new FrameReader();
  const frames = [...p1.sent.map((m) => `p1 ${reader.text(m)}`), ...other.sent.map((m) => `other ${reader.text(m)}`), ...display.sent.map((m) => `display ${reader.text(m)}`)];
  return { frames, due: h.actor.committed.state.traps.pit!.rig!.due ?? [], answer: ev.rejects?.[0]?.message ?? "taken" };
}

describe("a trap's Apply per creature reaches the players alike (6.4)", () => {
  for (const found of [false, true]) {
    for (const hidden of [false, true]) {
      test(`trap ${found ? "found" : "unfound"}, occurrence ${hidden ? "hidden" : "public"}: an Apply naming Bree settles it whole or leaves the lurker, then a private springing, and every player frame is equal`, async (t) => {
        const f = pitRoom();
        const apply: Op = { t: "actor.outcome", plan: PLAN, trap: { trapId: "pit", due: DUE, tokenIds: [f.pc] }, targets: [{ target: { tokenId: f.pc }, amount: 3 }] };
        const whole = await run(t, withPit(f, { lurker: false, found, hidden }), f, apply);
        const partial = await run(t, withPit(f, { lurker: true, found, hidden }), f, apply);
        assert.deepEqual([whole.answer, partial.answer], ["taken", "taken"]);
        // The twins did differ: one settled whole, the other kept the lurker waiting, and the private springing wrote in both.
        assert.deepEqual(whole.due.map((d) => [d.hits, d.hidden ?? false]), [[["imp"], true]]);
        assert.deepEqual(partial.due.map((d) => [d.hits, d.hidden ?? false]), [[["lurker"], false], [["imp"], true]]);
        // What the players do get: Bree's HP from the Apply, and the found trap, which no frame of an unfound one names.
        assert.ok(whole.frames.some((line) => line.startsWith("p1 ") && line.includes('"type":"hp"')), "P1 reads Bree's HP line");
        assert.equal(whole.frames.some((line) => line.includes('"traps"') && line.includes('"pit"')), found);
        assert.deepEqual(partial.frames, whole.frames);
      });
    }

    test(`trap ${found ? "found" : "unfound"}: a whole Apply from an older page is refused in both, then a private springing, and every player frame is equal`, async (t) => {
      const f = pitRoom();
      const old: Op = { t: "actor.outcome", plan: PLAN, trap: { trapId: "pit", due: DUE }, targets: [{ target: { tokenId: f.pc }, amount: 3 }] };
      const alone = await run(t, withPit(f, { lurker: false, found, hidden: false }), f, old);
      const both = await run(t, withPit(f, { lurker: true, found, hidden: false }), f, old);
      assert.deepEqual([alone.answer, both.answer], ["It was settled meanwhile.", "It was settled meanwhile."]);
      assert.deepEqual(both.due[0]?.hits, ["lurker", f.pc].sort(), "nothing settled");
      assert.deepEqual(both.frames, alone.frames);
    });
  }
});
