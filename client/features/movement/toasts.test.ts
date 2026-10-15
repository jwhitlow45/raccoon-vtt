import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry } from "#shared/model.ts";
import { room } from "#shared/testutil.ts";
import { teleportToasts } from "./toasts.ts";
import { thorn } from "./testing.ts";

describe("the DM's teleport toasts", () => {
  test("only teleport lines become toasts, named as the log names them", () => {
    const names = room({ tokens: { thorn: thorn() } });
    const fresh: LogEntry[] = [
      { id: "4:0", at: "", kind: "event", data: { type: "teleport", tokenId: "thorn", past: "wall" } },
      { id: "4:1", at: "", kind: "chat", text: "hello" },
      { id: "5:0", at: "", kind: "event", data: { type: "teleport", tokenId: "thorn", past: "ledge" } },
      { id: "6:0", at: "", kind: "event", data: { type: "encounter", action: "start" } },
    ];
    assert.deepEqual(teleportToasts(fresh, names), ["Thorn teleported past a wall.", "Thorn teleported past a ledge."]);
  });
});
