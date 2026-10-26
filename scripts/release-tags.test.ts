import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { floatingTags } from "./release-tags.ts";

/** The floating tags a release moves (scripts/release-tags.ts), so `latest` and `X.Y` only ever move forward. */

describe("a release's floating tags", () => {
  test("the first release takes both", () => {
    assert.deepEqual(floatingTags("0.1.0", ["v0.1.0"]), { latest: true, minor: true });
  });

  test("the newest release takes both, compared as numbers", () => {
    assert.deepEqual(floatingTags("0.10.0", ["v0.9.9", "v0.10.0", "v0.2.0"]), { latest: true, minor: true });
    assert.deepEqual(floatingTags("0.9.10", ["v0.9.9", "v0.9.10"]), { latest: true, minor: true });
  });

  test("an older release that finishes last moves nothing, whichever order the runs end in", () => {
    // v0.1.1 and v0.1.2 both pushed: each run reads the tags when it publishes.
    const tags = ["v0.1.0", "v0.1.1", "v0.1.2"];
    for (const order of [["0.1.1", "0.1.2"], ["0.1.2", "0.1.1"]]) {
      const moved = new Map<string, string>();
      for (const v of order) {
        const t = floatingTags(v, tags);
        if (t.latest) moved.set("latest", v);
        if (t.minor) moved.set("0.1", v);
      }
      assert.deepEqual(Object.fromEntries(moved), { latest: "0.1.2", "0.1": "0.1.2" }, `finished ${order.join(" then ")}`);
    }
  });

  test("a re-run of an older release moves nothing", () => {
    assert.deepEqual(floatingTags("0.1.0", ["v0.1.0", "v0.1.1"]), { latest: false, minor: false });
  });

  test("a patch to an older minor moves its X.Y but not latest", () => {
    assert.deepEqual(floatingTags("0.1.5", ["v0.1.4", "v0.1.5", "v0.2.0"]), { latest: false, minor: true });
    assert.deepEqual(floatingTags("0.2.0", ["v0.1.4", "v0.1.5", "v0.2.0"]), { latest: true, minor: true });
  });

  test("ignores tags that are not exactly vX.Y.Z", () => {
    assert.deepEqual(floatingTags("0.1.0", ["v0.1.0", "v0.2.0-rc.1", "v1.0", "release-9.9.9", "v9.9.9x", "0.9.0"]), { latest: true, minor: true });
  });

  test("refuses a list without the release's own tag, or a version that is not X.Y.Z", () => {
    assert.throws(() => floatingTags("0.1.1", ["v0.1.0"]), /no v0\.1\.1/);
    assert.throws(() => floatingTags("0.1", ["v0.1"]), /X\.Y\.Z/);
  });

  test("prints its answer for the workflow, from tags on stdin", () => {
    const script = fileURLToPath(new URL("./release-tags.ts", import.meta.url));
    const r = spawnSync(process.execPath, [script, "0.1.5"], { input: "v0.1.5\nv0.2.0\n", encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "TAG_LATEST=false\nTAG_MINOR=true\n");
  });
});
