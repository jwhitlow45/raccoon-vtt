import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { THUMBNAIL_CSP_SOURCES, isOpenverseThumbnail, isThumbnailUrl } from "./searchThumbnails.ts";

const ID = "4bc43a04-ef46-4544-a0c1-63c63f56e276";
const THUMB = `https://api.openverse.org/v1/images/${ID}/thumb/`;

describe("search thumbnail rule", () => {
  test("Google's sources pass on any path, as before", () => {
    assert.equal(isThumbnailUrl("https://serpapi.com/searches/abc/images/1.jpeg"), true);
    assert.equal(isThumbnailUrl("https://encrypted-tbn3.gstatic.com/images?q=tbn:abc"), true);
    assert.equal(isThumbnailUrl("https://encrypted-tbn4.gstatic.com/images?q=tbn:abc"), false);
  });

  test("Openverse passes only on its exact thumbnail path", () => {
    assert.equal(isThumbnailUrl(THUMB), true);
    for (const bad of [
      // Its API answers other paths on the same host.
      "https://api.openverse.org/v1/images/?q=goblin",
      `https://api.openverse.org/v1/images/${ID}/`,
      `https://api.openverse.org/v1/images/${ID}/thumb`,
      `https://api.openverse.org/v1/images/${ID}/thumb/x`,
      `https://api.openverse.org/v1/images/${ID}/thumb/?full_size=true`,
      `https://api.openverse.org/v1/images/${ID}/thumb/#x`,
      `https://api.openverse.org/v1/audio/${ID}/thumb/`,
      "https://api.openverse.org/v1/images/not-a-uuid/thumb/",
      `https://api.openverse.org/v1/images/${ID.toUpperCase()}/thumb/`,
      `http://api.openverse.org/v1/images/${ID}/thumb/`,
      `https://api.openverse.org:8443/v1/images/${ID}/thumb/`,
      `https://user@api.openverse.org/v1/images/${ID}/thumb/`,
      `https://openverse.org/v1/images/${ID}/thumb/`,
      `https://api.openverse.org.evil.example/v1/images/${ID}/thumb/`,
    ]) {
      assert.equal(isThumbnailUrl(bad), false, bad);
    }
  });

  test("an Openverse result's thumbnail must be Openverse's own, written exactly", () => {
    assert.equal(isOpenverseThumbnail(THUMB), true);
    assert.equal(isOpenverseThumbnail("https://serpapi.com/searches/abc/images/1.jpeg"), false);
    assert.equal(isOpenverseThumbnail(`https://API.openverse.org/v1/images/${ID}/thumb/`), false);
    assert.equal(isOpenverseThumbnail(`https://api.openverse.org:443/v1/images/${ID}/thumb/`), false);
  });

  test("the CSP lists each Google host and Openverse's thumbnail path", () => {
    assert.deepEqual(THUMBNAIL_CSP_SOURCES, [
      "https://serpapi.com",
      "https://encrypted-tbn0.gstatic.com",
      "https://encrypted-tbn1.gstatic.com",
      "https://encrypted-tbn2.gstatic.com",
      "https://encrypted-tbn3.gstatic.com",
      "https://api.openverse.org/v1/images/",
    ]);
  });
});
