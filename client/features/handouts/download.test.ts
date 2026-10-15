import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { downloadAction, handoutFile, handoutFileName, saveBegin, saveForget, saveSettled, type SaveStates } from "./download.ts";

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

  test("a Windows device name gets a word after it, with an extension of its own too (P3R-8)", () => {
    assert.equal(handoutFileName("CON", "image/webp"), "CON handout.webp");
    assert.equal(handoutFileName("lpt1", "image/webp"), "lpt1 handout.webp");
    assert.equal(handoutFileName("CON.v2", "image/webp"), "CON handout.v2.webp");
    assert.equal(handoutFileName("nul.final draft", "image/webp"), "nul handout.final draft.webp");
    assert.equal(handoutFileName("Console", "image/webp"), "Console.webp");
    assert.equal(handoutFileName("Con the Lost Mine", "image/webp"), "Con the Lost Mine.webp");
  });

  test("a long title is cut to 100 characters, never inside an emoji", () => {
    const long = `${"a".repeat(99)}🐉 and more`;
    assert.equal(handoutFileName(long, "image/webp"), `${"a".repeat(99)}🐉.webp`);
    assert.equal(handoutFileName("x".repeat(300), "image/webp").length, 100 + ".webp".length);
  });
});

describe("Download's state, by handout and press (P3-ASTRA-03, P3-ASTRA-04, P3R-6, P3R-9)", () => {
  const none: SaveStates = {};

  test("a press's end clears its handout's entry, waits for a second tap to share, or says why it failed", () => {
    const busy = saveBegin(none, "a", 1, "busy");
    assert.deepEqual(busy, { a: { op: 1, state: "busy" } });
    assert.deepEqual(saveSettled(busy, "a", 1, "done"), {});
    assert.deepEqual(saveSettled(busy, "a", 1, "share"), { a: { op: 1, state: "share" } });
    assert.deepEqual(saveSettled(busy, "a", 1, "fetch failed"), { a: { op: 1, state: "failed", why: "fetch" } });
    assert.deepEqual(saveSettled(busy, "a", 1, "share failed"), { a: { op: 1, state: "failed", why: "share" } });
  });

  test("a share that fails after a newer press began on the same handout leaves the newer alone, and the newer's own failure still shows", () => {
    // Press 1 opens the share sheet. Press 2 begins a download of the same handout before the share's answer comes.
    let states = saveBegin(none, "a", 1, "sharing");
    states = saveBegin(states, "a", 2, "busy");
    states = saveSettled(states, "a", 1, "share failed");
    assert.deepEqual(states, { a: { op: 2, state: "busy" } }, "the late failure took the newer press's place");
    assert.deepEqual(saveSettled(states, "a", 2, "fetch failed"), { a: { op: 2, state: "failed", why: "fetch" } });
  });

  test("saving another handout leaves a download of the first, still under way after its popup closed, as it is", () => {
    let states = saveBegin(none, "a", 1, "busy");
    // Handout b saves at once through a link, as press 2.
    states = saveSettled(saveBegin(states, "b", 2, "busy"), "b", 2, "done");
    assert.deepEqual(states, { a: { op: 1, state: "busy" } }, "a lost its Downloading…, and a second tap would save it twice");
    assert.deepEqual(saveSettled(states, "a", 1, "done"), {});
  });

  test("an end with nothing under way, or for another handout's number, changes nothing", () => {
    assert.equal(saveSettled(none, "a", 3, "fetch failed"), none);
    const states = saveBegin(none, "a", 4, "busy");
    assert.equal(saveSettled(states, "b", 4, "done"), states);
  });

  test("the popup closing forgets a failure, and a download under way goes on", () => {
    const failed = saveSettled(saveBegin(none, "a", 1, "busy"), "a", 1, "fetch failed");
    assert.deepEqual(saveForget(failed, "a"), {});
    const busy = saveBegin(none, "a", 2, "busy");
    assert.equal(saveForget(busy, "a"), busy);
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
