import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { downloadAction, handoutFile, handoutFileName, saveSettled, type SaveState } from "./download.ts";

describe("handoutFileName", () => {
  test("the title, with the extension of the image's type", () => {
    assert.equal(handoutFileName("Map of the crypt", "image/webp"), "Map of the crypt.webp");
    assert.equal(handoutFileName("Letter", "image/png"), "Letter.png");
    assert.equal(handoutFileName("Letter", "image/jpeg"), "Letter.jpg");
    assert.equal(handoutFileName("Letter", "IMAGE/WEBP; charset=binary"), "Letter.webp");
  });

  test("a type that says nothing usable saves as WebP, as the server stores every image", () => {
    assert.equal(handoutFileName("Letter", ""), "Letter.webp");
    assert.equal(handoutFileName("Letter", "application/octet-stream"), "Letter.webp");
  });

  test("characters a file system refuses become spaces, and the ends lose spaces and dots", () => {
    assert.equal(handoutFileName('The "Lost" Mine: part 1/2?', "image/webp"), "The Lost Mine part 1 2.webp");
    assert.equal(handoutFileName("a\\b<c>d|e*f", "image/webp"), "a b c d e f.webp");
    assert.equal(handoutFileName("  ..Secret door.. ", "image/webp"), "Secret door.webp");
    assert.equal(handoutFileName("line\none\ttab", "image/webp"), "line one tab.webp");
  });

  test("an empty title, or one with nothing left, saves as handout", () => {
    assert.equal(handoutFileName("", "image/webp"), "handout.webp");
    assert.equal(handoutFileName(" ?*/ ", "image/webp"), "handout.webp");
    assert.equal(handoutFileName("...", "image/webp"), "handout.webp");
  });

  test("a Windows device name gets a word after it", () => {
    assert.equal(handoutFileName("CON", "image/webp"), "CON handout.webp");
    assert.equal(handoutFileName("lpt1", "image/webp"), "lpt1 handout.webp");
    assert.equal(handoutFileName("Console", "image/webp"), "Console.webp");
  });

  test("a long title is cut to 100 characters, never inside an emoji", () => {
    const long = `${"a".repeat(99)}🐉 and more`;
    assert.equal(handoutFileName(long, "image/webp"), `${"a".repeat(99)}🐉.webp`);
    assert.equal(handoutFileName("x".repeat(300), "image/webp").length, 100 + ".webp".length);
  });
});

describe("saveSettled (P3-ASTRA-03, P3R-6)", () => {
  const busy = (op: number, key = "h1:1"): SaveState => ({ op, key, state: "busy" });

  test("a download's end clears its state, or marks it failed", () => {
    assert.equal(saveSettled(busy(1), 1, "done"), null);
    assert.deepEqual(saveSettled(busy(1), 1, "failed"), { op: 1, key: "h1:1", state: "failed", why: "fetch" });
  });

  test("a download goes on through the popup closing and opening again, and its end frees Download", () => {
    // Download 1 is under way when the popup closes. It keeps its state, so the handout opened again shows it working.
    const state: SaveState = busy(1);
    assert.equal(saveSettled(state, 1, "done"), null, "once it ends, Download takes a tap again");
  });

  test("an old download's end never touches a newer one", () => {
    // Download 1 for one handout, then download 2 for another, which the state now holds.
    const state = busy(2, "h2:1");
    assert.deepEqual(saveSettled(state, 1, "done"), state);
    assert.deepEqual(saveSettled(state, 1, "failed"), state);
    assert.equal(saveSettled(state, 2, "done"), null);
  });

  test("an end with nothing under way changes nothing", () => {
    assert.equal(saveSettled(null, 3, "failed"), null);
  });

  test("a fetch that ends on a device that shares waits for a second tap, and a failed fetch says why", () => {
    assert.deepEqual(saveSettled(busy(4), 4, "share"), { op: 4, key: "h1:1", state: "share" });
    assert.deepEqual(saveSettled(busy(4), 4, "failed"), { op: 4, key: "h1:1", state: "failed", why: "fetch" });
  });
});

describe("downloadAction (P3R-7)", () => {
  test("with the image in hand, a device that shares files opens the share sheet within the tap", () => {
    assert.equal(downloadAction(true, true), "share");
  });

  test("with the image in hand, a computer or a device without file sharing saves through a link", () => {
    assert.equal(downloadAction(true, false), "link");
  });

  test("without the image yet, the tap fetches it first, whatever the device", () => {
    assert.equal(downloadAction(false, true), "fetch");
    assert.equal(downloadAction(false, false), "fetch");
  });

  test("the file shared or saved is named after the handout, with the image's type", () => {
    const file = handoutFile(new Blob(["x"], { type: "image/webp" }), "Strange letter");
    assert.equal(file.name, "Strange letter.webp");
    assert.equal(file.type, "image/webp");
    assert.equal(handoutFile(new Blob(["x"]), "Letter").type, "image/webp", "a blob with no type is the WebP the server stores");
  });
});
