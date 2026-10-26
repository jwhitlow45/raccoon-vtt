import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { holderTileKey } from "#shared/keys.ts";
import { checkLimits, LIMITS } from "#shared/limits.ts";
import { OP_VERSION, SNAPSHOT_VERSION } from "#shared/migrate.ts";
import type { RoomState } from "#shared/model.ts";
import type { Op } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { HOLDERS_FULL } from "#shared/reducer/map.ts";
import { rasterizeFogOps } from "#shared/rules/fog.ts";
import { DM, env, member, room, scene } from "#shared/testutil.ts";
import { loadRoom, type Pool } from "./persistence.ts";

/**
 * A lower cap of players who see for themselves (docs/design-v1-per-player-vision.md
 * 6.1 and 8.1, review PV1-ASTRA-4): the server box may run at 5 where a
 * room was played at 6. Every stored op still replays through `loadRoom`,
 * and only a live op meets the cap in force, by the actor's limits check.
 */
const SIX = ["p1", "p2", "p3", "p4", "p5", "p6"];

function table(): RoomState {
  const s = room({ members: { dm1: member("dm1", "dm"), ...Object.fromEntries(SIX.map((id) => [id, member(id)])) } });
  s.scenes.s1 = scene("s1", { fogEnabled: true, vision: { on: true, light: "dark", perPlayer: true } });
  return s;
}

function pool(state: RoomState, ops: readonly { op: Op; role: "dm" }[]): Pool {
  const snapshot = { seq: "0", state: JSON.parse(JSON.stringify(state)), schema_version: SNAPSHOT_VERSION };
  const rows = ops.map(({ op, role }, i) => ({ seq: String(i + 1), at: new Date(env(i + 1).at), actor_member_id: role === "dm" ? "dm1" : "server", actor_role: role, op, op_version: OP_VERSION }));
  const query = (sql: string) => Promise.resolve({ rows: sql.includes("room_snapshots") ? [snapshot] : rows });
  return { query, connect: () => Promise.reject(new Error("not used")) } as unknown as Pool;
}

/** Runs `body` with the cap in force lowered to `cap`, and puts it back. */
async function atCap<T>(cap: number, body: () => Promise<T> | T): Promise<T> {
  const limits = LIMITS as { sightHoldersPerScene: number };
  const was = limits.sightHoldersPerScene;
  limits.sightHoldersPerScene = cap;
  try {
    return await body();
  } finally {
    limits.sightHoldersPerScene = was;
  }
}

const bits = Object.values(rasterizeFogOps({}, "s1", { w: 40, h: 30 }, [{ id: "r", mode: "reveal", shape: { kind: "rect", x: 0, y: 0, w: 2, h: 2 } }]))[0]!.bits;
const pickSix: Op = { t: "vision.holders", sceneId: "s1", on: SIX };
const joinSix: Op = { t: "sys.explore", sceneId: "s1", tiles: [], join: SIX.map((memberId) => ({ memberId, on: true })), members: SIX.map((memberId) => ({ memberId, tiles: [{ tx: 0, ty: 0, bits }] })) };

describe("a lower cap of players who see for themselves (review PV1-ASTRA-4)", () => {
  for (const [name, op, role] of [["the DM's pick of six", pickSix, "dm"], ["an explore step that joined six and explored for each", joinSix, "dm"]] as const) {
    test(`${name}, stored at 6, replays at 5`, async () => {
      for (const cap of [6, 5]) {
        const reasons: string[] = [];
        const loaded = await atCap(cap, () => loadRoom(pool(table(), [{ op, role }]), "R", (_seq, reason) => reasons.push(reason)));
        assert.deepEqual(reasons, [], `at ${cap}`);
        assert.equal(loaded?.replayFailed, false, `at ${cap}`);
        assert.deepEqual(loaded?.state.holders.s1?.entries, SIX.map((memberId) => ({ memberId, on: true })), `at ${cap}`);
        if (op.t === "sys.explore") assert.ok(loaded?.state.exploredBy[holderTileKey("s1", "p6", 0, 0)], `at ${cap}: the sixth's own map`);
      }
    });
  }

  test("a live pick of six at 5 is refused in the DM's words, one that raises nothing is not, and an import is held to the cap", async () => {
    await atCap(5, () => {
      const before = table();
      const result = applyOp(before, pickSix, DM, env(3));
      assert.ok(result.ok, "the reducer bounds a pick by the design's most only");
      assert.deepEqual(checkLimits(result.state, "s1", before, "dm"), { ok: false, code: "quota", message: HOLDERS_FULL });
      const six = result.state;
      const again = applyOp(six, { t: "vision.holders", sceneId: "s1", on: [...SIX].reverse() }, DM, env(4));
      assert.ok(again.ok);
      assert.deepEqual(checkLimits(again.state, "s1", six, "dm"), { ok: true }, "a room stored at six keeps its six, and every other edit");
      const fewer = applyOp(six, { t: "vision.holders", sceneId: "s1", on: SIX.slice(0, 4) }, DM, env(5));
      assert.ok(fewer.ok);
      assert.deepEqual(checkLimits(fewer.state, "s1", six, "dm"), { ok: true });
      assert.deepEqual(checkLimits(six), { ok: false, code: "quota", message: HOLDERS_FULL }, "with no room before it, as for an import");
    });
    await atCap(6, () => {
      const before = table();
      const result = applyOp(before, pickSix, DM, env(3));
      assert.ok(result.ok);
      assert.deepEqual(checkLimits(result.state, "s1", before, "dm"), { ok: true });
    });
  });
});
