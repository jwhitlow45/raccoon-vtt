import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * The Library's View opens any image it lists in the handout viewer
 * (docs/design-v1-layout-hierarchy.md 5.3): the largest copy the row lists,
 * under the title of a handout showing it, or else what the image is.
 */

const { viewTitle, viewVariant } = await import("./LibraryGrid.tsx");

const row = (kind: "map" | "token" | "handout", variants: ("full" | "mobile" | "thumb")[] = ["full", "thumb"]) => ({ id: "a", kind, width: 100, height: 100, variants });

describe("viewing a library image", () => {
  test("loads the full copy when the row lists it, else the largest one listed", () => {
    assert.equal(viewVariant(row("map", ["full", "mobile", "thumb"])), "full");
    assert.equal(viewVariant(row("map", ["thumb", "mobile"])), "mobile");
    assert.equal(viewVariant(row("token", ["thumb"])), "thumb");
    assert.equal(viewVariant(undefined), "full");
  });

  test("is titled by a handout showing the image, the one shown last, else by its kind", () => {
    const handouts = [
      { assetId: "a", title: "The letter", shownAt: "2026-10-15T20:00:00.000Z" },
      { assetId: "a", title: "The letter, again", shownAt: "2026-10-15T21:00:00.000Z" },
      { assetId: "b", title: "Another", shownAt: "2026-10-15T22:00:00.000Z" },
    ];
    assert.equal(viewTitle("a", row("handout"), handouts), "The letter, again");
    assert.equal(viewTitle("c", row("handout"), handouts), "Handout");
    assert.equal(viewTitle("c", row("map"), handouts), "Map");
    assert.equal(viewTitle("c", row("token"), []), "Token image");
    assert.equal(viewTitle("c", undefined, []), "Token image");
  });
});
