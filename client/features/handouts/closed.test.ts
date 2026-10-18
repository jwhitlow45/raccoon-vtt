import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Handout } from "#shared/model.ts";
import { closedSlot, closedStorageKey, closeHandout, loadClosed, markSeen, openHandout, openStorageKey, rememberOpen } from "./closed.ts";
import { nextPopup, showingKey } from "./handouts.ts";

/** The device's localStorage, and the tab's sessionStorage, which a new tab starts without. */
const device = new Map<string, string>();
let tab = new Map<string, string>();
let blocked = false;
const storage = (area: () => Map<string, string>) => ({
  getItem: (k: string) => {
    if (blocked) throw new Error("blocked");
    return area().get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    if (blocked) throw new Error("blocked");
    area().set(k, String(v));
  },
  removeItem: (k: string) => {
    if (blocked) throw new Error("blocked");
    area().delete(k);
  },
});
Object.assign(globalThis, { localStorage: storage(() => device), sessionStorage: storage(() => tab) });

type Handouts = Record<string, Handout | undefined>;
const handout = (id: string, minute: number): Handout => ({ id, rev: 0, assetId: "a", title: id, to: "all", shownAt: new Date(Date.UTC(2026, 9, 17, 19, minute)).toISOString() });

/**
 * One player's Room page as HandoutPopup runs it: the closed list read,
 * then what is showing counted once the room's view is in, then the tab's
 * open handout written after each render.
 */
function openPage(handouts: Handouts, options: { preview?: boolean } = {}) {
  const store = closedSlot.create();
  const openKey = options.preview ? null : openStorageKey("ROOM", "pat");
  loadClosed(store, closedStorageKey("ROOM", "pat"));
  let view = handouts;
  const popup = () => {
    const { closed, preferId, seen } = store.getState();
    return seen ? nextPopup(view, closed, preferId, seen) : null;
  };
  const render = () => {
    markSeen(store, view, openKey);
    const shown = popup();
    rememberOpen(openKey, shown ? showingKey(shown) : null);
    return shown?.id ?? null;
  };
  render();
  return {
    popup: () => popup()?.id ?? null,
    /** A new view: a show, a close, or the snapshot a reconnect brings. */
    view(next: Handouts) {
      view = next;
      return render();
    },
    close() {
      const shown = popup();
      assert.ok(shown, "nothing to close");
      closeHandout(store, showingKey(shown), view);
      return render();
    },
    library(id: string) {
      const h = view[id];
      assert.ok(h);
      openHandout(store, h);
      return render();
    },
  };
}

function freshDevice(): void {
  device.clear();
  tab = new Map();
  blocked = false;
}

describe("a handout pops up only for a player in the room when the DM shows it", () => {
  test("handouts already showing when the page first opens the room do not pop up, and the Library opens them", () => {
    freshDevice();
    const a = handout("a", 0);
    const b = handout("b", 5);
    const page = openPage({ a, b });
    assert.equal(page.popup(), null, "a new player gets no popup after popup");
    assert.equal(page.library("a"), "a");
    assert.equal(page.close(), null, "closing it brings up no other");
  });

  test("nothing pops up before the room's view is in, and the page counts what it shows then", () => {
    freshDevice();
    const page = openPage({});
    const a = handout("a", 0);
    assert.equal(page.view({ a }), "a", "the first view was empty, so this show came while the player was in the room");
  });

  test("a show after the page opened the room pops up, the newest first", () => {
    freshDevice();
    const old = handout("old", 0);
    const page = openPage({ old });
    const a = handout("a", 10);
    assert.equal(page.view({ old, a }), "a");
    const b = handout("b", 11);
    assert.equal(page.view({ old, a, b }), "b");
    assert.equal(page.close(), "a");
    assert.equal(page.close(), null, "the one showing at load stays in the Library");
  });

  test("a handout that was showing at load pops up when the DM shows it again", () => {
    freshDevice();
    const page = openPage({ a: handout("a", 0) });
    assert.equal(page.view({ a: handout("a", 20) }), "a");
  });

  test("a show that reaches the page with a reconnect's snapshot pops up, and the earlier ones still do not", () => {
    freshDevice();
    const a = handout("a", 0);
    const page = openPage({ a });
    // The snapshot after a dropped connection: every entity new, the earlier handout among them.
    assert.equal(page.view({ a: { ...a }, b: handout("b", 30) }), "b");
    assert.equal(page.close(), null);
  });

  test("a reload in the same tab opens again the handout it had open, and nothing else that was showing", () => {
    freshDevice();
    const old = handout("old", 0);
    const first = openPage({ old });
    const a = handout("a", 10);
    const b = handout("b", 11);
    assert.equal(first.view({ old, a, b }), "b");
    const reloaded = openPage({ old, a, b });
    assert.equal(reloaded.popup(), "b", "the player comes back to the handout they were reading");
    assert.equal(reloaded.close(), null, "the one behind it waits in the Library");
    assert.equal(openPage({ old, a, b }).popup(), null, "closed, it stays closed through the next reload");
  });

  test("a reload keeps nothing open once the DM closed the handout it had open", () => {
    freshDevice();
    const page = openPage({});
    const a = handout("a", 10);
    assert.equal(page.view({ a }), "a");
    assert.equal(page.view({}), null);
    const b = handout("b", 12);
    assert.equal(openPage({ a: handout("a", 15), b }).popup(), null);
  });

  test("a new tab, or the app opened again, pops up nothing that was showing", () => {
    freshDevice();
    const page = openPage({});
    const a = handout("a", 10);
    assert.equal(page.view({ a }), "a");
    tab = new Map();
    assert.equal(openPage({ a }).popup(), null);
  });

  test("a handout opened again from the Library is the one a reload brings back", () => {
    freshDevice();
    const a = handout("a", 0);
    const b = handout("b", 1);
    const page = openPage({ a, b });
    assert.equal(page.library("a"), "a");
    assert.equal(openPage({ a, b }).popup(), "a");
  });

  test("view as a player keeps nothing for the DM's tab", () => {
    freshDevice();
    const preview = openPage({}, { preview: true });
    const a = handout("a", 10);
    assert.equal(preview.view({ a }), "a");
    assert.equal(tab.size, 0);
    assert.equal(openPage({ a }, { preview: true }).popup(), null);
  });

  test("with storage blocked, the page still counts what was showing and pops up later shows", () => {
    freshDevice();
    blocked = true;
    const a = handout("a", 0);
    const page = openPage({ a });
    assert.equal(page.popup(), null);
    const b = handout("b", 10);
    assert.equal(page.view({ a, b }), "b");
    assert.equal(page.close(), null);
  });
});

describe("handout popups through random sequences", () => {
  /*
   * Random shows, shows again, the DM's closes, the player's closes, the
   * Library's opens, reconnects, reloads and new tabs, checked against
   * what a player in the room should get. Invariants:
   * - A showing that was up when the page opened the room never pops up
   *   unless the Library opened it or the tab had it open before a reload.
   * - A showing the player closed never pops up unless the Library opened
   *   it again.
   * - Whenever some showing may pop up, one does.
   */
  test("only shows that came while the page was in the room pop up, and one always does when any may", () => {
    let seed = 20261017;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];
    for (let run = 0; run < 300; run++) {
      freshDevice();
      let minute = 0;
      let view: Handouts = {};
      let page = openPage(view);
      // The keys this page may pop up, kept apart from the code under test.
      let mayPop = new Set<string>();
      const keys = () => Object.values(view).flatMap((h) => (h ? [showingKey(h)] : []));
      for (let step = 0; step < 40; step++) {
        const roll = random();
        const ids = Object.keys(view);
        if (roll < 0.3) {
          // A show again of one showing, or a new handout.
          const id = random() < 0.4 ? (pick(ids) ?? "h0") : `h${step}`;
          const shown = handout(id, ++minute);
          view = { ...view, [id]: shown };
          mayPop.add(showingKey(shown));
          page.view(view);
        } else if (roll < 0.4 && ids.length > 0) {
          const id = pick(ids);
          view = Object.fromEntries(Object.entries(view).filter(([k]) => k !== id));
          page.view(view);
        } else if (roll < 0.6) {
          const open = page.popup();
          if (open === null) continue;
          mayPop.delete(showingKey(view[open]!));
          page.close();
        } else if (roll < 0.7 && ids.length > 0) {
          const id = pick(ids)!;
          mayPop.add(showingKey(view[id]!));
          page.library(id);
        } else if (roll < 0.8) {
          // A reconnect's snapshot: the same showings, every entity new.
          view = Object.fromEntries(Object.entries(view).map(([k, h]) => [k, h ? { ...h } : h]));
          page.view(view);
        } else if (roll < 0.9) {
          const open = page.popup();
          page = openPage(view);
          mayPop = new Set(open ? [showingKey(view[open]!)] : []);
        } else {
          tab = new Map();
          page = openPage(view);
          mayPop = new Set();
        }
        const showing = new Set(keys());
        const now = page.popup();
        const eligible = [...mayPop].filter((k) => showing.has(k));
        if (now === null) assert.equal(eligible.length, 0, `run ${run} step ${step}: ${eligible.join(", ")} should pop up`);
        else assert.ok(mayPop.has(showingKey(view[now]!)), `run ${run} step ${step}: ${now} popped up uninvited`);
      }
    }
  });
});
