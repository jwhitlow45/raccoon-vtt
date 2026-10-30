import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const { renderToStaticMarkup } = await import("react-dom/server");
const { ForgetDialog } = await import("./ForgetQuestion.tsx");

function draw(sending: boolean, held: boolean) {
  const dialog = ForgetDialog({ sending, held, answer() {} });
  return { footer: renderToStaticMarkup(dialog.props.footer), body: renderToStaticMarkup(dialog.props.children) };
}

test("FU39-B: Go ahead waits visibly for a builder hold, with Cancel still available", () => {
  const { footer, body } = draw(false, true);
  assert.match(footer, /<button[^>]*disabled=""[^>]*>Go ahead<\/button>/);
  assert.match(footer, /<button(?![^>]*disabled)[^>]*>Cancel<\/button>/);
  assert.match(body, /role="status"[^>]*>Checking players&#x27; remembered map…<\/p>/);
});

test("FU39-B: the hold ending enables Go ahead, and sending keeps the existing busy state", () => {
  assert.doesNotMatch(draw(false, false).footer, /disabled|aria-busy/);
  assert.doesNotMatch(draw(false, false).body, /Checking players/);
  assert.match(draw(true, false).footer, /aria-busy="true"/);
  assert.match(draw(true, false).footer, /Saving…/);
});

test("the memory warning covers both Play and Setup undo", () => {
  assert.match(draw(false, false).body, /neither Undo nor Undo setup in Setup history brings it back/);
});
