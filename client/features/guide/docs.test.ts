import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseRoute } from "../../lib/router.ts";
import { DOCS, DOCS_PATH } from "./docs.ts";
import { GUIDE_PATH } from "./guide.ts";

describe("the Docs page's list", () => {
  test("/docs is the Docs page, with or without a trailing slash, in production builds too", () => {
    assert.equal(DOCS_PATH, "/docs");
    assert.deepEqual(parseRoute("/docs", { dev: false }), { name: "docs" });
    assert.deepEqual(parseRoute("/docs/", { dev: false }), { name: "docs" });
    assert.deepEqual(parseRoute("/docs/other", { dev: false }), { name: "notFound" });
  });

  test("the list holds the DM guide, first", () => {
    assert.equal(DOCS[0]?.path, GUIDE_PATH);
    assert.equal(DOCS[0]?.title, "DM guide");
  });

  test("every entry has a title, a one-line description, and a path that is a page of the app", () => {
    const paths = new Set<string>();
    for (const doc of DOCS) {
      assert.ok(doc.title.trim() !== "", doc.path);
      assert.ok(doc.description.trim() !== "" && !doc.description.includes("\n"), doc.path);
      assert.ok(doc.path.startsWith("/docs/"), doc.path);
      assert.notEqual(parseRoute(doc.path, { dev: false }).name, "notFound", doc.path);
      assert.ok(!paths.has(doc.path), `${doc.path} is listed once`);
      paths.add(doc.path);
    }
  });
});
