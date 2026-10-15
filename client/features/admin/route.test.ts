import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute } from "../../lib/router.ts";

test("/admin opens the admin page, in production builds too", () => {
  assert.deepEqual(parseRoute("/admin", { dev: false }), { name: "admin" });
  assert.deepEqual(parseRoute("/admin/", { dev: false }), { name: "admin" });
  assert.deepEqual(parseRoute("/admin/rooms", { dev: false }), { name: "notFound" });
});
