import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { floatingTags, moves } from "./release-tags.ts";

/**
 * The floating tags a release moves (scripts/release-tags.ts), decided by
 * what X.Y and latest hold on Docker Hub, so they only ever move forward.
 */

describe("a release's floating tags", () => {
  test("the first release takes both", () => {
    assert.deepEqual(floatingTags("0.1.0", "none", "none"), { minor: true, latest: true });
  });

  test("a valid release after a newer tag whose run failed still takes both", () => {
    // v0.1.1 was pushed by mistake and its run failed, so Docker Hub holds nothing newer.
    assert.deepEqual(floatingTags("0.1.0", "none", "none"), { minor: true, latest: true });
    // v0.2.0's run failed before it tagged anything, so 0.1.1 still finds 0.1.0 everywhere.
    assert.deepEqual(floatingTags("0.1.1", "0.1.0", "0.1.0"), { minor: true, latest: true });
  });

  test("a tag that holds an older release, or this one, moves", () => {
    assert.deepEqual(floatingTags("0.1.2", "0.1.1", "0.1.1"), { minor: true, latest: true });
    assert.deepEqual(floatingTags("0.1.2", "0.1.2", "0.1.2"), { minor: true, latest: true });
  });

  test("a tag that holds a newer release stays, whichever release finished first", () => {
    assert.deepEqual(floatingTags("0.1.1", "0.1.2", "0.1.2"), { minor: false, latest: false });
    assert.deepEqual(floatingTags("0.1.0", "0.1.1", "0.2.0"), { minor: false, latest: false });
  });

  test("a patch to an older minor moves its X.Y but not latest", () => {
    assert.deepEqual(floatingTags("0.1.5", "0.1.4", "0.2.0"), { minor: true, latest: false });
  });

  test("compares as numbers", () => {
    assert.equal(moves("0.10.0", "0.9.9"), true);
    assert.equal(moves("0.9.9", "0.10.0"), false);
    assert.equal(moves("0.9.10", "0.9.9"), true);
  });

  test("fails on a version it cannot read, or an X.Y that holds another minor", () => {
    assert.throws(() => floatingTags("0.1", "none", "none"), /X\.Y\.Z/);
    assert.throws(() => floatingTags("0.1.0", "dev", "none"), /X\.Y\.Z/);
    assert.throws(() => floatingTags("0.1.0", "none", ""), /X\.Y\.Z/);
    assert.throws(() => floatingTags("0.1.3", "0.2.0", "none"), /not of that minor/);
  });

  test("prints its answer for the workflow", () => {
    const script = fileURLToPath(new URL("./release-tags.ts", import.meta.url));
    const r = spawnSync(process.execPath, [script, "0.1.5", "0.1.4", "0.2.0"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "TAG_MINOR=true\nTAG_LATEST=false\n");
    assert.notEqual(spawnSync(process.execPath, [script, "0.1.5", "garbage", "none"], { encoding: "utf8" }).status, 0);
  });
});
