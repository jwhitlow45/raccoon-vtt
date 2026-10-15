import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { quietFailures, quietNotice, reportQuietFailure, type QuietPart } from "./quietFailures.ts";

const part = (subject: string, failure: QuietPart["failure"], calls: string[] = []): QuietPart => ({ subject, failure, retry: () => calls.push(subject) });

describe("the notice for quiet parts that did not load", () => {
  test("none while nothing failed, or while the page is still asking why", () => {
    assert.equal(quietNotice({}), null);
    assert.equal(quietNotice({ a: part("The height marks", "checking") }), null);
  });

  test("one part is named, and a redeploy's chunk asks for the reload that waits for queued edits", () => {
    assert.deepEqual(
      (({ subject, failure }) => ({ subject, failure }))(quietNotice({ a: part("The height marks", "updated") })!),
      { subject: "The height marks", failure: "updated" },
    );
    // A request dropped while online is worth a reload too, since Chrome keeps a failed module for the page's life.
    assert.equal(quietNotice({ a: part("The height marks", "failed") })!.failure, "failed");
    assert.equal(quietNotice({ a: part("The height marks", "offline") })!.failure, "offline");
  });

  test("several parts give one notice: the reload first, and its Retry tries every part again", () => {
    const calls: string[] = [];
    const notice = quietNotice({
      a: part("The height marks", "offline", calls),
      b: part("The explored outline", "updated", calls),
      c: part("The explored outline", "checking", calls),
    })!;
    assert.equal(notice.subject, "Parts of the map");
    assert.equal(notice.failure, "updated");
    notice.retry();
    assert.deepEqual(calls.sort(), ["The explored outline", "The height marks"]);
    // The same part failing in two places is still that part.
    assert.equal(quietNotice({ a: part("The height marks", "failed"), b: part("The height marks", "failed") })!.subject, "The height marks");
  });

  test("a part reports its failure under its own id and clears it once it loads", () => {
    reportQuietFailure("x", part("The height marks", "failed"));
    reportQuietFailure("y", part("The explored outline", "offline"));
    assert.deepEqual(Object.keys(quietFailures.getState().parts).sort(), ["x", "y"]);
    reportQuietFailure("x", null);
    reportQuietFailure("x", null);
    assert.deepEqual(Object.keys(quietFailures.getState().parts), ["y"]);
    reportQuietFailure("y", null);
    assert.equal(quietNotice(quietFailures.getState().parts), null);
  });
});
