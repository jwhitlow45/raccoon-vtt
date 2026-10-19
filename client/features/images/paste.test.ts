import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nameGivesSize } from "../grid/findGrid.ts";
import { boxLine, clipboardImage, holdsImage, isStandInName, NO_IMAGE, pasteError, pastedFile, severalImages, type ClipItem, type PasteData } from "./paste.ts";

const png = (name = "image.png") => new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
const jpeg = (name = "photo.jpeg") => new File([new Uint8Array([255, 216, 255])], name, { type: "image/jpeg" });
const svg = (name = "logo.svg") => new File(["<svg/>"], name, { type: "image/svg+xml" });
const pdf = (name = "letter.pdf") => new File(["%PDF-1.7"], name, { type: "application/pdf" });

/** A paste event's DataTransfer: files in `files`, or only as file items, as some browsers hand them over, and text by type. */
function transfer(input: { files?: File[]; itemFiles?: File[]; text?: Record<string, string> }): PasteData {
  const text = input.text ?? {};
  const items = [
    ...(input.itemFiles ?? input.files ?? []).map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
    ...Object.keys(text).map((type) => ({ kind: "string", type, getAsFile: () => null })),
  ];
  return {
    files: input.files ?? [],
    items,
    types: [...(input.files?.length || input.itemFiles?.length ? ["Files"] : []), ...Object.keys(text)],
    getData: (type) => text[type] ?? "",
  };
}

function item(parts: Record<string, Blob | string>): ClipItem {
  return {
    types: Object.keys(parts),
    getType: async (type) => {
      const part = parts[type];
      if (part === undefined) throw new DOMException("no such type", "NotFoundError");
      return typeof part === "string" ? new Blob([part], { type }) : part;
    },
  };
}

describe("an image from a paste event", () => {
  test("the first image of several is used, and the count of them says how many there were", () => {
    const first = png("first.png");
    const pasted = clipboardImage(transfer({ files: [first, jpeg(), png("third.png")] }), "image");
    assert.equal(pasted.kind, "file");
    assert.ok(pasted.kind === "file");
    assert.equal(pasted.blob, first);
    assert.equal(pasted.name, "first.png");
    assert.equal(pasted.images, 3);
    assert.equal(severalImages(pasted.images), "The clipboard held 3 images. The first one was used.");
    assert.equal(severalImages(1), null);
  });

  test("the files come first, and a file item's own file when the files list is empty", () => {
    const listed = png("listed.png");
    const fromList = clipboardImage(transfer({ files: [listed], itemFiles: [png("item.png")] }), "image");
    assert.ok(fromList.kind === "file" && fromList.blob === listed);
    const onlyItem = png("item.png");
    const fromItem = clipboardImage(transfer({ itemFiles: [onlyItem] }), "image");
    assert.ok(fromItem.kind === "file" && fromItem.blob === onlyItem);
  });

  test("SVG is skipped beside another image, and an SVG alone is refused in its own words", () => {
    const keep = png("keep.png");
    const mixed = clipboardImage(transfer({ files: [svg(), keep] }), "image");
    assert.ok(mixed.kind === "file" && mixed.blob === keep && mixed.images === 1);
    assert.deepEqual(clipboardImage(transfer({ files: [svg()] }), "image"), { kind: "none", why: "svg" });
    assert.equal(pasteError("svg"), "SVG images are not supported. Use a JPEG, PNG, WebP, GIF or AVIF image.");
  });

  test("a PDF is taken only where a PDF is, and is not an image anywhere else", () => {
    const letter = pdf();
    const handout = clipboardImage(transfer({ files: [letter] }), "image-or-pdf");
    assert.ok(handout.kind === "file" && handout.blob === letter && handout.name === "letter.pdf");
    assert.deepEqual(clipboardImage(transfer({ files: [pdf()] }), "image"), { kind: "none", why: "notImage" });
    assert.deepEqual(clipboardImage(transfer({ files: [new File(["x"], "notes.txt", { type: "text/plain" })] }), "image-or-pdf"), { kind: "none", why: "notImage" });
    assert.equal(pasteError("notImage"), "That file is not an image.");
  });

  test("a file with no type is an image when its name says so", () => {
    const untyped = new File([new Uint8Array([1])], "crypt_30x20.webp");
    const pasted = clipboardImage(transfer({ files: [untyped] }), "image");
    assert.ok(pasted.kind === "file" && pasted.blob === untyped);
  });

  test("an https link is taken only by Choose an image, and an http one never", () => {
    const https = transfer({ text: { "text/plain": "  https://example.com/goblin.png  " } });
    assert.deepEqual(clipboardImage(https, "image-or-link"), { kind: "link", url: "https://example.com/goblin.png" });
    assert.deepEqual(clipboardImage(https, "image"), { kind: "none", why: "link" });
    assert.deepEqual(clipboardImage(https, "image-or-pdf"), { kind: "none", why: "link" });
    assert.deepEqual(clipboardImage(transfer({ text: { "text/plain": "http://example.com/goblin.png" } }), "image-or-link"), { kind: "none", why: "insecureLink" });
    assert.equal(pasteError("link"), "That is a link, not an image. Copy the image itself, or save it and choose the file.");
  });

  test("copied markup with an <img> and no bytes is refused, and beside the bytes it is ignored", () => {
    const page = { "text/html": '<p>Goblin</p><img src="https://example.com/goblin.png">', "text/plain": "Goblin" };
    assert.deepEqual(clipboardImage(transfer({ text: page }), "image"), { kind: "none", why: "page" });
    assert.equal(pasteError("page"), "That copied part of a page, not the image. Use Copy image on the image instead.");
    const bytes = png();
    const copied = clipboardImage(transfer({ files: [bytes], text: { "text/html": '<img src="https://example.com/goblin.png">' } }), "image");
    assert.ok(copied.kind === "file" && copied.blob === bytes);
  });

  test("text alone and nothing at all have no image in them", () => {
    assert.deepEqual(clipboardImage(transfer({ text: { "text/plain": "a goblin with a spear" } }), "image"), { kind: "none", why: "empty" });
    assert.deepEqual(clipboardImage(transfer({}), "image-or-link"), { kind: "none", why: "empty" });
    assert.equal(pasteError("empty"), NO_IMAGE);
  });

  test("only an image file counts as an image for the room's own offer", () => {
    assert.equal(holdsImage(transfer({ files: [png()] })), true);
    assert.equal(holdsImage(transfer({ itemFiles: [jpeg()] })), true);
    assert.equal(holdsImage(transfer({ files: [svg()] })), false);
    assert.equal(holdsImage(transfer({ files: [pdf()] })), false);
    assert.equal(holdsImage(transfer({ text: { "text/plain": "https://example.com/goblin.png" } })), false);
  });
});

describe("an image from clipboard.read()", () => {
  test("PNG is chosen over the other types of an item", async () => {
    const asPng = png();
    const pasted = await clipboardImage([item({ "text/html": "<img>", "image/jpeg": jpeg(), "image/png": asPng })], "image");
    assert.ok(pasted.kind === "file" && pasted.blob === asPng && pasted.name === null && pasted.images === 1);
  });

  test("another image type is used when there is no PNG, SVG never", async () => {
    const asJpeg = jpeg();
    const jpegOnly = await clipboardImage([item({ "image/svg+xml": svg(), "image/jpeg": asJpeg })], "image");
    assert.ok(jpegOnly.kind === "file" && jpegOnly.blob === asJpeg);
    assert.deepEqual(await clipboardImage([item({ "image/svg+xml": svg() })], "image"), { kind: "none", why: "svg" });
  });

  test("several items each with an image are counted, and the first is used", async () => {
    const first = png("a.png");
    const pasted = await clipboardImage([item({ "image/png": first }), item({ "image/png": png("b.png") })], "image");
    assert.ok(pasted.kind === "file" && pasted.blob === first && pasted.images === 2);
  });

  test("text, a link and copied markup read as from a paste event", async () => {
    assert.deepEqual(await clipboardImage([item({ "text/plain": "https://example.com/a.webp" })], "image-or-link"), { kind: "link", url: "https://example.com/a.webp" });
    assert.deepEqual(await clipboardImage([item({ "text/plain": "https://example.com/a.webp" })], "image"), { kind: "none", why: "link" });
    assert.deepEqual(await clipboardImage([item({ "text/html": "<img src=x>" })], "image"), { kind: "none", why: "page" });
    assert.deepEqual(await clipboardImage([item({ "text/plain": "hello" })], "image"), { kind: "none", why: "empty" });
  });

  test("an empty list has no image in it", async () => {
    assert.deepEqual(await clipboardImage([], "image"), { kind: "none", why: "empty" });
  });
});

describe("the pasted file's name", () => {
  const time = () => "2:32 PM";
  const now = new Date(2026, 9, 18, 14, 32);

  test("a browser's stand-in name gives way to the time it was pasted", () => {
    for (const name of ["image.png", "Image.PNG", "image.jpeg", "blob", "Pasted Graphic.png", "Pasted Graphic 2.png", "image0.png", "untitled.png"]) {
      assert.equal(isStandInName(name), true, name);
      assert.equal(pastedFile(png(name), name, now, time).name, "Pasted image 2:32 PM.png", name);
    }
  });

  test("a nameless blob from read() is named the same way, with the extension of its type", () => {
    assert.equal(pastedFile(new Blob([new Uint8Array([1])], { type: "image/png" }), null, now, time).name, "Pasted image 2:32 PM.png");
    assert.equal(pastedFile(new Blob([new Uint8Array([1])], { type: "image/jpeg" }), null, now, time).name, "Pasted image 2:32 PM.jpg");
    assert.equal(pastedFile(new Blob([new Uint8Array([1])], { type: "image/webp" }), "", now, time).name, "Pasted image 2:32 PM.webp");
  });

  test("a real name stays, and keeps its powers: crypt_30x20.png still sets the scale", () => {
    const file = png("crypt_30x20.png");
    const kept = pastedFile(file, file.name, now, time);
    assert.equal(kept, file, "the file itself goes on, untouched");
    assert.equal(nameGivesSize(kept.name), true);
    assert.equal(isStandInName("goblin boss.png"), false);
    assert.equal(isStandInName("image of a goblin.png"), false);
    assert.equal(pastedFile(png(), "Goblin boss.png", now, time).name, "Goblin boss.png");
  });

  test("the file keeps its type, so the upload sends it as the image it is", () => {
    const named = pastedFile(new Blob([new Uint8Array([1])], { type: "image/gif" }), null, now, time);
    assert.equal(named.type, "image/gif");
    assert.equal(named.name, "Pasted image 2:32 PM.gif");
  });

  test("the time comes out in the device's own words with plain spaces", () => {
    const named = pastedFile(png(), "image.png", now);
    assert.match(named.name, /^Pasted image \S.*\.png$/);
    assert.doesNotMatch(named.name, /[  ]/);
  });
});

describe("the paste box's line", () => {
  test("a phone presses and holds, a computer pastes with its own key", () => {
    assert.equal(boxLine({ touch: true, apple: true }), "Press and hold here, then tap Paste.");
    assert.equal(boxLine({ touch: false, apple: false }), "Press Ctrl+V, or right-click here and choose Paste.");
    assert.equal(boxLine({ touch: false, apple: true }), "Press Cmd+V, or right-click here and choose Paste.");
  });
});
