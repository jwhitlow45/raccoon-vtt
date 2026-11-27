import assert from "node:assert/strict";
import { test } from "node:test";
import { dragLeftBoard } from "./dragLeft.ts";

const ground = "ground";
const upper = "upper";

test("a drag whose tokens all stand on the board's floor has not left it", () => {
  const tokens = { lead: { sceneId: ground }, follower: { sceneId: ground } };
  assert.equal(dragLeftBoard(tokens, ground, ["lead", "follower"]), false);
});

test("a lead moved to another floor mid-drag has left the board", () => {
  const tokens = { lead: { sceneId: upper }, follower: { sceneId: ground } };
  assert.equal(dragLeftBoard(tokens, ground, ["lead", "follower"]), true);
});

test("a follower moved to another floor mid-drag has left the board, though its lead stays", () => {
  const tokens = { lead: { sceneId: ground }, follower: { sceneId: upper } };
  assert.equal(dragLeftBoard(tokens, ground, ["lead", "follower"]), true);
});

test("a token deleted mid-drag, or one this copy no longer holds, has left the board", () => {
  assert.equal(dragLeftBoard({ lead: { sceneId: ground } }, ground, ["lead", "follower"]), true);
  assert.equal(dragLeftBoard({ lead: undefined }, ground, ["lead"]), true);
  assert.equal(dragLeftBoard(undefined, ground, ["lead"]), true);
});

test("an id named like an object's own key is read only as the room's", () => {
  assert.equal(dragLeftBoard({}, ground, ["constructor"]), true);
});
