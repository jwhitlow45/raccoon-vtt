import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BackCloser, isOverlayEntry, sameEntryBehind, withoutMark, type HistoryLike } from "./backClose.ts";

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
  replaceState(data: unknown): void {
    this.entries[this.index] = data;
  }
  /** What the Navigation API shows: the entry behind is the same page. */
  sameBehind(): boolean {
    const page = (state: unknown) => (state as { page?: string } | null)?.page;
    return this.index > 0 && page(this.entries[this.index - 1]) === page(this.state);
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

  test("a reload with a sheet open steps off the entry the sheet left where the browser shows the room's own entry behind it, so the first Back leaves the room", () => {
    // Home, then the room, then the entry of a sheet that was open when the page reloaded.
    const history = new FakeHistory();
    history.entries = [{ page: "home" }, { page: "room" }, { page: "room", rvttOverlay: true }];
    history.index = 2;
    const closer = new BackCloser(history, () => history.sameBehind());
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
    const closer = new BackCloser(history, () => history.sameBehind());
    history.onPop = (state) => closer.popped(state);
    closer.open(() => {});
    history.flush();
    assert.equal(history.index, 1);
    assert.equal(history.entries.length, 2);
    assert.ok(isOverlayEntry(history.state), "the sheet has an entry of its own");
  });

  test("a reload whose sheet mark sits on the room's own entry, with Home behind it, stays in the room: the mark comes off in place", () => {
    // A sheet's entry pushed as a reload began, written over the room's own entry (Chrome, after a phone's resize).
    const history = new FakeHistory();
    history.entries = [{ page: "home" }, { page: "room", rvttOverlay: true }];
    history.index = 1;
    const closer = new BackCloser(history, () => history.sameBehind());
    history.onPop = (state) => closer.popped(state);
    assert.equal(history.queued.length, 0, "no Back was asked for");
    history.flush();
    assert.equal(history.index, 1, "still on the room");
    assert.deepEqual(history.state, { page: "room" }, "the mark is off and the page's own state kept");
    // Sheets work as usual from here, and Back after them leaves for Home.
    let closed = 0;
    const unregister = closer.open(() => (closed += 1));
    history.userBack();
    history.flush();
    assert.equal(closed, 1);
    unregister();
    history.flush();
    history.userBack();
    history.flush();
    assert.equal((history.state as { page: string }).page, "home");
  });

  test("where the browser cannot show the entry behind, a reload with a sheet's entry also takes the mark off in place, so one more Back is needed", () => {
    const history = new FakeHistory();
    history.entries = [{ page: "home" }, { page: "room" }, { page: "room", rvttOverlay: true }];
    history.index = 2;
    const closer = new BackCloser(history);
    history.onPop = (state) => closer.popped(state);
    history.flush();
    assert.equal(history.index, 2, "the room stays where it loaded");
    assert.equal(isOverlayEntry(history.state), false);
    history.userBack();
    history.flush();
    assert.equal((history.state as { page: string }).page, "room", "the extra Back");
    history.userBack();
    history.flush();
    assert.equal((history.state as { page: string }).page, "home");
  });

  test("the mark comes off an entry with the page's own state kept, and an entry of the mark alone becomes null", () => {
    assert.deepEqual(withoutMark({ page: "room", rvttOverlay: true }), { page: "room" });
    assert.equal(withoutMark({ rvttOverlay: true }), null);
    assert.deepEqual(withoutMark({ page: "room" }), { page: "room" });
    assert.equal(withoutMark(null), null);
  });

  test("the entry behind counts as the same page only when the Navigation API shows its URL is this one", () => {
    const at = (urls: (string | null)[], index: number) => ({ currentEntry: { index, url: urls[index]! }, entries: () => urls.map((url) => ({ url })) });
    assert.equal(sameEntryBehind(at(["/r/A", "/r/A"], 1)), true);
    assert.equal(sameEntryBehind(at(["/", "/r/A"], 1)), false, "Home behind");
    assert.equal(sameEntryBehind(at([null, "/r/A"], 1)), false, "another site behind");
    assert.equal(sameEntryBehind(at(["/r/A"], 0)), false, "nothing behind");
    assert.equal(sameEntryBehind(undefined), false, "no Navigation API");
    assert.equal(sameEntryBehind({ currentEntry: null, entries: () => [] }), false);
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
