import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type { ImageRef, ModelRef } from "#shared/model.ts";
import { runSettings } from "#shared/propertyTestutil.ts";
import type { DrawnSheet, DrawOptions } from "./client.ts";
import { ModelSession, PICTURE_COLORS_MAX, distinctPictures, pictureColorOffer, pictureKey, roomModels, sharedModel, type ColorChoice, type RoomModel, type SessionDeps } from "./session.ts";

/**
 * The 3D model sheet's state machine (session.ts, docs/design/design-v1-token-models.md
 * 10) over many random sequences of picks, draw answers and refusals,
 * option changes, cancels, closes, saves, color reads and upload answers
 * and failures, on fakes that answer only when a step says so. Its
 * invariants hold over every order:
 *
 * - ONE: a save uploads at most one sheet per different picture (one for
 *   all without Picture's color) and at most one front view, only where a
 *   wearer has no picture.
 * - QUIET: nothing is sent after a close (the footer's Cancel closes too),
 *   or from a save a close superseded, and at most one change per save.
 * - OWN: each wearer keeps its own picture, takes a sheet this save
 *   uploaded, drawn from the picked file in its own picture's color under
 *   Picture's color, and a wearer with no picture wears the front view.
 * - ENDED: a close ends the worker, and no draw starts after it.
 * - CLEAR: once every answer is in, nothing reads as reading, drawing or saving.
 */

type Deferred<T> = { resolve(value: T): void; reject(err: unknown): void; settled: boolean };

function deferred<T>(): { promise: Promise<T>; d: Deferred<T> } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  const d: Deferred<T> = {
    settled: false,
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    reject: (e) => {
      if (d.settled) return;
      d.settled = true;
      reject(e);
    },
  };
  return { promise, d };
}

const abortError = () => new DOMException("Cancelled", "AbortError");

/** A sheet's bytes say what drew it, so OWN can read the color and the file back. */
type SheetTag = { file: string; color: string; kind: "sheet" | "front" };
const tagOf = new WeakMap<Blob, SheetTag>();
function tagged(tag: SheetTag): Blob {
  const blob = new Blob([JSON.stringify(tag)]);
  tagOf.set(blob, tag);
  return blob;
}

const BOXES: ModelRef["boxes"] = Array.from({ length: 8 }, (_, i) => [10 + i, 5, 90 - i, 95]);

/** The files: the last has no plain part, so it offers no Color and draws alike in any. */
const FILES = [new File(["a"], "knight.stl"), new File(["b"], "wolf.glb"), new File(["c"], "textured.glb")];
const colorable = (file: File) => file !== FILES[2];

const icon = (color: string): ImageRef => ({ icon: "lorc/wolf-head", color });
const upload = (assetId: string, zoom = 1): ImageRef => ({ assetId, crop: { cx: 0.5, cy: 0.5, zoom } });
/** The picture's color the fake reads: an icon's own, an upload's from its id. */
const colorOfPicture = (image: ImageRef) => ("icon" in image ? image.color : image.assetId === "grey" ? null : `#${image.assetId.padEnd(6, "0").slice(0, 6).replace(/[^0-9a-f]/g, "a")}`);

/** Who wears the sheet's model: a field with or without a picture, and groups of different pictures, one sharing a picture and one with none. */
const WEARERS: (ImageRef | undefined)[][] = [
  [icon("#336699")],
  [undefined],
  [upload("face1"), icon("#aa2200"), upload("face2"), upload("face1")],
  [upload("face1"), undefined, icon("#aa2200")],
  // Two pictures of one color draw one sheet, and one the reader cannot color draws Stone.
  [icon("#aa2200"), { icon: "lorc/goblin-head", color: "#AA2200" }, upload("grey")],
  // Seven different pictures: past the six Picture's color works for.
  ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((id) => upload(id)),
];

const ROOM: RoomModel = { model: { assetId: "room-sheet", side: 1.2, anchorY: 0.8, boxes: BOXES }, image: upload("room-face") };

type Step =
  | { t: "pick"; file: number }
  | { t: "options"; color?: ColorChoice; up?: number; front?: number; size?: number }
  | { t: "draw"; ok: boolean; stage: boolean }
  | { t: "color" }
  | { t: "upload"; ok: boolean }
  | { t: "save" }
  | { t: "cancelDraw" }
  | { t: "reuse" }
  | { t: "remove" }
  | { t: "close" };

// Weighted so most runs reach a save, often under Picture's color, with every other step still common.
const step: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ t: fc.constant("pick" as const), file: fc.nat(FILES.length - 1) }), weight: 3 },
  // A change of Color, and of the rest: one at a time, so a run often keeps Picture's color through its save.
  { arbitrary: fc.record({ t: fc.constant("options" as const), color: fc.constantFrom<ColorChoice>("stone", "bronze", "bone", "iron", "picture", "picture", "picture", "picture") }), weight: 4 },
  {
    arbitrary: fc.oneof(
      fc.record({ t: fc.constant("options" as const), up: fc.nat(5) }),
      fc.record({ t: fc.constant("options" as const), front: fc.nat(3) }),
      fc.record({ t: fc.constant("options" as const), size: fc.integer({ min: 5, max: 20 }).map((n) => n * 10) }),
    ),
    weight: 4,
  },
  { arbitrary: fc.record({ t: fc.constant("draw" as const), ok: fc.integer({ min: 0, max: 9 }).map((n) => n > 0), stage: fc.boolean() }), weight: 24 },
  { arbitrary: fc.constant({ t: "color" as const }), weight: 16 },
  { arbitrary: fc.record({ t: fc.constant("upload" as const), ok: fc.integer({ min: 0, max: 9 }).map((n) => n > 0) }), weight: 20 },
  { arbitrary: fc.constant({ t: "save" as const }), weight: 10 },
  { arbitrary: fc.constant({ t: "cancelDraw" as const }), weight: 2 },
  { arbitrary: fc.constant({ t: "reuse" as const }), weight: 1 },
  { arbitrary: fc.constant({ t: "remove" as const }), weight: 2 },
  { arbitrary: fc.constant({ t: "close" as const }), weight: 2 },
);

/** Half the runs start with a file drawn under Picture's color, so a save of one sheet per picture is common, not only possible. */
const runSteps: fc.Arbitrary<Step[]> = fc.oneof(
  fc.array(step, { minLength: 1, maxLength: 60, size: "max" }),
  fc
    .tuple(fc.nat(FILES.length - 1), fc.array(step, { minLength: 1, maxLength: 40, size: "max" }))
    .map(([file, rest]): Step[] => [{ t: "pick", file }, { t: "draw", ok: true, stage: true }, { t: "options", color: "picture" }, { t: "color" }, { t: "draw", ok: true, stage: false }, ...rest]),
);

class Rig {
  readonly draws: { file: File; options: DrawOptions; d: Deferred<DrawnSheet>; after: boolean }[] = [];
  readonly colors: { image: ImageRef; d: Deferred<string | null> }[] = [];
  readonly uploads: { kind: "model" | "token"; blob: Blob; d: Deferred<string>; save: number }[] = [];
  readonly commits: { change: (current: ImageRef | undefined) => ImageRef | null; save: number; saving: boolean; color: ColorChoice | undefined; file: string | undefined; afterClose: boolean }[] = [];
  readonly uploaded = new Map<string, Blob>();
  ends = 0;
  closed = false;
  /** Each save attempt, by its order. */
  save = 0;
  faults: string[] = [];
  readonly session: ModelSession;
  readonly wearers: (ImageRef | undefined)[];

  constructor(wearers: (ImageRef | undefined)[]) {
    this.wearers = wearers;
    const deps: SessionDeps = {
      draw: (file, options) => {
        const { promise, d } = deferred<DrawnSheet>();
        if (this.closed) this.faults.push("ENDED: a draw started after the close");
        if (options.signal?.aborted) d.reject(abortError());
        options.signal?.addEventListener("abort", () => d.reject(abortError()));
        this.draws.push({ file, options, d, after: this.closed });
        return promise;
      },
      endWorker: () => {
        this.ends++;
        for (const draw of this.draws) draw.d.reject(abortError());
      },
      upload: (kind, blob, signal) => {
        const { promise, d } = deferred<string>();
        if (signal.aborted) d.reject(abortError());
        signal.addEventListener("abort", () => d.reject(abortError()));
        this.uploads.push({ kind, blob, d, save: this.save });
        return promise;
      },
      colorOf: (image) => {
        const { promise, d } = deferred<string | null>();
        this.colors.push({ image, d });
        return promise;
      },
      commit: (change) => {
        const state = this.session.state;
        this.commits.push({ change, save: this.save, saving: state.saving, color: state.drawnFor?.color, file: state.file?.name, afterClose: this.closed || state.closed });
      },
      uploadWords: () => "The upload failed.",
    };
    this.session = new ModelSession(deps, wearers);
  }

  answerDraw(ok: boolean, stage: boolean): void {
    const draw = this.draws.find((x) => !x.d.settled);
    if (!draw) return;
    if (stage) draw.options.onStage?.("drawing");
    if (!ok) {
      draw.d.reject(new Error("This model is too complex to draw here. Try a simpler file."));
      return;
    }
    const color = String(draw.options.color);
    const file = draw.file.name;
    draw.d.resolve({
      sheet: tagged({ file, color, kind: "sheet" }),
      front: tagged({ file, color, kind: "front" }),
      meta: { side: 1.4, anchorY: 0.8, boxes: BOXES },
      maxSize: 160,
      colorable: colorable(draw.file),
      notes: [],
    });
  }

  answerColor(): void {
    const c = this.colors.find((x) => !x.d.settled);
    c?.d.resolve(colorOfPicture(c.image));
  }

  answerUpload(ok: boolean): void {
    const u = this.uploads.find((x) => !x.d.settled);
    if (!u) return;
    if (!ok) {
      u.d.reject(new Error("network"));
      return;
    }
    const id = `${u.kind}-${this.uploaded.size + 1}`;
    this.uploaded.set(id, u.blob);
    u.d.resolve(id);
  }

  pendingCount(): number {
    return this.draws.filter((x) => !x.d.settled).length + this.colors.filter((x) => !x.d.settled).length + this.uploads.filter((x) => !x.d.settled).length;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

async function play(rig: Rig, steps: readonly Step[]): Promise<void> {
  const s = rig.session;
  for (const st of steps) {
    if (st.t === "pick") s.pick(FILES[st.file]!);
    else if (st.t === "options") {
      const { t: _t, ...patch } = st;
      s.setOptions(patch);
    } else if (st.t === "draw") rig.answerDraw(st.ok, st.stage);
    else if (st.t === "color") rig.answerColor();
    else if (st.t === "upload") rig.answerUpload(st.ok);
    else if (st.t === "save") {
      if (s.canSave) rig.save++;
      s.save();
    } else if (st.t === "cancelDraw") s.cancelDraw();
    else if (st.t === "reuse") s.useRoomModel(ROOM);
    else if (st.t === "remove") s.remove();
    else {
      s.close();
      rig.closed = true;
    }
    await flush();
  }
  // Every answer comes in, a good one, until nothing waits.
  for (let i = 0; i < 50; i++) {
    await flush();
    if (rig.pendingCount() === 0) break;
    rig.answerColor();
    rig.answerDraw(true, false);
    rig.answerUpload(true);
  }
}

function check(rig: Rig): void {
  assert.deepEqual(rig.faults, []);
  const s = rig.session.state;
  // CLEAR
  assert.equal(rig.pendingCount(), 0, "CLEAR: an answer still waits");
  assert.equal(s.stage, null, "CLEAR: reads as reading or drawing with nothing in flight");
  assert.equal(s.saving, false, "CLEAR: reads as saving with nothing in flight");
  // ENDED
  if (rig.closed) {
    assert.ok(rig.ends >= 1, "ENDED: a close left the worker running");
    assert.equal(s.closed, true);
  }
  // QUIET: removes send from no save; a save's change comes at most once, and never after a close.
  const saves = rig.commits.filter((c) => c.saving);
  for (const c of rig.commits) assert.equal(c.afterClose, false, "QUIET: a change sent after the close");
  assert.equal(new Set(saves.map((c) => c.save)).size, saves.length, "QUIET: one save sent twice");
  assert.ok(saves.length <= 1, "QUIET: the sheet closes on its save, so it sends one");

  const pictures = distinctPictures(rig.wearers);
  const pictureless = rig.wearers.some((w) => w === undefined);
  for (let attempt = 1; attempt <= rig.save; attempt++) {
    const ups = rig.uploads.filter((u) => u.save === attempt);
    const sheets = ups.filter((u) => u.kind === "model").length;
    const fronts = ups.filter((u) => u.kind === "token").length;
    // ONE, and never past the six pictures Picture's color works for.
    assert.ok(sheets <= Math.min(PICTURE_COLORS_MAX, Math.max(1, pictures?.length ?? 1)), `ONE: save ${attempt} uploaded ${sheets} sheets`);
    assert.ok(fronts <= (pictureless ? 1 : 0), `ONE: save ${attempt} uploaded ${fronts} front views`);
  }
  // OWN
  for (const c of saves) {
    const results = rig.wearers.map((w) => c.change(w));
    rig.wearers.forEach((w, i) => {
      const out = results[i];
      assert.ok(out?.model, `OWN: wearer ${i} took no model`);
      if (w) {
        const { model: _a, ...picture } = out;
        const { model: _b, ...own } = w;
        assert.deepEqual(picture, own, `OWN: wearer ${i} lost its own picture`);
      }
      if (out.model.assetId === ROOM.model.assetId) {
        assert.deepEqual(out.model, ROOM.model, "OWN: a room model taken whole");
        if (!w) assert.equal("assetId" in out && out.assetId, "room-face", "OWN: a wearer with no picture takes the room model's picture");
        return;
      }
      const blob = rig.uploaded.get(out.model.assetId);
      assert.ok(blob, `OWN: wearer ${i} wears a sheet this save did not upload`);
      const tag = tagOf.get(blob)!;
      assert.equal(tag.kind, "sheet");
      assert.equal(tag.file, c.file, `OWN: wearer ${i} wears a sheet drawn from another file`);
      if (!w) {
        assert.ok("assetId" in out && rig.uploaded.has(out.assetId) && tagOf.get(rig.uploaded.get(out.assetId)!)?.kind === "front", "OWN: a wearer with no picture wears the front view");
      }
      assert.ok(c.color !== "picture" || pictureColorOffer(rig.wearers).usable, "OWN: Picture's color saved where it is not offered");
      if (c.color === "picture" && tag.file !== "textured.glb" && w) {
        const want = colorOfPicture(w) ?? "stone";
        assert.equal(tag.color.toLowerCase(), want.toLowerCase(), `OWN: wearer ${i} wears another picture's color`);
      }
    });
    // Two wearers of one picture wear one model.
    const byPicture = new Map<string, string>();
    rig.wearers.forEach((w, i) => {
      if (!w) return;
      const key = pictureKey(w);
      const id = results[i]!.model!.assetId;
      if (byPicture.has(key)) assert.equal(byPicture.get(key), id, "OWN: one picture wears two sheets");
      byPicture.set(key, id);
    });
  }
}

const { seed, runs } = runSettings(process.env);

describe("the 3D model sheet's state", () => {
  test("a group of 3 different pictures under Picture's color draws and uploads 3 sheets, each token wearing its own picture's", async () => {
    const wearers = [upload("face1"), icon("#aa2200"), upload("face2"), upload("face1", 1)];
    const rig = new Rig(wearers);
    rig.session.pick(FILES[0]!);
    await flush();
    rig.answerDraw(true, true);
    await flush();
    rig.session.setOptions({ color: "picture" });
    await flush();
    rig.answerColor();
    await flush();
    rig.answerDraw(true, false);
    await flush();
    rig.save++;
    rig.session.save();
    await play(rig, []);
    check(rig);
    const sheets = rig.uploads.filter((u) => u.kind === "model").map((u) => tagOf.get(u.blob)!.color);
    assert.deepEqual(sheets.sort(), ["#aa2200", "#face10", "#face20"].sort());
    assert.equal(rig.uploads.filter((u) => u.kind === "token").length, 0, "every token has a picture, so none takes the front view");
    const worn = wearers.map((w) => tagOf.get(rig.uploaded.get(rig.commits[0]!.change(w)!.model!.assetId)!)!.color);
    assert.deepEqual(worn, ["#face10", "#aa2200", "#face20", "#face10"]);
    assert.equal(rig.session.state.closed, true, "a save closes the sheet");
    assert.ok(rig.ends >= 1);
  });

  test("a group with a token without a picture takes one front view for it, and one sheet for all", async () => {
    const wearers = [upload("face1"), undefined, undefined];
    const rig = new Rig(wearers);
    rig.session.pick(FILES[1]!);
    await flush();
    rig.answerDraw(true, false);
    await flush();
    rig.save++;
    rig.session.save();
    await play(rig, []);
    check(rig);
    assert.deepEqual(rig.uploads.map((u) => u.kind), ["model", "token"]);
    const out = wearers.map((w) => rig.commits[0]!.change(w)!);
    assert.deepEqual(out[0], { ...upload("face1"), model: { assetId: "model-1", side: 1.4, anchorY: 0.8, boxes: BOXES } });
    assert.deepEqual(out[1], { assetId: "token-2", crop: { cx: 0.5, cy: 0.5, zoom: 1 }, model: { assetId: "model-1", side: 1.4, anchorY: 0.8, boxes: BOXES } });
    assert.deepEqual(out[2], out[1]);
  });

  test("a close mid-draw ends the worker and sends nothing, and a close mid-save sends nothing", async () => {
    const rig = new Rig([icon("#336699")]);
    rig.session.pick(FILES[0]!);
    await flush();
    rig.session.close();
    rig.closed = true;
    await play(rig, []);
    check(rig);
    assert.equal(rig.ends, 1);
    const saving = new Rig([icon("#336699")]);
    saving.session.pick(FILES[0]!);
    await flush();
    saving.answerDraw(true, false);
    await flush();
    saving.save++;
    saving.session.save();
    await flush();
    assert.equal(saving.session.state.saving, true);
    saving.session.close();
    saving.closed = true;
    await play(saving, []);
    check(saving);
    assert.deepEqual(saving.commits, []);
  });

  test("a failed upload clears Saving with its words, and Save then tries again once", async () => {
    const rig = new Rig([icon("#336699")]);
    rig.session.pick(FILES[0]!);
    await flush();
    rig.answerDraw(true, false);
    await flush();
    rig.save++;
    rig.session.save();
    rig.session.save();
    await flush();
    rig.answerUpload(false);
    await flush();
    assert.deepEqual([rig.session.state.saving, rig.session.state.error], [false, "The upload failed."]);
    assert.equal(rig.uploads.length, 1, "a second tap on Save sends nothing more");
    rig.save++;
    rig.session.save();
    await play(rig, []);
    check(rig);
    assert.equal(rig.commits.length, 1);
  });

  test("holds ONE, QUIET, OWN, ENDED and CLEAR over random sequences of picks, draws, options, cancels, closes, saves and uploads", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat(WEARERS.length - 1), runSteps, async (who, steps) => {
        const rig = new Rig(WEARERS[who]!);
        await play(rig, steps);
        check(rig);
      }),
      { seed, numRuns: runs ?? 400 },
    );
  });
});

describe("the sheet's other readings", () => {
  const ref = (assetId: string, side = 1.4): ModelRef => ({ assetId, side, anchorY: 0.8, boxes: BOXES });
  const on = (image: ImageRef, sheet: string, side?: number): ImageRef => ({ ...image, model: ref(sheet, side) });

  test("the room's models are one per sheet, from tokens, other images, characters, monsters, SRD images and blocks, in a steady order", () => {
    const view = {
      tokens: { t2: { image: on(icon("#111111"), "s-token") }, t1: { image: upload("plain"), altImages: [on(upload("alt"), "s-alt"), on(upload("again"), "s-token")] } },
      characters: { c1: { defaultImage: on(upload("pc"), "s-pc") } },
      monsters: { m1: { defaultImage: on(upload("ogre"), "s-ogre") } },
      srdImages: { goblin: { image: on(icon("#222222"), "s-goblin") } },
      companionBlocks: { b1: { defaultImage: on(upload("cat"), "s-cat") } },
    } as never;
    assert.deepEqual(
      roomModels(view).map((m) => m.model.assetId),
      ["s-alt", "s-token", "s-pc", "s-ogre", "s-goblin", "s-cat"],
    );
    assert.deepEqual(roomModels(view)[0]!.image, on(upload("alt"), "s-alt"), "with the picture it rides on");
    assert.deepEqual(roomModels({}), []);
  });

  test("the stored views show only for a model every wearer shares whole, and Picture's color only where every wearer has a picture, up to 6", () => {
    assert.deepEqual(sharedModel([on(upload("a"), "s"), on(icon("#123456"), "s")]), ref("s"));
    assert.equal(sharedModel([on(upload("a"), "s"), on(upload("b"), "s", 2)]), null, "the same sheet at another side");
    assert.equal(sharedModel([on(upload("a"), "s"), upload("b")]), null);
    assert.equal(sharedModel([undefined]), null);
    assert.deepEqual(pictureColorOffer([upload("a"), upload("a"), icon("#123456")]), { shown: true, usable: true });
    assert.deepEqual(pictureColorOffer([upload("a"), undefined]), { shown: false, usable: false });
    assert.deepEqual(pictureColorOffer(["1", "2", "3", "4", "5", "6"].map((id) => upload(id))), { shown: true, usable: true });
    assert.deepEqual(pictureColorOffer(["1", "2", "3", "4", "5", "6", "7"].map((id) => upload(id))), { shown: true, usable: false });
  });
});
