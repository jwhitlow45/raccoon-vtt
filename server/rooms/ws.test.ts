import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FAR, HARD, LIMITS, utf8Bytes } from "#shared/limits.ts";
import { clientMessageSchema, clientOpSchema, MAX_HANDOUT_PAGE_PX } from "#shared/protocol.ts";
import { DEFAULT_BUFFERED_LIMIT, MAX_FRAME_BYTES } from "./ws.ts";

/*
 * The largest op a client can send must fit one frame with room to spare
 * (docs/design/design-v1-pdf-handouts.md 3.7). A show of a whole document is the
 * largest handout op: every page with its size, 64-character ids, an
 * 80-character title and every recipient.
 */
describe("a frame holds the largest handout op", () => {
  const longId = (i: number) => `${i}`.padStart(64, "f");
  const handout = {
    id: longId(0),
    pages: Array.from({ length: LIMITS.handoutPages }, (_, i) => ({ assetId: longId(i + 1), width: MAX_HANDOUT_PAGE_PX, height: MAX_HANDOUT_PAGE_PX })),
    title: "\u{1F409}".repeat(40),
    to: Array.from({ length: 50 }, (_, i) => longId(1000 + i)),
  };

  test("a show of 100 pages, with its message envelope, is under a quarter of the frame", () => {
    const op = { t: "handout.show", handout };
    assert.ok(clientOpSchema.safeParse(op).success, "the op is the largest the schema takes");
    const message = { t: "op", n: Number.MAX_SAFE_INTEGER, op, g: longId(9999) };
    assert.ok(clientMessageSchema.safeParse(message).success);
    const bytes = utf8Bytes(JSON.stringify(message));
    assert.ok(bytes < MAX_FRAME_BYTES / 4, `the message is ${bytes} bytes`);
  });

  test("the event a player receives for it carries the same handout in as little", () => {
    const value = { ...handout, rev: Number.MAX_SAFE_INTEGER, assetId: handout.pages[0]!.assetId, shownAt: new Date(0).toISOString() };
    const event = { t: "ev", seq: Number.MAX_SAFE_INTEGER, changes: [{ key: `handout:${handout.id}`, value }], acks: [Number.MAX_SAFE_INTEGER] };
    const bytes = utf8Bytes(JSON.stringify(event));
    assert.ok(bytes < MAX_FRAME_BYTES / 4, `the event is ${bytes} bytes`);
  });
});

describe("the send buffer a slow socket may hold", () => {
  test("is the derived bound, which holds a DM's snapshot of a room at the far line with 1 MiB to spare (docs/design/design-v1-player-limits.md 8)", () => {
    assert.equal(DEFAULT_BUFFERED_LIMIT, HARD.sendBufferBytes);
    // The scene at its far line and the companion stat blocks beside it, the most of the room's far line both take, and the
    // DM's own lines outside the measures: the fixture's snapshot measures each (limits.bounds.test.ts).
    const largest = FAR.roomBytes + LIMITS.dmLogLines * LIMITS.apartLineBytes + 2 * LIMITS.whisperBytesPerRoom / LIMITS.membersPerRoom + 100 * 1024;
    assert.ok(largest + 1024 * 1024 <= DEFAULT_BUFFERED_LIMIT, `${largest}`);
  });
});
