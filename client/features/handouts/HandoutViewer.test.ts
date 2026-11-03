import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { decoderLeases, leaseDecoder, resetDecoderForTests } from "../animmap/status.ts";

/*
 * The Library viewer's video page (docs/design/design-v1-animated-maps.md 4.6
 * and 5.2): it takes the window's one decoder before it sets its `src`, so
 * the board's element and the viewer's never both hold one.
 */

const { holdViewerVideo } = await import("./HandoutViewer.tsx");

class FakeVideo {
  muted = false;
  src = "";
  log: string[] = [];
  attrs = new Set<string>();
  setAttribute(name: string) {
    this.attrs.add(name);
    if (name === "muted") this.log.push("muted");
  }
  removeAttribute(name: string) {
    if (name === "src") {
      this.src = "";
      this.log.push("clear");
    }
  }
  load() {
    this.log.push("load");
  }
  pause() {
    this.log.push("pause");
  }
  play() {
    this.log.push(`play ${this.src}`);
    return Promise.resolve();
  }
}

/** The board's element as the controller holds it: a src while granted, cleared on a yield. */
function board() {
  const el = { src: "" };
  const lease = leaseDecoder("board", {
    onGrant: () => {
      el.src = "/board";
    },
    onYield: (held) => {
      el.src = "";
      held.release();
    },
  });
  return { el, lease };
}

beforeEach(() => resetDecoderForTests());

describe("the viewer's video and the window's one decoder", () => {
  test("with nothing else holding it, the viewer mutes, then sets its src and plays", () => {
    const v = new FakeVideo();
    const release = holdViewerVideo(v, "/a/v1/full");
    assert.equal(v.muted, true);
    assert.deepEqual(v.log, ["muted", "play /a/v1/full"]);
    release();
    assert.equal(v.src, "");
    assert.deepEqual(v.log.slice(-3), ["pause", "clear", "load"]);
    assert.deepEqual(decoderLeases(), []);
  });

  test("a playing board yields first: its src is clear before the viewer's is set, and it plays again once the viewer closes", () => {
    const b = board();
    assert.equal(b.el.src, "/board");
    const v = new FakeVideo();
    const release = holdViewerVideo(v, "/a/v1/full");
    assert.equal(b.el.src, "", "the board let go");
    assert.equal(v.src, "/a/v1/full");
    // The board asks again while the viewer plays, and waits: it never takes the decoder from the viewer.
    const again = board();
    assert.equal(again.el.src, "");
    assert.equal([v.src, again.el.src].filter((s) => s !== "").length, 1, "one element holds a src");
    release();
    assert.equal(v.src, "");
    assert.equal(again.el.src, "/board", "the board plays again");
  });

  test("a second viewer page takes over, and the first clears its src before the second sets its own", () => {
    const first = new FakeVideo();
    holdViewerVideo(first, "/a/v1/full");
    const order: string[] = [];
    const second = new FakeVideo();
    let held = "";
    Object.defineProperty(second, "src", {
      get: () => held,
      set: (v: string) => {
        if (v !== "") order.push(`first ${first.src === "" ? "clear" : "held"}`);
        held = v;
      },
    });
    holdViewerVideo(second, "/a/v2/full");
    assert.equal(first.src, "");
    assert.deepEqual(order, ["first clear"]);
    assert.equal(second.src, "/a/v2/full");
  });
});
