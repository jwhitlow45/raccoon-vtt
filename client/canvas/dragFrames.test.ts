import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { expandGroup, groupFrameSchema, MAX_DRAG_TOKENS, type EphEvent } from "#shared/protocol.ts";
import { moveFrame } from "../features/movement/free.ts";
import { DRAG_CAP_TEXT, dragCapRefusal, draggedIds, groupMove, type FrameFields } from "./dragFrames.ts";

type Point = { x: number; y: number };
type Follower = { id: string; was: Point; fields: FrameFields };

/** Each token's own frame of one drag step, as the board sent them one token at a time before group frames. */
function ownFrames(input: { pressed: string; node: Point; drawnFrom: Point; free: boolean; own: FrameFields; followers: readonly Follower[] }): unknown[] {
  const dx = input.node.x - input.drawnFrom.x;
  const dy = input.node.y - input.drawnFrom.y;
  const frames: EphEvent[] = [moveFrame(input.pressed, input.node, input.free, input.own)];
  for (const f of input.followers) frames.push(moveFrame(f.id, { x: f.was.x + dx, y: f.was.y + dy }, false, f.fields));
  return JSON.parse(JSON.stringify(frames)) as unknown[];
}

/** The same step as one group frame, then as the server expands it, through JSON as it travels. */
function groupFrames(input: { pressed: string; node: Point; drawnFrom: Point; free: boolean; own: FrameFields; followers: readonly Follower[]; lead: number }): unknown[] {
  const move = groupMove({ at: input.node, free: input.free, own: input.own, members: input.followers.map((f) => f.fields), lead: input.lead });
  const frame = { k: "dragMove" as const, tokenId: input.pressed, g: 4, ...move, with: input.followers.map((f) => ({ tokenId: f.id, ...f.was })), from: input.drawnFrom };
  const parsed = groupFrameSchema.parse(JSON.parse(JSON.stringify(frame)));
  const roster = { from: input.drawnFrom, ids: input.followers.map((f) => f.id), starts: input.followers.flatMap((f) => [f.was.x, f.was.y]) };
  return JSON.parse(JSON.stringify(expandGroup(parsed, roster))) as unknown[];
}

const route = { path: [3, 4, 5, 4, 6, 6], ft: 15 };

describe("what a drag moves, and the cap", () => {
  test("each named token, then what it carries, each with the named token it goes by", () => {
    const carried: Record<string, string[]> = { horse: ["thorn", "imp"], goblin: [] };
    assert.deepEqual(
      draggedIds(["horse", "goblin"], (id) => carried[id] ?? []),
      [
        { id: "horse", rootId: "horse" },
        { id: "thorn", rootId: "horse" },
        { id: "imp", rootId: "horse" },
        { id: "goblin", rootId: "goblin" },
      ],
    );
  });

  test("a hundred tokens drag and a hundred and one are refused, counting every carried token, drawn or not, and each token once", () => {
    const named = Array.from({ length: 50 }, (_, i) => `n${i}`);
    // Each named token carries one rider, which the board may draw no node for, as one on another floor.
    const moved = draggedIds(named, (id) => [`${id}-rider`]);
    assert.equal(dragCapRefusal("n0", moved), null, "100 with the pressed token among them");
    // A press on a rider names its mount: the rider is counted once.
    assert.equal(dragCapRefusal("n0-rider", moved), null);
    assert.equal(dragCapRefusal("x", moved), DRAG_CAP_TEXT, "the pressed token makes 101");
    const more = draggedIds([...named, "n50"], (id) => [`${id}-rider`]);
    assert.equal(more.length, MAX_DRAG_TOKENS + 2);
    assert.equal(dragCapRefusal("n0", more), DRAG_CAP_TEXT);
    assert.equal(dragCapRefusal("n0", more.slice(0, MAX_DRAG_TOKENS + 1)), DRAG_CAP_TEXT, "101 by a carried token");
    assert.equal(DRAG_CAP_TEXT, "Drag at most 100 tokens at once.");
  });
});

describe("a drag step as one group frame expands to each token's own frame", () => {
  const drawnFrom = { x: 3, y: 4 };

  test("a lone drag with its route", () => {
    const step = { pressed: "goblin", node: { x: 5.25, y: 4.5 }, drawnFrom, free: false, own: route, followers: [] };
    assert.deepEqual(groupFrames({ ...step, lead: -1 }), ownFrames(step));
  });

  test("a group: each named token's cost, none for what they carry, and the pressed token's own", () => {
    const followers: Follower[] = [
      { id: "b", was: { x: 4, y: 4 }, fields: { ft: 10 } },
      { id: "rider", was: { x: 4.25, y: 4 }, fields: {} },
      { id: "c", was: { x: 7, y: 1 }, fields: { ft: undefined } },
      { id: "d", was: { x: 0.5, y: 9 }, fields: { ft: 0 } },
    ];
    const step = { pressed: "a", node: { x: 6.1, y: 2.2 }, drawnFrom, free: false, own: { ft: 20 }, followers };
    assert.deepEqual(groupFrames({ ...step, lead: -1 }), ownFrames(step));
    const move = groupMove({ at: step.node, free: false, own: step.own, members: followers.map((f) => f.fields), lead: -1 });
    assert.deepEqual(move.fts, [10, null, null, 0]);
    assert.equal(groupMove({ at: step.node, free: false, own: {}, members: [{}, { ft: undefined }], lead: -1 }).fts, undefined, "left out when every cost is null");
  });

  test("an Alt-held press on a rider moves its mount by the mount's route, cut short at a wall, with `free` on no frame", () => {
    // The drag reads free only for a lone drag of the token pressed itself, so a rider's press is never free.
    const followers: Follower[] = [
      { id: "mount", was: { x: 3, y: 4 }, fields: { x: 4, y: 4, ...route } },
      { id: "rider2", was: { x: 3.5, y: 4.5 }, fields: {} },
    ];
    const step = { pressed: "rider", node: { x: 6.25, y: 4.25 }, drawnFrom: { x: 3.25, y: 4.25 }, free: false, own: {}, followers };
    const expanded = groupFrames({ ...step, lead: 0 });
    assert.deepEqual(expanded, ownFrames(step));
    assert.ok(expanded.every((f) => !("free" in (f as object))));
    // The mount's cost goes once, with its route.
    assert.equal(groupMove({ at: step.node, free: false, own: {}, members: followers.map((f) => f.fields), lead: 0 }).fts, undefined);
    const straight = followers.map((f) => (f.id === "mount" ? { ...f, fields: route } : f));
    assert.deepEqual(groupFrames({ ...step, followers: straight, lead: 0 }), ownFrames({ ...step, followers: straight }));
  });

  test("an Alt-held press on a mount carrying a rider sends `free` on the mount's own frame only", () => {
    const followers: Follower[] = [{ id: "rider", was: { x: 3.25, y: 4 }, fields: {} }];
    const step = { pressed: "mount", node: { x: 5.4, y: 4.7 }, drawnFrom, free: true, own: route, followers };
    const expanded = groupFrames({ ...step, lead: -1 }) as Record<string, unknown>[];
    assert.deepEqual(expanded, ownFrames(step));
    assert.equal(expanded[0]?.free, true);
    assert.equal("free" in expanded[1]!, false);
  });

  test("a pressed token whose walk stops short at a wall: its members move by where it stops", () => {
    // The pressed token's point is the point every member moves by, so its riders stand on it where it stops, not under the finger.
    const followers: Follower[] = [{ id: "rider", was: { x: 3.25, y: 4 }, fields: {} }];
    const step = { pressed: "horse", node: { x: 8, y: 4 }, drawnFrom, free: false, own: { x: 5, y: 4, ...route }, followers };
    const [horse, rider] = groupFrames({ ...step, lead: -1 }) as { x: number; y: number }[];
    assert.deepEqual([horse?.x, horse?.y], [5, 4]);
    assert.deepEqual([rider?.x, rider?.y], [5.25, 4]);
  });
});
