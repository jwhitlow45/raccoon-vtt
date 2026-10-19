import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ClipItem, PasteData } from "./paste.ts";
import { PasteControl, pasteTarget, type PasteCandidate, type PasteInput, type PasteSpec, type PasteTake } from "./pasteRouter.ts";

/**
 * A page element as the choice reads it: its place in the tree, whether it
 * is hidden there, and what a text field check reads. `legacy` leaves out
 * `checkVisibility`, as Safari before 17.4 does, so the boxes tell.
 */
class El {
  readonly parent: El | null;
  hidden = false;
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
  checkVisibility?: () => boolean;
  constructor(parent: El | null, opts: { tag?: string; type?: string; hidden?: boolean; legacy?: boolean } = {}) {
    this.parent = parent;
    this.tagName = opts.tag ?? "DIV";
    if (opts.type) this.type = opts.type;
    this.hidden = opts.hidden ?? false;
    if (!opts.legacy) this.checkVisibility = () => this.#shown();
  }
  #shown(): boolean {
    for (let n: El | null = this; n; n = n.parent) if (n.hidden) return false;
    return true;
  }
  contains(other: unknown): boolean {
    for (let n = other instanceof El ? other : null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  getClientRects(): { length: number } {
    return { length: this.#shown() ? 1 : 0 };
  }
}

const body = new El(null, { tag: "BODY" });
const room = new El(body);
const panel = new El(room);

let seq = 0;
function target(name: string, el: El | null, takes: PasteTake = "open"): PasteCandidate<string> {
  return { el, takes, seq: ++seq, value: name };
}

function input(over: Partial<PasteInput<string>>): PasteInput<string> {
  return { defaultPrevented: false, preview: false, at: body, hasText: false, hasFiles: true, hasImage: true, modals: [], targets: [], roomOffer: false, ...over };
}

const chosen = (over: Partial<PasteInput<string>>) => {
  const c = pasteTarget(input(over));
  return c === null ? null : c.kind === "room" ? "room" : c.target;
};

describe("which entry takes a paste", () => {
  test("with a dialog open, only an entry inside the newest one, and none outside it", () => {
    const older = new El(body, { tag: "DIALOG" });
    const newest = new El(body, { tag: "DIALOG" });
    const picker = new El(newest);
    const behind = target("new scene", new El(panel));
    assert.equal(chosen({ modals: [older, newest], targets: [behind, target("picker", picker), target("older dialog", new El(older))] }), "picker");
    // Nothing inside the newest dialog: nothing happens, and the room behind it never gets the paste.
    assert.equal(chosen({ modals: [newest], targets: [behind], roomOffer: true }), null);
  });

  test("the entry holding the focus comes before the newest open one", () => {
    const sceneRow = new El(panel);
    const button = new El(sceneRow, { tag: "BUTTON" });
    const handout = target("handout", new El(panel));
    const row = target("map image", sceneRow, "focus");
    assert.equal(chosen({ at: button, targets: [row, handout] }), "map image");
    assert.equal(chosen({ at: body, targets: [row, handout] }), "handout", "the row takes a key paste only with focus in it");
  });

  test("of several open entries, the newest", () => {
    const first = target("new scene", new El(panel));
    const second = target("handout", new El(panel));
    assert.equal(chosen({ targets: [second, first].sort((a, b) => a.seq - b.seq) }), "handout");
  });

  test("the innermost of two entries that both hold the focus", () => {
    const outer = new El(panel);
    const inner = new El(outer);
    const button = new El(inner, { tag: "BUTTON" });
    assert.equal(chosen({ at: button, targets: [target("inner", inner), target("outer", outer)] }), "inner");
  });

  test("a preview page and a paste already handled get nothing", () => {
    const entry = target("new scene", new El(panel));
    assert.equal(chosen({ preview: true, targets: [entry], roomOffer: true }), null);
    assert.equal(chosen({ defaultPrevented: true, targets: [entry], roomOffer: true }), null);
  });

  test("a text field keeps a paste with text, and passes an image alone to the entry around it", () => {
    const form = new El(panel);
    const name = new El(form, { tag: "INPUT", type: "text" });
    const chat = new El(room, { tag: "TEXTAREA" });
    const entry = target("new scene", form);
    assert.equal(chosen({ at: name, hasText: true, targets: [entry] }), null, "the field's own paste");
    assert.equal(chosen({ at: name, hasText: true, hasFiles: true, targets: [entry] }), null, "an image beside text is the field's too");
    assert.equal(chosen({ at: name, targets: [entry] }), "new scene", "an image alone lands in the entry around the field");
    assert.equal(chosen({ at: chat, targets: [entry], roomOffer: true }), null, "a field outside every entry keeps it, and the room's offer never fires");
    assert.equal(chosen({ at: name, hasFiles: false, hasImage: false, targets: [entry] }), null, "an empty paste in a field is the field's");
    const box = new El(form);
    box.isContentEditable = true;
    assert.equal(chosen({ at: box, hasText: true, targets: [entry] }), null, "editable content counts as a field");
  });

  test("a chosen entry that is disabled still takes the paste, which passes to no other entry and not to the room", () => {
    const busy = target("uploading new scene", new El(panel));
    const other = target("older handout", new El(panel));
    other.seq = 0;
    assert.equal(chosen({ targets: [other, busy], roomOffer: true }), "uploading new scene");
  });

  test("an entry inside a hidden part is never chosen, with checkVisibility or without it", () => {
    const hiddenPanel = new El(room, { hidden: true });
    assert.equal(chosen({ targets: [target("hidden", new El(hiddenPanel))], roomOffer: true }), "room");
    // A closed sheet, still mounted, with no [hidden] on it, in a browser with no checkVisibility.
    const closedSheet = new El(room, { tag: "DIALOG", hidden: true, legacy: true });
    const form = new El(closedSheet, { legacy: true });
    assert.equal(chosen({ targets: [target("in a closed sheet", form)], roomOffer: true }), "room");
    const openSheet = new El(room, { tag: "DIALOG", legacy: true });
    assert.equal(chosen({ targets: [target("in an open sheet", new El(openSheet, { legacy: true }))] }), "in an open sheet");
  });

  test("a confirmed Map image row with focus elsewhere, and the players' unconfirmed row with focus in it, both get nothing", () => {
    const confirmed = new El(panel);
    const unconfirmed = new El(panel);
    const inside = new El(unconfirmed, { tag: "BUTTON" });
    assert.equal(chosen({ at: body, targets: [target("confirmed row", confirmed, "focus")] }), null);
    assert.equal(chosen({ at: inside, targets: [target("players' row", unconfirmed, "none")] }), null);
  });

  test("the room's offer takes an image no entry took, and only an image, only with no dialog open", () => {
    assert.equal(chosen({ roomOffer: true }), "room");
    assert.equal(chosen({ roomOffer: true, hasImage: false }), null, "text, a link or part of a page does nothing at all");
    assert.equal(chosen({ roomOffer: false }), null, "a player has no offer");
    assert.equal(chosen({ roomOffer: true, modals: [new El(body, { tag: "DIALOG" })] }), null);
  });
});

/** A paste event's data holding one PNG, or text. */
function eventData(kind: "image" | "text"): PasteData {
  const file = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
  return kind === "image"
    ? { files: [file], items: [{ kind: "file", type: "image/png", getAsFile: () => file }], types: ["Files"], getData: () => "" }
    : { files: [], items: [{ kind: "string", type: "text/plain", getAsFile: () => null }], types: ["text/plain"], getData: (t) => (t === "text/plain" ? "hello" : "") };
}

function clipItems(kind: "image" | "text"): ClipItem[] {
  return kind === "image"
    ? [{ types: ["image/png"], getType: async () => new Blob([new Uint8Array([1])], { type: "image/png" }) }]
    : [{ types: ["text/plain"], getType: async () => new Blob(["hello"], { type: "text/plain" }) }];
}

/** A seeded random number, so a failing sequence can be run again. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("one entry's paste", () => {
  function harness(opts: { read?: boolean; ios?: boolean } = {}) {
    const files: File[] = [];
    const pending: { resolve(items: ClipItem[]): void; reject(err: unknown): void }[] = [];
    const spec: PasteSpec = { accepts: "image", takes: "open", disabled: false, onFile: (f) => void files.push(f) };
    let reads = 0;
    const control = new PasteControl({
      spec: () => spec,
      read:
        opts.read === false
          ? null
          : () => {
              reads++;
              return new Promise<readonly ClipItem[]>((resolve, reject) => pending.push({ resolve, reject }));
            },
      now: () => new Date(2026, 9, 18, 14, 32),
      ios: opts.ios ?? false,
      boxHint: "Press and hold in the box, then tap Paste.",
      onChange: () => undefined,
    });
    return { control, files, pending, spec, reads: () => reads };
  }

  test("a press reads once, refuses a second press and a key paste while it waits, then hands on the image", async () => {
    const h = harness();
    h.control.press();
    h.control.press();
    assert.equal(h.reads(), 1);
    assert.equal(h.control.view.reading, true);
    assert.equal(h.control.disabled, true, "a key paste chosen for it now does nothing");
    h.control.fromKey(eventData("image"));
    assert.equal(h.files.length, 0);
    h.pending.shift()!.resolve(clipItems("image"));
    await flush();
    assert.equal(h.control.view.reading, false);
    assert.equal(h.files.length, 1);
    assert.match(h.files[0]!.name, /^Pasted image .+\.png$/);
  });

  test("a refused read opens the box with the refusal's words, and the box's paste hands on the image and closes it", async () => {
    const h = harness();
    h.control.press();
    h.pending.shift()!.reject(new DOMException("Read permission denied.", "NotAllowedError"));
    await flush();
    assert.equal(h.control.view.box, true);
    assert.equal(h.control.view.note?.text, "The browser did not let the app read the clipboard. Press and hold in the box, then tap Paste.");
    h.control.fromBox(eventData("text"));
    assert.equal(h.control.view.box, true, "text in the box leaves it open");
    assert.equal(h.files.length, 0);
    h.control.fromBox(eventData("image"));
    assert.equal(h.files.length, 1);
    assert.equal(h.control.view.box, false);
  });

  test("a browser with no read() opens the box at once", () => {
    const h = harness({ read: false });
    h.control.press();
    assert.equal(h.control.view.box, true);
    assert.equal(h.control.view.reading, false);
  });

  test("on iOS a read with no picture opens the box too", async () => {
    const h = harness({ ios: true });
    h.control.press();
    h.pending.shift()!.resolve(clipItems("text"));
    await flush();
    assert.equal(h.control.view.box, true);
    assert.match(h.control.view.note?.text ?? "", /press and hold in the box, then tap Paste/);
  });

  test("an answer after the entry closed, or once it turned busy, hands nothing on", async () => {
    const closed = harness();
    closed.control.press();
    closed.control.detach();
    closed.pending.shift()!.resolve(clipItems("image"));
    await flush();
    assert.equal(closed.files.length, 0);
    const busy = harness();
    busy.control.press();
    busy.spec.disabled = true;
    busy.pending.shift()!.resolve(clipItems("image"));
    await flush();
    assert.equal(busy.files.length, 0);
    assert.equal(busy.control.view.reading, false);
  });

  /*
   * Many random runs of presses, answers, refusals, key and box pastes, the
   * entry turning busy and idle, and the entry closing. The rules that must
   * hold in every one: at most one read in flight, nothing handed on after
   * the entry closed or to a busy entry, at most one file for each read or
   * paste, and never reading once every answer is in.
   */
  test("whatever the order of events, its rules hold", async () => {
    for (let run = 0; run < 300; run++) {
      const next = random(run + 1);
      const files: { busy: boolean; live: boolean }[] = [];
      const pending: { resolve(items: ClipItem[]): void; reject(err: unknown): void }[] = [];
      let inFlight = 0;
      let live = true;
      const spec: PasteSpec = { accepts: "image", takes: "open", disabled: false, onFile: () => void files.push({ busy: spec.disabled, live }) };
      const settle = (fn: () => void) => () => {
        inFlight--;
        fn();
      };
      const control = new PasteControl({
        spec: () => spec,
        read: () => {
          inFlight++;
          assert.ok(inFlight <= 1, `run ${run}: ${inFlight} reads in flight at once`);
          return new Promise<readonly ClipItem[]>((resolve, reject) =>
            pending.push({ resolve: (items) => settle(() => resolve(items))(), reject: (err) => settle(() => reject(err))() }),
          );
        },
        now: () => new Date(),
        ios: next() < 0.5,
        boxHint: "Press and hold in the box, then tap Paste.",
        onChange: () => assert.equal(live, true, `run ${run}: the view changed after the entry closed`),
      });
      /** What one event handed on: never more than one file, and none where it could not. */
      const once = async (what: string, could: boolean, fn: () => void) => {
        const before = files.length;
        fn();
        await flush();
        const handed = files.length - before;
        assert.ok(handed <= 1, `run ${run}: ${what} handed on ${handed} files`);
        if (!could) assert.equal(handed, 0, `run ${run}: ${what} handed on a file it could not`);
      };
      for (let step = 0; step < 40; step++) {
        const roll = next();
        if (roll < 0.25) {
          await once("a press", false, () => control.press());
        } else if (roll < 0.45 && pending.length > 0) {
          const answer = pending.shift()!;
          const kind = next();
          await once("an answer", kind < 0.6 && live && !spec.disabled, () => {
            if (kind < 0.6) answer.resolve(clipItems("image"));
            else if (kind < 0.8) answer.resolve(clipItems("text"));
            else answer.reject(new DOMException("denied", "NotAllowedError"));
          });
        } else if (roll < 0.6) {
          const image = next() < 0.7;
          await once("a key paste", image && live && !control.disabled, () => control.fromKey(eventData(image ? "image" : "text")));
        } else if (roll < 0.7) {
          await once("a box paste", live && !control.disabled, () => control.fromBox(eventData("image")));
        } else if (roll < 0.85) {
          spec.disabled = !spec.disabled;
        } else if (roll < 0.9) {
          control.closeBox();
        } else if (roll < 0.95 && live) {
          live = false;
          control.detach();
        }
      }
      while (pending.length > 0) await once("a late answer", live && !spec.disabled, () => pending.shift()!.resolve(clipItems("image")));
      for (const f of files) {
        assert.equal(f.live, true, `run ${run}: a file was handed on after the entry closed`);
        assert.equal(f.busy, false, `run ${run}: a file was handed to a busy entry`);
      }
      if (live) assert.equal(control.view.reading, false, `run ${run}: still reading once every answer was in`);
    }
  });
});
