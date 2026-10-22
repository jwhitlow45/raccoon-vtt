import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Token } from "#shared/model.ts";
import { canApply } from "#shared/permissions.ts";
import { clientOpSchema } from "#shared/protocol.ts";
import { actor, DM, effect, entry, P1, room, token } from "#shared/testutil.ts";
import { line, world } from "../movement/testing.ts";
import { copyFor } from "./testing.ts";
import { asksControl, attachOp, attachRows, emptyWords, MAX_ROWS, waitsForServer } from "./list.ts";

const dm = { role: "dm" as const, memberId: DM.memberId };
const p1 = { role: "player" as const, memberId: P1.memberId };

/** Thorn at (5, 5), with a horse, a torch, a cart and a Grappled kobold beside him. */
function table(extra: Token[] = []): RoomState {
  const state = room();
  const list = [
    token("thorn", { name: "Thorn", kind: "pc", x: 5, y: 5, ownerIds: ["p1"], disposition: "ally" }),
    token("horse", { name: "Warhorse", kind: "npc", size: "large", x: 6, y: 5, ownerIds: ["p1"], disposition: "ally" }),
    token("torch", { name: "Torch", kind: "object", layer: "object", size: "tiny", x: 4.5, y: 6 }),
    token("cart", { name: "Cart", kind: "object", layer: "object", size: "large", x: 3, y: 6 }),
    token("kobold", { name: "Kobold", size: "small", x: 4, y: 4, actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } }),
    ...extra,
  ];
  state.tokens = Object.fromEntries(list.map((t) => [t.id, t]));
  return state;
}

function asPlayer(state: RoomState): RoomState {
  return copyFor(state, P1);
}

describe("the Attach list", () => {
  test("every token in reach gives the sentences its choices make, nearest first", () => {
    const rows = attachRows(table(), dm, "thorn");
    // All four stand 5 ft off, so they list by name. The DM may drag any creature in reach, a horse included.
    assert.deepEqual(
      rows.map((r) => r.text),
      ["Get on Cart", "Carry Kobold", "Drag Kobold", "Carry Torch", "Ride Warhorse", "Drag Warhorse"],
    );
    const ride = rows.find((r) => r.kind === "ride")!;
    assert.deepEqual([ride.carriedId, ride.holderId, ride.kind], ["thorn", "horse", "ride"]);
    // The seat nearest where Thorn stands inside the horse, at the horse's elevation.
    assert.deepEqual(ride.at, { x: 6, y: 5, elevation: 0 });
    const drag = rows.find((r) => r.text === "Drag Kobold")!;
    assert.deepEqual([drag.carriedId, drag.holderId, drag.at], ["kobold", "thorn", { x: 4, y: 4, elevation: 0 }]);
  });

  test("a Tiny creature perches, and a creature not Grappled is dragged but never carried", () => {
    const imp = token("imp", { name: "Imp", size: "tiny", x: 5.5, y: 4.5 });
    const state = table([imp, token("pip", { name: "Pip", size: "small", x: 4, y: 5 })]);
    const fromImp = attachRows(state, dm, "imp").map((r) => r.text);
    assert.ok(fromImp.includes("Perch on Thorn") && fromImp.includes("Drag Thorn") && !fromImp.includes("Ride Thorn"));
    const fromThorn = attachRows(state, dm, "thorn").map((r) => r.text);
    assert.ok(fromThorn.includes("Drag Pip"));
    assert.ok(!fromThorn.includes("Carry Pip"));
  });

  test("a player's list never offers to take a rider off its mount, which gets off first, while the DM's does", () => {
    const state = table([token("pony", { name: "Pony", kind: "npc", size: "large", x: 3, y: 3 })]);
    state.tokens.kobold = { ...state.tokens.kobold!, attached: { to: "pony", kind: "ride" } };
    const kobold = (rows: { text: string }[]) => rows.filter((r) => r.text.endsWith("Kobold")).map((r) => r.text);
    assert.deepEqual(kobold(attachRows(asPlayer(state), p1, "thorn")), []);
    assert.deepEqual(kobold(attachRows(state, dm, "thorn")), ["Carry Kobold", "Drag Kobold"]);
  });

  test("a token already carried offers only what it would hold, so a rider changes mounts through Get off", () => {
    const state = table([token("pony", { name: "Pony", kind: "npc", size: "large", x: 3, y: 4 })]);
    state.tokens.thorn = { ...state.tokens.thorn!, x: 6, y: 5, attached: { to: "horse", kind: "ride" } };
    const texts = attachRows(state, dm, "thorn").map((r) => r.text);
    assert.ok(texts.length > 0 && texts.every((t) => t.startsWith("Carry ") || t.startsWith("Drag ")), texts.join(", "));
  });

  test("the DM's list goes on to 30 ft under Farther away, with Ride, Perch and Carry only", () => {
    const pony = token("pony", { name: "Pony", size: "large", x: 9, y: 5 });
    const far = token("far", { name: "Far horse", size: "large", x: 20, y: 5 });
    const rows = attachRows(table([pony, far]), dm, "thorn");
    const farther = rows.filter((r) => r.farther);
    assert.deepEqual(farther.map((r) => r.text), ["Ride Pony"]);
    assert.ok(rows.every((r) => r.farther || !r.text.startsWith("Ride Pony")));
    // A player's list stops at reach.
    assert.equal(attachRows(table([pony]), p1, "thorn").some((r) => r.otherId === "pony"), false);
  });

  test("a player lists only what they may do: their own horse, the torch, a creature the DM marked Grappled, never one whose mark is hidden", () => {
    const state = table([token("orc", { name: "Orc", x: 5, y: 6 })]);
    state.tokens.kobold = token("kobold", { name: "Kobold", size: "small", x: 4, y: 4, actor: { inline: actor({ effects: [effect("g", { key: "grappled", hiddenFromPlayers: true })] }) } });
    const rows = attachRows(asPlayer(state), p1, "thorn").map((r) => r.text);
    // Their own horse they may ride or drag, as a friend is dragged.
    assert.deepEqual(rows, ["Ride Warhorse", "Drag Warhorse"]);
    // The torch and the cart are the DM's: a player may move neither.
    state.meta.settings.playersMoveAny = "all";
    const any = attachRows(asPlayer(state), p1, "thorn").map((r) => r.text);
    assert.ok(any.includes("Carry Torch") && any.includes("Get on Cart") && any.includes("Drag Orc"));
    state.tokens.kobold = token("kobold", { name: "Kobold", size: "small", x: 4, y: 4, ownerIds: [], actor: { inline: actor({ effects: [effect("g", { key: "grappled" })] }) } });
    state.meta.settings.playersMoveAny = "none";
    assert.deepEqual(attachRows(asPlayer(state), p1, "thorn").map((r) => r.text), ["Carry Kobold", "Drag Kobold", "Ride Warhorse", "Drag Warhorse"]);
  });

  test("a player rides only on the rider's own turn while a fight is under way", () => {
    const state = table();
    state.encounter = { rev: 1, round: 1, activeEntryId: "i-horse", entries: [entry("i-thorn", { tokenId: "thorn" }), entry("i-horse", { tokenId: "horse" })] } as RoomState["encounter"];
    assert.equal(attachRows(asPlayer(state), p1, "thorn").some((r) => r.kind === "ride"), false);
    state.encounter!.activeEntryId = "i-thorn";
    assert.equal(attachRows(asPlayer(state), p1, "thorn").some((r) => r.kind === "ride"), true);
  });

  test("a seat behind a wall is left out for a player where walls stop moves, never for the DM", () => {
    const state = world({ edges: line("w", 6, 0, 30), tokens: Object.values(table().tokens) });
    assert.equal(attachRows(asPlayer(state), p1, "thorn").some((r) => r.kind === "ride"), false);
    assert.equal(attachRows(state, dm, "thorn").some((r) => r.kind === "ride"), true);
  });

  test("so is a grappled creature's seat on its carrier, while its drag stays, since a drag leaves it where it stands", () => {
    const state = world({ edges: line("w", 5, 0, 30), tokens: Object.values(table().tokens) });
    const texts = attachRows(asPlayer(state), p1, "thorn").map((r) => r.text);
    assert.equal(texts.includes("Carry Kobold"), false);
    assert.equal(texts.includes("Drag Kobold"), true);
    assert.equal(attachRows(state, dm, "thorn").some((r) => r.text === "Carry Kobold"), true);
  });

  test("so is a seat whose step takes a creature the token drags through a wall, as the server's walls test of a group walks it", () => {
    const tokens = Object.values(table().tokens).map((t) => (t.id === "kobold" ? { ...t, attached: { to: "thorn", kind: "drag" as const } } : t));
    // Thorn steps east onto the horse, so the kobold steps east from 4,4 through the wall.
    const state = world({ edges: { "5,4,w": { kind: "wall" } }, tokens });
    assert.equal(attachRows(asPlayer(state), p1, "thorn").some((r) => r.kind === "ride"), false);
    assert.equal(attachRows(state, dm, "thorn").some((r) => r.kind === "ride"), true);
  });

  test("a link already made, a seat that does not fit and the limits are left out", () => {
    const state = table();
    state.tokens.thorn = { ...state.tokens.thorn!, attached: { to: "horse", kind: "ride" } };
    assert.equal(attachRows(state, dm, "thorn").some((r) => r.text === "Ride Warhorse"), false);
    // The horse would carry itself through Thorn.
    assert.equal(attachRows(state, dm, "horse").some((r) => r.carriedId === "horse" && r.holderId === "thorn"), false);
  });

  test("at most twelve rows", () => {
    const crowd = Array.from({ length: 20 }, (_, i) => token(`c${i}`, { name: `Rat ${i}`, kind: "object", size: "tiny", x: 5 + (i % 2) * 0.5, y: 5 + Math.floor(i / 2) * 0.1 }));
    assert.equal(attachRows(table(crowd), dm, "thorn").length, MAX_ROWS);
  });

  test("the empty list says what it is for, and a player how a grappled creature joins it", () => {
    assert.deepEqual(emptyWords("dm"), ["Nothing within 5 ft to ride, carry or drag."]);
    assert.deepEqual(emptyWords("player"), ["Nothing within 5 ft to ride, carry or drag.", "A grappled creature can be dragged once the DM marks it Grappled."]);
  });

  test("a row's op is one the server takes, steer only on a ride, and a player's controlled ride in a fight waits for the answer", () => {
    const rows = attachRows(table(), dm, "thorn");
    const ride = rows.find((r) => r.kind === "ride")!;
    assert.equal(asksControl(ride), true);
    assert.deepEqual(attachOp(ride, true), { t: "token.attach", tokenId: "thorn", to: "horse", kind: "ride", steer: true, x: 6, y: 5, elevation: 0 });
    const carry = rows.find((r) => r.text === "Carry Torch")!;
    assert.equal(asksControl(carry), false);
    assert.equal("steer" in attachOp(carry, true), false);
    for (const row of rows) assert.ok(clientOpSchema.safeParse(attachOp(row, true)).success, row.text);
    // Each row's op is one the server takes from whoever it was offered to, the DM's and a player's from their own copy.
    const takes = (who: typeof DM, op: ReturnType<typeof attachOp>) => canApply(op, who, table(), { canUseAsset: () => true });
    for (const row of rows) assert.equal(takes(DM, attachOp(row, true)).ok, true, row.text);
    const mine = attachRows(asPlayer(table()), p1, "thorn");
    assert.ok(mine.length > 0);
    for (const row of mine) for (const steer of [false, true]) assert.equal(takes(P1, attachOp(row, steer)).ok, true, row.text);
    const fight = { encounter: { rev: 1 } as RoomState["encounter"] };
    assert.equal(waitsForServer(p1, fight, ride, true), true);
    assert.equal(waitsForServer(p1, fight, ride, false), false);
    assert.equal(waitsForServer(dm, fight, ride, true), false);
    assert.equal(waitsForServer(p1, { encounter: null }, ride, true), false);
  });
});
