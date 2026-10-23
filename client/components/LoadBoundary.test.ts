import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * Chrome keeps a module that failed to load for the life of the page, so a
 * Retry that imports it again can never succeed there (session 1 build
 * review, SFB-P-12). Every notice for a load that failed offers the reload
 * instead, which waits for queued edits and the connection first. A part
 * that threw while rendering is no load, and a Retry renders it afresh.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { LoadFailureNotice } = await import("./LoadBoundary.tsx");

const buttons = (markup: string) => [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("a part whose code did not load", () => {
  for (const failure of ["offline", "failed", "updated"] as const) {
    test(`${failure}: offers the reload, never a Retry that imports the module again`, () => {
      const markup = renderToStaticMarkup(createElement(LoadFailureNotice, { failure, retry: () => {}, subject: "This panel", pending: 0, connection: "open" }));
      assert.deepEqual(buttons(markup), ["Reload"]);
    });
  }

  test("offline, it says the reload waits for the connection", () => {
    const markup = renderToStaticMarkup(createElement(LoadFailureNotice, { failure: "offline", retry: () => {}, subject: "This panel", pending: 0, connection: "offline" }));
    assert.match(markup, /This panel can('|&#x27;)t open while offline\. Reload once you('|&#x27;)re back online\./);
  });

  test("a part that threw while rendering keeps Retry, which renders it afresh", () => {
    const markup = renderToStaticMarkup(createElement(LoadFailureNotice, { failure: "error", retry: () => {}, subject: "This panel", pending: 0, connection: "open" }));
    assert.deepEqual(buttons(markup), ["Retry"]);
  });
});
