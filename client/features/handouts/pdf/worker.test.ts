import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { imageFailure } from "./options.ts";

describe("the worker's warning filter (docs/design-v1-pdf-handouts.md 4.2.1)", () => {
  test("only image failures, and only while a page draws", () => {
    const line = 'Warning: Unable to decode image "img_p0_1": "JpxError: OpenJPEG failed to initialize".';
    assert.equal(imageFailure([line], true), line);
    assert.equal(imageFailure([line], false), null);
    assert.equal(imageFailure(["Warning: Image exceeded maximum allowed size and was removed."], true), "Warning: Image exceeded maximum allowed size and was removed.");
    for (const other of ["Warning: TT: undefined function: 32", "Warning: Inline DCTDecode image stream: EOI marker not found, searching for /EI/ instead.", "Unable to decode image", "Warning: getOperatorList - ignoring XObject"]) {
      assert.equal(imageFailure([other], true), null, other);
    }
    assert.equal(imageFailure([new Error("Warning: Unable to decode image")], true), null);
    assert.equal(imageFailure([], true), null);
  });
});
