import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { headerSink, PanelScrollKeeper, panelSections, panelsFor, panelSubject, RESTORE_WAIT_MS, restoreStep, scrollOf, type PanelHeader, type PanelScroll, type PanelSection } from "./panels.ts";

describe("the panels' order and groups (docs/design-v1-layout-hierarchy.md M3)", () => {
  const titles = (role: "dm" | "player", wide: boolean) => panelsFor(role, wide).map((p) => p.title);
  const groups = (role: "dm" | "player", wide: boolean) => panelsFor(role, wide).map((p) => p.group);

  test("a DM's phone: the in-play panels first, then those for preparing, then Menu", () => {
    assert.deepEqual(titles("dm", false), ["Token", "Initiative", "Party", "Dice", "Log", "Journal", "Areas", "DM", "Scenes", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"]);
    assert.deepEqual(groups("dm", false), ["play", "play", "play", "play", "play", "play", "play", "play", "play", "prepare", "prepare", "prepare", "prepare", "prepare", "room"]);
  });

  test("a DM's side panel has no Party tab: the party bar sits atop it", () => {
    assert.deepEqual(titles("dm", true), ["Token", "Initiative", "Dice", "Log", "Journal", "Areas", "DM", "Scenes", "Monsters", "Encounters", "Characters", "Outliner", "Library", "Menu"]);
  });

  test("a player's panels, phone and wide alike", () => {
    const player = ["Token", "Initiative", "Dice", "Log", "Journal", "Areas", "Characters", "Library", "Menu"];
    assert.deepEqual(titles("player", false), player);
    assert.deepEqual(titles("player", true), player);
    assert.deepEqual(groups("player", false), ["play", "play", "play", "play", "play", "play", "prepare", "prepare", "room"]);
  });

  test("the groups keep to the order's ranges, and Initiative stays the side panel's default", () => {
    for (const p of panelsFor("dm", false)) {
      if (p.group === "play") assert.ok(p.order >= 10 && p.order <= 24, p.id);
      if (p.group === "prepare") assert.ok(p.order >= 40 && p.order <= 48, p.id);
      if (p.group === "room") assert.equal(p.id, "menu");
    }
  });
});

/*
 * One grouping for a DM's phone list of panels and the side panel's More
 * (docs/design-v1-panel-tabs.md 4.1), over the whole list and over each
 * slice the tab row's fit can leave in More.
 */
describe("the panels in sections", () => {
  const shape = (sections: PanelSection[]) => sections.map((s) => [s.label ?? (s.line ? "---" : ""), s.panels.map((p) => p.title)]);

  test("a DM's whole phone list: In play and Prepare over their panels, and Menu after a line", () => {
    assert.deepEqual(shape(panelSections(panelsFor("dm", false), true)), [
      ["In play", ["Token", "Initiative", "Party", "Dice", "Log", "Journal", "Areas", "DM", "Scenes"]],
      ["Prepare", ["Monsters", "Encounters", "Characters", "Outliner", "Library"]],
      ["---", ["Menu"]],
    ]);
  });

  test("a player's list has no labels and no line", () => {
    assert.deepEqual(shape(panelSections(panelsFor("player", false), false)), [["", ["Token", "Initiative", "Dice", "Log", "Journal", "Areas", "Characters", "Library", "Menu"]]]);
    assert.deepEqual(panelSections([], false), []);
  });

  test("each slice More can hold keeps the registry's order, with a label only for a group it holds", () => {
    const dm = panelsFor("dm", true);
    for (let k = 0; k < dm.length; k++) {
      const slice = dm.slice(k);
      const sections = panelSections(slice, true);
      assert.deepEqual(
        sections.flatMap((s) => s.panels.map((p) => p.id)),
        slice.map((p) => p.id),
        `from ${k}`,
      );
      for (const s of sections) assert.ok(s.panels.every((p) => p.group === s.key), `one group a section, from ${k}`);
      assert.equal(sections.filter((s) => s.label === "In play").length, slice.some((p) => p.group === "play") ? 1 : 0, `In play from ${k}`);
      assert.equal(sections.filter((s) => s.label === "Prepare").length, slice.some((p) => p.group === "prepare") ? 1 : 0, `Prepare from ${k}`);
      assert.equal(sections.at(-1)?.line, true, "Menu is last, after a line");
    }
    assert.deepEqual(shape(panelSections(dm.slice(3), true)), [
      ["In play", ["Log", "Journal", "Areas", "DM", "Scenes"]],
      ["Prepare", ["Monsters", "Encounters", "Characters", "Outliner", "Library"]],
      ["---", ["Menu"]],
    ], "a DM's More at 1280 x 800");
    assert.deepEqual(shape(panelSections(dm.slice(9), true)), [["Prepare", ["Encounters", "Characters", "Outliner", "Library"]], ["---", ["Menu"]]]);
    assert.deepEqual(shape(panelSections(panelsFor("player", true).slice(3), false)), [["", ["Log", "Journal", "Areas", "Characters", "Library", "Menu"]]], "a player's More");
  });

  // docs/design-v1-split-panel.md 3.3: the bar's "Panel below" lists every panel the role has from 900 px up, grouped as More's.
  test("every panel from 900 px up, as the split's Panel below lists them", () => {
    assert.deepEqual(shape(panelSections(panelsFor("dm", true), true)), [
      ["In play", ["Token", "Initiative", "Dice", "Log", "Journal", "Areas", "DM", "Scenes"]],
      ["Prepare", ["Monsters", "Encounters", "Characters", "Outliner", "Library"]],
      ["---", ["Menu"]],
    ]);
    assert.deepEqual(shape(panelSections(panelsFor("player", true), false)), [["", ["Token", "Initiative", "Dice", "Log", "Journal", "Areas", "Characters", "Library", "Menu"]]]);
  });
});

/*
 * A host reused for another panel (W6-SOL-02): the phone's sheet keeps its
 * body when Initiative replaces Menu, so the host has taken Initiative's
 * listener before Menu's cleanup withdraws the Members subpage.
 */
describe("a panel's subpage and its host", () => {
  test("a withdrawal goes back to the listener the subpage was published to, never the host's latest", () => {
    const kept: Record<string, PanelHeader | null> = {};
    const listener = (id: string) => (header: PanelHeader | null) => void (kept[id] = header);
    const latest = { current: listener("menu") };
    const publish = headerSink(latest);
    const members: PanelHeader = { title: "Members", parent: "Menu", onBack: () => {} };
    const withdraw = publish(members);
    assert.equal(kept.menu, members);
    latest.current = listener("tracker");
    withdraw();
    assert.equal(kept.menu, null, "Menu's subpage is withdrawn from Menu");
    assert.equal("tracker" in kept, false, "and Initiative's entry is left alone");
    const initiative: PanelHeader = { title: "Round 2", parent: "Initiative", onBack: () => {} };
    publish(initiative);
    assert.equal(kept.tracker, initiative);
    assert.equal(kept.menu, null);
  });
});

/*
 * Each panel keeps its scroll as it leaves and shows again by any path: a
 * tab, More, a link, either pane of two, a phone's sheet (the project
 * owner, after wave 6), and content that fills in late, such as the
 * monster list, still lands it there (GR-P-1).
 */
describe("a panel's scroll as it shows again", () => {
  const box = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollLeft: 0, scrollHeight, clientHeight });
  const at = (page: string | null, scrollHeight: number, clientHeight = 500) => ({ page, scrollHeight, clientHeight });

  test("a panel left part way down goes back there, held once its content is tall enough", () => {
    const saved = scrollOf({ ...box(640), scrollLeft: 30 }, null);
    assert.deepEqual(saved, { top: 640, left: 30, end: false, page: null, subject: null });
    assert.deepEqual(restoreStep(saved, at(null, 2000)), { kind: "set", top: 640, left: 30, held: true });
    assert.deepEqual(restoreStep(saved, at(null, 600)), { kind: "set", top: 640, left: 30, held: false }, "the list has not filled in yet");
  });

  test("a panel left at its end goes to its new end, so what arrived meanwhile shows", () => {
    const saved = scrollOf(box(1500), null);
    assert.equal(saved.end, true);
    assert.deepEqual(restoreStep(saved, at(null, 2600)), { kind: "set", top: 2100, left: 0, held: true });
  });

  test("a panel at its top, or one that fit, is never at its end", () => {
    assert.equal(scrollOf(box(0), null).end, false, "scrolled back to its top");
    assert.equal(scrollOf(box(0, 400, 500), null).end, false, "it fit");
    assert.deepEqual(restoreStep(scrollOf(box(0), null), at(null, 2600)), { kind: "set", top: 0, left: 0, held: true });
  });

  test("a remembered subpage waits for its header, and nothing remembered leaves the panel's own first scroll", () => {
    const saved = scrollOf(box(300), "Journal\nlore");
    assert.deepEqual(restoreStep(saved, at(null, 2000)), { kind: "wait" }, "the page has yet to publish its header");
    assert.deepEqual(restoreStep(saved, at("Journal\nlore", 2000)), { kind: "set", top: 300, left: 0, held: true });
    assert.deepEqual(restoreStep(undefined, at(null, 2000)), { kind: "done" }, "the Log's own start at its newest line stays");
  });
});

/** A scroller whose content height a test sets, clamping as a browser does, and counting the scroll events it would fire. */
function fakeScroller(clientHeight = 300) {
  const el = {
    content: 0,
    top: 0,
    left: 0,
    events: 0,
    drawn: true,
    clientHeight,
    get scrollHeight() {
      return Math.max(this.content, this.clientHeight);
    },
    get scrollTop() {
      return this.top;
    },
    set scrollTop(v: number) {
      const next = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
      if (next !== this.top) this.events++;
      this.top = next;
    },
    get scrollLeft() {
      return this.left;
    },
    set scrollLeft(v: number) {
      this.left = v;
    },
    getClientRects() {
      return { length: this.drawn ? 1 : 0 };
    },
    /** Content that shrinks clamps the offset, and the browser says so with a scroll event. */
    setContent(px: number) {
      this.content = px;
      this.scrollTop = this.top;
    },
  };
  return el;
}

describe("the panel scroll keeper", () => {
  test("the monster list filling in after the panel draws still lands it where it was, in a short pane too, and a clamp is never kept", () => {
    const kept = new Map<string, PanelScroll>();
    const el = fakeScroller(150);
    let clock = 0;
    const keeper = new PanelScrollKeeper(kept, () => el, () => clock);
    el.setContent(4000);
    keeper.show("monsters");
    assert.equal(keeper.attempt(null), false, "nothing remembered: done at once");
    el.scrollTop = 800;
    keeper.scrolled(null);
    assert.deepEqual(kept.get("monsters"), { top: 800, left: 0, end: false, page: null, subject: null });

    // Monsters shows again: only the filter bar and "Loading the monsters…" at first, taller than the short pane.
    keeper.show("tracker");
    keeper.show("monsters");
    el.setContent(260);
    el.top = 0;
    assert.equal(keeper.attempt(null), true, "pending while the list is short");
    assert.equal(el.scrollTop, 110, "clamped for now");
    keeper.scrolled(null);
    assert.equal(kept.get("monsters")?.top, 800, "the clamp's scroll event is not kept");
    clock = 200;
    el.setContent(4000);
    assert.equal(keeper.attempt(null), false, "held, and done");
    assert.equal(el.scrollTop, 800);
    keeper.scrolled(null);
    assert.deepEqual(kept.get("monsters"), { top: 800, left: 0, end: false, page: null, subject: null });
  });

  test("the viewer taking the scroller ends the wait, and a list that fills in later never pulls them back", () => {
    const kept = new Map<string, PanelScroll>([["monsters", { top: 800, left: 0, end: false, page: null, subject: null }]]);
    const el = fakeScroller();
    const keeper = new PanelScrollKeeper(kept, () => el, () => 0);
    el.setContent(400);
    keeper.show("monsters");
    assert.equal(keeper.attempt(null), true);
    keeper.takeOver();
    el.scrollTop = 20;
    keeper.scrolled(null);
    el.setContent(4000);
    assert.equal(keeper.attempt(null), false);
    assert.equal(el.scrollTop, 20);
    assert.equal(kept.get("monsters")?.top, 20, "the viewer's place is kept from then on");
  });

  test("the wait ends after RESTORE_WAIT_MS from the first drawn try, and a scroller not drawn yet waits without frames", () => {
    const kept = new Map<string, PanelScroll>([["journal", { top: 800, left: 0, end: false, page: null, subject: null }]]);
    const el = fakeScroller();
    let clock = 0;
    const keeper = new PanelScrollKeeper(kept, () => el, () => clock);
    el.drawn = false;
    keeper.show("journal");
    assert.equal(keeper.attempt(null), false, "no frames while it has no box");
    assert.equal(keeper.waiting, true, "but still pending");
    clock = 5000;
    el.drawn = true;
    el.setContent(500);
    assert.equal(keeper.attempt(null), true, "the clock starts at the first drawn try");
    clock = 5000 + RESTORE_WAIT_MS;
    assert.equal(keeper.attempt(null), false);
    assert.equal(keeper.waiting, false);
  });
});

// A sheet outside any Room, as on the dev kit page, has no map to keep in.
describe("a panel scroll keeper with no Room", () => {
  test("keeps nothing and puts nothing back", () => {
    const el = fakeScroller();
    el.setContent(3000);
    const keeper = new PanelScrollKeeper(null, () => el, () => 0);
    keeper.show("menu");
    assert.equal(keeper.waiting, false);
    el.scrollTop = 400;
    keeper.scrolled(null);
    keeper.note(null, null);
    keeper.show("log");
    assert.equal(keeper.attempt(null), false);
    assert.equal(el.scrollTop, 400, "the scroller left as it is");
  });
});

// The coordinator's decision on the review's Q1: a panel whose subject changed opens at its top.
describe("a panel about another subject", () => {
  test("Token comes back at its place only about the token it was left on", () => {
    const kept = new Map<string, PanelScroll>();
    const el = fakeScroller();
    el.setContent(3000);
    const keeper = new PanelScrollKeeper(kept, () => el, () => 0);
    const show = (id: string, subject: string | null) => {
      keeper.show(id);
      if (id === "token") el.top = 0;
      keeper.attempt(null, subject);
      keeper.note(null, subject);
    };
    show("token", "g1");
    el.scrollTop = 200;
    keeper.scrolled(null, "g1");
    show("tracker", null);
    show("token", "g1");
    assert.equal(el.scrollTop, 200, "the same token: where it was");
    show("tracker", null);
    show("token", "g2");
    assert.equal(el.scrollTop, 0, "another token: its top");
    assert.equal(kept.get("token")?.subject, "g2", "its place is now about the token it shows");
    show("tracker", null);
    show("token", "g1");
    assert.equal(el.scrollTop, 0, "left on Goblin 2, so Goblin 1's old place is gone");
    assert.deepEqual(restoreStep({ top: 200, left: 0, end: false, page: null, subject: "g1" }, { page: null, subject: "g2", scrollHeight: 3000, clientHeight: 300 }), { kind: "done" });
  });

  test("Dice is about the selection too, since its options are the selected token's, and Log about nothing", () => {
    assert.equal(panelSubject("dice", "g1"), "g1");
    assert.equal(panelSubject("token", "g1"), "g1");
    assert.equal(panelSubject("log", "g1"), null);
  });

  test("a subject that changes in place keeps the place now about the new one", () => {
    const kept = new Map<string, PanelScroll>();
    const el = fakeScroller();
    el.setContent(3000);
    const keeper = new PanelScrollKeeper(kept, () => el, () => 0);
    keeper.show("token");
    keeper.attempt(null, "g1");
    el.scrollTop = 250;
    keeper.scrolled(null, "g1");
    keeper.note(null, "g2");
    assert.deepEqual(kept.get("token"), { top: 250, left: 0, end: false, page: null, subject: "g2" });
  });
});

/*
 * Random orders of what a panel's scroller meets: the panel shown and
 * shown again, content growing and shrinking, frames, scroll events, the
 * viewer taking over and the clock. What must always hold:
 * - no scroll is kept while a restore is pending, so a clamped offset the
 *   restore caused never replaces the place it is putting back,
 * - after the viewer takes over, the keeper never sets the offset again
 *   until a panel shows anew,
 * - no restore is pending longer than RESTORE_WAIT_MS of drawn time,
 * - a restore that ends with its content tall enough leaves the saved
 *   offset in place.
 */
describe("the panel scroll keeper under random orders", () => {
  test("its invariants hold after every step", () => {
    let seed = 0x5c011;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    for (let run = 0; run < 300; run++) {
      const kept = new Map<string, PanelScroll>();
      const el = fakeScroller(pick([150, 300, 600]));
      let clock = 0;
      const keeper = new PanelScrollKeeper(kept, () => el, () => clock);
      let shown: string | null = null;
      let tookOver = false;
      let pendingSince: number | null = null;
      const steps: string[] = [];
      for (let step = 0; step < 60; step++) {
        const kind = pick(["show", "content", "attempt", "attempt", "scroll", "viewer", "tick", "draw"] as const);
        const before: { top: number; saved: PanelScroll | undefined } = { top: el.scrollTop, saved: shown === null ? undefined : kept.get(shown) };
        let setByKeeper = false;
        if (kind === "show") {
          const id = pick(["log", "monsters", "journal"]);
          if (id !== shown) {
            tookOver = false;
            pendingSince = null;
          }
          shown = id;
          keeper.show(id);
          el.top = 0;
          // The hook always tries right after a panel shows, in the same layout effect.
          const top = el.scrollTop;
          keeper.attempt(null);
          setByKeeper = el.scrollTop !== top;
          if (keeper.waiting && el.getClientRects().length > 0) pendingSince ??= clock;
          steps.push(`show ${id}`);
        } else if (kind === "content") {
          el.setContent(pick([0, 200, 900, 3000]));
          steps.push(`content ${el.content}`);
        } else if (kind === "attempt") {
          const top = el.scrollTop;
          keeper.attempt(null);
          setByKeeper = el.scrollTop !== top;
          if (keeper.waiting && el.getClientRects().length > 0) pendingSince ??= clock;
          steps.push("attempt");
        } else if (kind === "scroll") {
          const waiting = keeper.waiting;
          const saved: PanelScroll | undefined = shown === null ? undefined : kept.get(shown);
          el.scrollTop = Math.floor(random() * 3000);
          keeper.scrolled(null);
          if (waiting) assert.equal(shown === null ? undefined : kept.get(shown), saved, `a scroll was kept while pending: ${steps.join(", ")}`);
          steps.push("scroll");
        } else if (kind === "viewer") {
          keeper.takeOver();
          tookOver = true;
          steps.push("viewer");
        } else if (kind === "tick") {
          clock += pick([16, 200, 600]);
          steps.push("tick");
        } else {
          el.drawn = !el.drawn;
          steps.push(`drawn ${el.drawn}`);
        }
        const at = steps.join(", ");
        if (tookOver) assert.ok(!setByKeeper, `the keeper moved the scroller after the viewer took it: ${at}`);
        if (!keeper.waiting) pendingSince = null;
        if (pendingSince !== null) assert.ok(clock - pendingSince <= RESTORE_WAIT_MS + 600, `pending too long: ${at}`);
        if (kind === "attempt" && !keeper.waiting && before.saved && !before.saved.end && el.scrollHeight - el.clientHeight >= before.saved.top - 1 && setByKeeper)
          assert.equal(el.scrollTop, before.saved.top, `held, but not at the saved place: ${at}`);
      }
    }
  });
});
