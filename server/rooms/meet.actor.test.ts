import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { ProjectedToken } from "#shared/project.ts";
import type { ServerMessage } from "#shared/protocol.ts";
import { actor as inline } from "#shared/testutil.ts";
import type { ActorDeps } from "./actor.ts";
import { meetOps } from "./meet.ts";
import { scopeActor, scopeFixture, storedActor, StoredRoomDb } from "./undoScopeTesting.ts";

/*
 * The meet step in the room actor (actor.ts #meet): at the end of the batch
 * that brought a second "Goblin 2" into the party's sight, both take their
 * numbers in the same batch, and a step that throws leaves the batch to
 * commit with nothing numbered. The fixture's first Goblin 2 was met alone.
 */

/** The last value the player's frames gave the token, or undefined when none named it. */
function lastSeen(sent: readonly ServerMessage[], tokenId: string): ProjectedToken | null | undefined {
  let out: ProjectedToken | null | undefined;
  for (const m of sent) {
    if (m.t === "snapshot") out = (m.state as { tokens: Record<string, ProjectedToken> }).tokens[tokenId] ?? out;
    if (m.t === "ev") for (const c of m.changes ?? []) if (c.key === `token:${tokenId}`) out = "value" in c ? (c.value as ProjectedToken) : null;
  }
  return out;
}

const second = (id: string, sceneId: string) => ({ t: "token.create", token: { id, sceneId, kind: "monster", name: "Goblin 2", size: "medium", x: 5, y: 3, actor: { inline: inline() } } });

describe("the meet step in the room actor", () => {
  test("the batch that brings a second of a name into the party's sight numbers both, and the player reads them", async (t) => {
    const f = scopeFixture();
    const h = await scopeActor(t, f.state);
    const dm = await h.connect(f.dm);
    const player = await h.connect(f.player, "player");
    const id = uuidv7();
    await dm.apply(second(id, f.sceneId));
    const stored = h.db.stored.slice(-2).map((op) => op.t);
    assert.deepEqual(stored, ["token.create", "sys.meet"], "the meeting is stored in the op's batch, after it");
    const state = h.actor.committed.state;
    assert.deepEqual([state.tokens[f.goblin]!.number, state.tokens[id]!.number], [1, 2]);
    assert.ok(player.sent.some((m) => m.t === "ev" && (m.changes ?? []).some((c) => c.key === `token:${id}`)));
    assert.equal(lastSeen(player.sent, id)?.number, 2);
    assert.equal(lastSeen(player.sent, f.goblin)?.number, 1);
  });

  test("a step that throws is logged, and the batch commits with nothing numbered", async (t) => {
    const f = scopeFixture();
    const errors: string[] = [];
    const log: ActorDeps["log"] = { info() {}, warn() {}, debug() {}, error: (_o: unknown, msg?: string) => void errors.push(msg ?? "") };
    const meetStep = () => {
      throw new Error("scripted meet step fault");
    };
    const h = await storedActor(t, new StoredRoomDb(f.state), { meetStep }, log);
    const dm = await h.connect(f.dm);
    const id = uuidv7();
    await dm.apply(second(id, f.sceneId));
    const state = h.actor.committed.state;
    assert.ok(state.tokens[id], "the op committed");
    assert.deepEqual([state.tokens[f.goblin]!.number, state.tokens[id]!.number, state.tokens[id]!.met], [undefined, undefined, undefined]);
    assert.deepEqual(h.db.rows.map((r) => (r.op as { t: string }).t), ["token.create"]);
    assert.ok(errors.some((m) => m.startsWith("meet step failed")));
    // The next batch's step meets them, as the room's state alone says who is met.
    assert.equal(meetOps(state, state, [], { skip: false }).length, 1);
  });
});
