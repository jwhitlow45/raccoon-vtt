import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { UPPER, fallCard, thornToken, tower, withFalls, withOpening } from "#shared/floorLinksTestutil.ts";
import type { RoomState } from "#shared/model.ts";
import { applyOp } from "#shared/reducer.ts";
import { AT, DM } from "#shared/testutil.ts";
import { lastLineSeq, remapState } from "./remap.ts";
import { parseRoomState } from "./stateSchema.ts";

/*
 * Fall cards through an import (docs/design/design-v1-floors.md phase 4,
 * 4.4): they follow their floors under the new room's ids, keep their own
 * id and `made`, and the new room's ops count on past every card's, so a
 * card it makes never takes the id of one that came in the file.
 */

function numbered(): () => string {
  let n = 0;
  return () => `0199f0a0-0000-7000-8000-${String(n++).padStart(12, "0")}`;
}

function imported(state: RoomState): RoomState {
  return remapState(state, { assets: new Map(), newId: numbered() });
}

describe("fall cards in an import (4.4)", () => {
  test("a card names its creature and both floors by their new ids, and keeps its id, made, drop and rev", () => {
    const card = fallCard({ made: 130, rev: 2 });
    const state = withFalls(withOpening(tower({ tokens: { thorn: thornToken() } })), card);
    const out = imported(state);
    const thorn = Object.values(out.tokens).find((t) => t.name === "Thorn")!;
    const floor = (name: string) => Object.values(out.scenes).find((s) => s.floor?.name === name)!.id;
    assert.deepEqual(out.falls, { [card.id]: { ...card, tokenId: thorn.id, sceneId: floor("Ground floor"), from: floor("Upper floor") } });
    assert.notEqual(thorn.id, "thorn");
    assert.ok(parseRoomState(out).ok, "the room stored checks");
  });

  test("a card whose creature did not come through names an id no creature holds, in neither room", () => {
    const card = fallCard({ tokenId: "gone" });
    const out = imported(withFalls(tower(), card));
    const named = out.falls![card.id]!.tokenId;
    assert.notEqual(named, "gone");
    assert.equal(out.tokens[named], undefined);
    assert.ok(!Object.keys(tower().tokens).includes(named));
    assert.ok(parseRoomState(out).ok);
  });

  test("a card naming a floor the file lacks goes, and a room without cards keeps no field", () => {
    const out = imported(withFalls(tower(), fallCard({ sceneId: "nowhere" }), fallCard({ id: "121:0", made: 121, from: "elsewhere" })));
    assert.equal(out.falls, undefined);
    assert.equal(imported(tower()).falls, undefined);
    assert.equal("falls" in imported(tower()), false);
  });

  test("the new room counts on past every card's made, so the next fall's card takes another id", () => {
    const card = fallCard({ made: 500, id: "500:0" });
    const state = withFalls(tower({ log: [{ id: "40:0", at: AT, kind: "chat", text: "hi", memberId: "p1" } as never] }), card);
    assert.equal(lastLineSeq(state), 500);
    assert.equal(lastLineSeq(withFalls(state, fallCard({ made: 700, id: "700:3" }))), 700);
    // The new room's first op takes the next seq, and its fall's card the next id.
    const out = imported(withOpening(withFalls(tower({ tokens: { thorn: thornToken({ sceneId: UPPER, x: 4, y: 6 }) } }), card)));
    const thorn = Object.values(out.tokens).find((t) => t.name === "Thorn")!;
    const r = applyOp(out, { t: "token.move", tokenId: thorn.id, x: 6, y: 6 }, DM, { seq: lastLineSeq(out) + 1, at: AT });
    assert.ok(r.ok);
    assert.deepEqual(Object.keys(r.state.falls ?? {}).sort(), ["500:0", "501:0"]);
    assert.equal(r.state.tokens[thorn.id]!.sceneId, Object.values(out.scenes).find((s) => s.floor?.name === "Ground floor")!.id);
  });
});
