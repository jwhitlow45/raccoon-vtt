import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoomStore, type RoomStore } from "../state/store.ts";
import type { RoomActions } from "../state/types.ts";

const { RoomTree } = await import("./RoomTree.tsx");

test("a live room's tree takes a key of its store's own, so a new store mounts it anew (review FU22B-OP-9)", () => {
  const you = { memberId: "m1", role: "dm" as const };
  const first = createRoomStore({ roomId: "R1", you, clientId: "c1" });
  const second = createRoomStore({ roomId: "R1", you, clientId: "c2" });
  const keyOf = (room: RoomStore) => RoomTree({ room, actions: {} as RoomActions, children: null }).key;
  try {
    assert.notEqual(keyOf(first), null);
    assert.equal(keyOf(first), keyOf(first), "the same store keeps its key on every render");
    assert.notEqual(keyOf(second), keyOf(first));
  } finally {
    first.dispose();
    second.dispose();
  }
});
