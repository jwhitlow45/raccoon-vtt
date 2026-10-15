import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BackCloser, isOverlayEntry, type HistoryLike } from "./backClose.ts";

/** A session history: entries with a state, and Back that reports popstate later, as browsers do. */
class FakeHistory implements HistoryLike {
  entries: unknown[] = [{ page: "room" }];
  index = 0;
  queued: (() => void)[] = [];
  onPop: (state: unknown) => void = () => {};

  get state(): unknown {
    return this.entries[this.index];
  }
  pushState(data: unknown): void {
    this.entries = [...this.entries.slice(0, this.index + 1), data];
    this.index += 1;
  }
  /** What a router's navigate() does: a new page on top. */
  navigate(state: unknown): void {
    this.pushState(state);
  }
  back(): void {
    this.queued.push(() => {
      if (this.index === 0) return;
      this.index -= 1;
      this.onPop(this.state);
    });
  }
  /** The user's own Back. */
  userBack(): void {
    this.back();
  }
  flush(): void {
    while (this.queued.length > 0) this.queued.shift()!();
  }
}

/**
 * HandoutPopup as React runs it: closing a handout shows the next one on
 * the next render, and useBackClose registers each handout it shows, keyed
 * on the handout.
 */
function handoutPopup(closer: BackCloser, keys: string[]) {
  const queue = [...keys];
  const closed: string[] = [];
  let registered: { key: string; unregister(): void } | null = null;
  const render = () => {
    const key = queue[0] ?? null;
    if (registered?.key === key) return;
    registered?.unregister();
    registered = key === null ? null : { key, unregister: closer.open(() => closed.push(queue.shift()!)) };
  };
  render();
  return {
    closed,
    render,
    get showing() {
      return queue[0] ?? null;
    },
  };
}

function setup() {
  const history = new FakeHistory();
  const closer = new BackCloser(history);
  history.onPop = (state) => closer.popped(state);
  return { history, closer };
}

describe("Back closes what floats over the room", () => {
  test("opening a sheet adds one entry for the same page, and Back closes the sheet instead of leaving", () => {
    const { history, closer } = setup();
    let closed = 0;
    let unregister: (() => void) | null = closer.open(() => {
      closed += 1;
      unregister?.();
      unregister = null;
    });
    assert.equal(history.entries.length, 2);
    assert.ok(isOverlayEntry(history.state));
    assert.equal((history.state as { page: string }).page, "room", "the page's own state is kept");
    history.userBack();
    history.flush();
    assert.equal(closed, 1);
    assert.equal(history.index, 0, "still on the room");
  });

  test("closing with the close button takes the entry off again, and its popstate closes nothing", () => {
    const { history, closer } = setup();
    let closed = 0;
    const unregister = closer.open(() => (closed += 1));
    unregister();
    history.flush();
    assert.equal(history.index, 0);
    assert.equal(closed, 0);
    // Back now leaves the room as usual: nothing is registered.
    assert.equal(isOverlayEntry(history.state), false);
  });

  test("two layers need two Backs, the newest first", () => {
    const { history, closer } = setup();
    const order: string[] = [];
    const regs: Record<string, () => void> = {};
    const open = (name: string) => {
      regs[name] = closer.open(() => {
        order.push(name);
        regs[name]!();
      });
    };
    open("sheet");
    open("handout");
    assert.equal(history.entries.length, 2, "one entry covers both");
    history.userBack();
    history.flush();
    assert.deepEqual(order, ["handout"]);
    assert.ok(isOverlayEntry(history.state), "the sheet still open gets a new entry");
    history.userBack();
    history.flush();
    assert.deepEqual(order, ["handout", "sheet"]);
    assert.equal(history.index, 0);
  });

  test("a sheet opened again before the old entry is gone waits for it, then gets its own", () => {
    const { history, closer } = setup();
    const first = closer.open(() => {});
    first();
    // history.back() is still in flight when the next sheet opens.
    closer.open(() => {});
    assert.equal(history.entries.length, 2);
    history.flush();
    assert.equal(history.index, 1);
    assert.ok(isOverlayEntry(history.state));
  });

  test("Back drops the overlay it closed at once, so two quick Backs close two overlays before either owner lets go", () => {
    const { history, closer } = setup();
    const closed: string[] = [];
    // Owners unregister only on their next render, as React components do.
    const sheet = closer.open(() => closed.push("sheet"));
    const handout = closer.open(() => closed.push("handout"));
    history.userBack();
    history.flush();
    assert.deepEqual(closed, ["handout"]);
    assert.ok(isOverlayEntry(history.state), "the sheet under it gets its entry now");
    history.userBack();
    history.flush();
    assert.deepEqual(closed, ["handout", "sheet"]);
    assert.equal(history.index, 0);
    // The renders that follow change nothing more.
    handout();
    sheet();
    history.flush();
    assert.equal(history.index, 0);
    assert.equal(history.entries.length, 2);
  });

  test("handouts shown one after another take one Back each, and the Back after them leaves the room", () => {
    const { history, closer } = setup();
    const popup = handoutPopup(closer, ["map", "letter"]);
    history.userBack();
    history.flush();
    popup.render();
    assert.deepEqual(popup.closed, ["map"]);
    assert.equal(popup.showing, "letter");
    assert.ok(isOverlayEntry(history.state), "the next handout has an entry of its own");
    history.userBack();
    history.flush();
    popup.render();
    assert.deepEqual(popup.closed, ["map", "letter"]);
    assert.equal(popup.showing, null);
    assert.equal(history.index, 0, "still on the room");
    assert.equal(isOverlayEntry(history.state), false, "so the next Back leaves it");
  });

  test("a reload with a sheet open drops the entry the sheet left, so the first Back leaves the room", () => {
    // Home, then the room, then the entry of a sheet that was open when the page reloaded.
    const history = new FakeHistory();
    history.entries = [{ page: "home" }, { page: "room" }, { page: "room", rvttOverlay: true }];
    history.index = 2;
    const closer = new BackCloser(history);
    history.onPop = (state) => closer.popped(state);
    history.flush();
    assert.equal(history.index, 1, "back on the room's own entry");
    let closed = 0;
    // A sheet opened now gets an entry of its own, and Back closes it as usual.
    const unregister = closer.open(() => (closed += 1));
    assert.equal(history.index, 2);
    history.userBack();
    history.flush();
    assert.equal(closed, 1);
    assert.equal(history.index, 1);
    unregister();
    history.flush();
    history.userBack();
    history.flush();
    assert.equal(history.index, 0, "the next Back left the room");
  });

  test("a sheet opened before the dropped entry's popstate arrives waits for it", () => {
    const history = new FakeHistory();
    history.entries = [{ page: "room" }, { page: "room", rvttOverlay: true }];
    history.index = 1;
    const closer = new BackCloser(history);
    history.onPop = (state) => closer.popped(state);
    closer.open(() => {});
    history.flush();
    assert.equal(history.index, 1);
    assert.equal(history.entries.length, 2);
    assert.ok(isOverlayEntry(history.state), "the sheet has an entry of its own");
  });

  test("leaving the room from a sheet does not bounce back to it", () => {
    const { history, closer } = setup();
    const unregister = closer.open(() => {});
    // "Leave room" replaces the sheet's entry with Home (navigation.ts), then the room unmounts.
    history.entries[history.index] = { page: "home" };
    unregister();
    history.flush();
    assert.equal((history.state as { page: string }).page, "home");
    assert.equal(history.queued.length, 0);
  });
});
