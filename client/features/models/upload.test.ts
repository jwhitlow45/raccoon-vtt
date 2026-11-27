import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../../lib/api.ts";
import { meanColor, modelUploadWords, pictureColor } from "./upload.ts";

/** A model's uploads (docs/design/design-v1-token-models.md 3.1, 4.3, D-261127-615): the refusals' words and Picture's color. */

describe("a model's upload refusals", () => {
  test("bad_model_sheet says to draw it again, too_large names the sheet's own cap, and the rest read as an image's", () => {
    assert.equal(modelUploadWords(new ApiError(422, "x", "bad_model_sheet", null)), "The model's views came out the wrong shape, so the server refused them. Choose the file again.");
    assert.equal(modelUploadWords(new ApiError(413, "x", "too_large", null)), "The model's views came out over 10 MB. Choose the file again at a smaller Size.");
    assert.equal(modelUploadWords(new ApiError(429, "x", "rate_limited", null)), "Too many images in a short time. Wait a little and try again.");
  });
});

describe("Picture's color", () => {
  test("an icon's own disk color, lower case, and none for a color the protocol would not have", async () => {
    assert.equal(await pictureColor({ icon: "lorc/wolf-head", color: "#AA2200" }, () => ""), "#aa2200");
    assert.equal(await pictureColor({ icon: "lorc/wolf-head", color: "red" }, () => ""), null);
  });

  test("an upload's mean color weighs each pixel by its alpha and leaves clear ones out", () => {
    const px = (r: number, g: number, b: number, a: number) => [r, g, b, a];
    assert.equal(meanColor([...px(255, 0, 0, 255), ...px(0, 0, 255, 255)]), "#800080");
    assert.equal(meanColor([...px(255, 0, 0, 255), ...px(0, 255, 0, 0)]), "#ff0000", "a clear pixel adds nothing");
    assert.equal(meanColor([...px(10, 20, 30, 0)]), null, "all clear");
  });
});
