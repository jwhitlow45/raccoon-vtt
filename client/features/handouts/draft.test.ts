import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clientOpSchema } from "#shared/protocol.ts";
import { showDocOp } from "./draft.ts";

describe("showing a document (docs/design-v1-pdf-handouts.md 8.2)", () => {
  const pages = [
    { assetId: "p1", width: 1583, height: 2048 },
    { assetId: "p2", width: 2048, height: 1583 },
  ];

  test("its pages in order under a new handout id, checked as one image is", () => {
    const shown = showDocOp({ id: "h1", title: " Strange letter ", audience: ["p1", "p1"] }, { pages });
    assert.deepEqual(shown, { ok: true, op: { t: "handout.show", handout: { id: "h1", title: "Strange letter", to: ["p1"], pages } } });
    assert.ok(shown.ok && clientOpSchema.safeParse(shown.op).success, "the op the server takes");
    assert.deepEqual(showDocOp({ id: "h1", title: "", audience: "all" }, { pages }), { ok: false, error: "Give the handout a title." });
    assert.deepEqual(showDocOp({ id: "h1", title: "x", audience: [] }, { pages }), { ok: false, error: "Pick at least one player, or everyone." });
    assert.deepEqual(showDocOp({ id: "h1", title: "x", audience: "all" }, { pages: [] }), { ok: false, error: "That handout has no pages." });
  });
});
