import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, type Me } from "./api.ts";
import {
  checkStanding,
  forgetRoom,
  MAX_KNOWN_ROOMS,
  parseKnownRooms,
  readKnownRooms,
  refreshRoom,
  rememberRoom,
  setHomeNotice,
  takeHomeNotice,
} from "./knownRooms.ts";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    get value() {
      return value;
    },
  };
}

const me = (role: "dm" | "player", name: string): Me => ({ role, member: { id: "m", name, color: "#3e8ef7", kind: role } });

describe("the rooms this device remembers", () => {
  test("entering a room puts it first, once, with who this device is there", () => {
    const storage = memoryStorage();
    rememberRoom({ roomId: "K7QH2MXA", name: "Tuesday", me: me("player", "Pip") }, 1, storage);
    rememberRoom({ roomId: "ABCD2345", name: "One-shot", me: me("dm", "Dana") }, 2, storage);
    rememberRoom({ roomId: "K7QH2MXA", name: "", me: me("player", "Pip") }, 3, storage);
    const rooms = readKnownRooms(storage);
    assert.deepEqual(
      rooms.map((r) => [r.roomId, r.name, r.role, r.memberName]),
      [
        ["K7QH2MXA", "Tuesday", "player", "Pip"],
        ["ABCD2345", "One-shot", "dm", "Dana"],
      ],
    );
  });

  test("keeps only the newest few", () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_KNOWN_ROOMS + 3; i++) {
      rememberRoom({ roomId: `ABCD${String(2300 + i).padStart(4, "0")}`.slice(0, 8), name: `Room ${i}`, me: me("player", "P") }, i, storage);
    }
    const rooms = readKnownRooms(storage);
    assert.equal(rooms.length, MAX_KNOWN_ROOMS);
    assert.equal(rooms[0]?.name, `Room ${MAX_KNOWN_ROOMS + 2}`);
  });

  test("forgetting and refreshing a room", () => {
    const storage = memoryStorage();
    rememberRoom({ roomId: "K7QH2MXA", name: "Tuesday", me: me("dm", "Dana") }, 1, storage);
    rememberRoom({ roomId: "ABCD2345", name: "One-shot", me: me("player", "Pip") }, 2, storage);
    refreshRoom("K7QH2MXA", { name: "Tuesday night", role: "player" }, storage);
    assert.deepEqual(
      readKnownRooms(storage).map((r) => [r.roomId, r.name, r.role]),
      [
        ["ABCD2345", "One-shot", "player"],
        ["K7QH2MXA", "Tuesday night", "player"],
      ],
    );
    forgetRoom("ABCD2345", storage);
    assert.deepEqual(readKnownRooms(storage).map((r) => r.roomId), ["K7QH2MXA"]);
  });

  test("anything malformed in storage is left out, and broken storage reads as empty", () => {
    assert.deepEqual(parseKnownRooms("not json"), []);
    assert.deepEqual(parseKnownRooms('{"roomId":"K7QH2MXA"}'), []);
    const rooms = parseKnownRooms(
      JSON.stringify([
        { roomId: "k7qh-2mxa", name: "Ok", role: "player", memberName: "Pip", openedAt: 5 },
        { roomId: "K7QH2MXA", name: "Duplicate", role: "dm", memberName: "X", openedAt: 9 },
        { roomId: "nope", name: "Bad id", role: "dm", memberName: "X", openedAt: 1 },
        { roomId: "ABCD2345", name: "Bad role", role: "admin", memberName: "X", openedAt: 1 },
        { roomId: "WXYZ2345", name: 3, role: "dm", openedAt: "x" },
      ]),
    );
    assert.deepEqual(rooms, [
      { roomId: "K7QH2MXA", name: "Ok", role: "player", memberName: "Pip", openedAt: 5 },
      { roomId: "WXYZ2345", name: "", role: "dm", memberName: "", openedAt: 0 },
    ]);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.deepEqual(readKnownRooms(throwing), []);
    assert.doesNotThrow(() => rememberRoom({ roomId: "K7QH2MXA", name: "x", me: me("dm", "D") }, 1, throwing));
    assert.deepEqual(readKnownRooms(null), []);
  });
});

describe("where this device stands in a remembered room", () => {
  const refused = new ApiError(403, "No.", "no_access", null);
  const missing = new ApiError(404, "Gone.", "room_not_found", null);
  const offline = new ApiError(0, "Offline.", "network", null);

  test("signed in, with the room's name and this device's member", async () => {
    const standing = await checkStanding("K7QH2MXA", {
      getMe: async () => ({ ...me("dm", "Dana"), roomName: "Tuesday" }),
      getRoom: async () => assert.fail("not asked"),
    });
    assert.deepEqual(standing, { kind: "in", role: "dm", memberName: "Dana", roomName: "Tuesday" });
  });

  test("a refusal is a signed-out device when the room is there, and a deleted room when it is not", async () => {
    assert.deepEqual(await checkStanding("K7QH2MXA", { getMe: () => Promise.reject(refused), getRoom: async () => ({ name: "Tuesday" }) }), {
      kind: "out",
      roomName: "Tuesday",
    });
    assert.deepEqual(await checkStanding("K7QH2MXA", { getMe: () => Promise.reject(refused), getRoom: () => Promise.reject(missing) }), {
      kind: "gone",
    });
  });

  test("offline or busy is not a verdict", async () => {
    assert.deepEqual(await checkStanding("K7QH2MXA", { getMe: () => Promise.reject(offline), getRoom: async () => ({ name: "x" }) }), {
      kind: "unknown",
    });
  });
});

describe("the Home page's one-time notice", () => {
  test("is shown once", () => {
    setHomeNotice("The room was deleted.");
    assert.equal(takeHomeNotice(), "The room was deleted.");
    assert.equal(takeHomeNotice(), null);
  });
});
