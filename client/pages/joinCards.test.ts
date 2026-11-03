import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { askView, joinCards } from "./joinCards.ts";

const cards = (over: Partial<Parameters<typeof joinCards>[0]>) => joinCards({ mode: "ask", picking: false, view: "password", looked: true, linked: false, ...over });

describe("the join page's cards", () => {
  test("a switch to Only by asking while Who are you? is open shows the ask card (JB-ASTRA-02)", () => {
    assert.equal(cards({ picking: true }), "pick");
    assert.equal(cards({ mode: "password", picking: true, looked: false }), "pick");
    assert.equal(cards({ mode: "ask_only", picking: true }), "ask_only");
  });

  test("in both asking modes nothing but Loading shows until the device's own request is looked up (JBO1-09)", () => {
    assert.equal(cards({ looked: false }), "loading");
    assert.equal(cards({ mode: "ask_only", looked: false }), "loading");
    assert.equal(cards({ mode: "ask_only", looked: false, linked: true }), "loading", "a link sends nothing in Only by asking");
    assert.equal(cards({ mode: "password", looked: false }), "password", "With the password looks nothing up");
    assert.equal(cards({ looked: false, linked: true }), "password", "a player link joins at once in With the password, or by asking");
  });

  test("once looked up, each mode shows its cards", () => {
    assert.equal(cards({}), "password");
    assert.equal(cards({ view: "ask" }), "ask");
    assert.equal(cards({ mode: "ask_only" }), "ask_only");
    assert.equal(cards({ mode: "password", view: "ask" }), "password");
  });

  test("a request found on load shows its card in the same render, until Back leaves it", () => {
    assert.equal(askView({ tapped: false, found: true, spent: false, linked: false }), "ask");
    assert.equal(askView({ tapped: false, found: true, spent: true, linked: false }), "password", "Back spends it");
    assert.equal(askView({ tapped: true, found: true, spent: true, linked: false }), "ask", "Ask to join after Back");
    assert.equal(askView({ tapped: false, found: true, spent: false, linked: true }), "password", "a player link joins instead");
    assert.equal(askView({ tapped: false, found: false, spent: false, linked: false }), "password");
  });
});
