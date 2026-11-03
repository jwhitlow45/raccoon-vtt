import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { JoinTickets, TICKET_TTL_MS } from "./tickets.ts";

describe("join tickets", () => {
  test("bind room, session and epoch, and are single use", () => {
    const tickets = new JoinTickets();
    const token = tickets.mint("ROOMAAAA", "session-1", 3);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(
      { ...tickets.peek(token), expiresAt: 0 },
      { roomId: "ROOMAAAA", sessionId: "session-1", playerEpoch: 3, expiresAt: 0, reserved: false },
    );
    assert.ok(typeof tickets.reserve(token) === "object");
    tickets.spend(token);
    assert.equal(tickets.reserve(token), undefined);
  });

  test("expire after 5 minutes", () => {
    let now = 1_000_000;
    const tickets = new JoinTickets(() => now);
    const token = tickets.mint("ROOMAAAA", "s", 1);
    now += TICKET_TTL_MS - 1;
    assert.ok(tickets.peek(token));
    now += 1;
    assert.equal(tickets.peek(token), undefined);
    assert.equal(tickets.size, 0);
  });

  test("a reserved ticket is held: nobody else reserves it, and peeking says so", () => {
    const tickets = new JoinTickets();
    const token = tickets.mint("ROOMAAAA", "s", 1);
    assert.equal(typeof tickets.reserve(token), "object");
    assert.equal(tickets.reserve(token), "reserved");
    assert.equal(tickets.peek(token)?.reserved, true);
  });

  test("release puts back a reserved ticket only while it is live and not dropped", () => {
    let now = 0;
    const tickets = new JoinTickets(() => now);
    const token = tickets.mint("ROOMAAAA", "s", 1);
    tickets.reserve(token);
    tickets.release(token);
    assert.equal(tickets.peek(token)?.reserved, false);
    tickets.reserve(token);
    now += TICKET_TTL_MS;
    tickets.release(token);
    assert.equal(tickets.peek(token), undefined);

    now = 0;
    const dropped = tickets.mint("ROOMAAAA", "s", 1);
    tickets.reserve(dropped);
    tickets.dropRoom("ROOMAAAA");
    tickets.release(dropped);
    assert.equal(tickets.peek(dropped), undefined);
  });

  test("dropRoom kills a room's tickets and no others", () => {
    const tickets = new JoinTickets();
    const a = tickets.mint("ROOMAAAA", "s", 1);
    const b = tickets.mint("ROOMBBBB", "s", 1);
    tickets.dropRoom("ROOMAAAA");
    assert.equal(tickets.peek(a), undefined);
    assert.ok(tickets.peek(b));
  });

  test("minting sweeps expired tickets", () => {
    let now = 0;
    const tickets = new JoinTickets(() => now);
    for (let i = 0; i < 10; i++) tickets.mint("ROOMAAAA", `s${i}`, 1);
    now += TICKET_TTL_MS;
    tickets.mint("ROOMAAAA", "fresh", 1);
    assert.equal(tickets.size, 1);
  });
});
