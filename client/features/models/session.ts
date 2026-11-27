import { copyImage, withoutModel } from "#shared/imageRef.ts";
import { MODEL_LIMITS } from "#shared/limits.ts";
import type { ImageRef, ModelRef, RoomState } from "#shared/model.ts";
import type { DrawnSheet, DrawOptions, ModelColor, ModelOptions, ModelStage } from "./client.ts";

/**
 * The 3D model sheet's state (docs/design/design-v1-token-models.md 3.1,
 * 3.4 and 10), free of React so its random test can drive every order of
 * picks, draws, option changes, cancels, closes, saves and uploads.
 *
 * A sheet edits one or more wearers at once: the image a field shows, or
 * each selected token's in the group edit sheet. What it sends is a change
 * worked out from each wearer's own image, so every token keeps its own
 * picture and gets its own model. Every late answer is checked against the
 * generation it was asked in, so nothing a cancel, a close or a newer pick
 * superseded is drawn, uploaded or sent.
 */

/** The Color choices: the four materials and the picture's own color (D-261127-175). */
export type ColorChoice = "stone" | "bronze" | "bone" | "iron" | "picture";

/** The options as the sheet shows them. `color` "picture" draws each picture's own color. */
export type SheetOptions = Omit<ModelOptions, "color"> & { color: ColorChoice };

export const START_OPTIONS: SheetOptions = { color: "stone", up: 0, front: 0, size: 100 };

/** Picture's color works for at most this many different pictures at once (D-261127-418). */
export const PICTURE_COLORS_MAX = 6;

/** A model already in the room, with the image it rides on: "Or use one from this room". */
export type RoomModel = { model: ModelRef; image: ImageRef };

export type SessionDeps = {
  draw(file: File, options: DrawOptions): Promise<DrawnSheet>;
  /** Ends the model worker and frees the file it holds. */
  endWorker(): void;
  /** Uploads a sheet (kind `model`) or a front view (kind `token`), answering its asset id. */
  upload(kind: "model" | "token", blob: Blob, signal: AbortSignal): Promise<string>;
  /** The picture's own color as `#rrggbb`, or null where it cannot be read. */
  colorOf(image: ImageRef): Promise<string | null>;
  /** Sends a change worked out from each wearer's own image: one `token.update` each in a group, one image patch for a field. */
  commit(change: (current: ImageRef | undefined) => ImageRef | null): void;
  /** The plain words for a refused upload. */
  uploadWords(err: unknown): string;
};

export type SessionState = {
  /** The file being drawn, or null before a pick, after a cancel and after a refusal. */
  file: File | null;
  options: SheetOptions;
  /** The newest finished drawing of `file`, at `drawnFor`. */
  drawn: DrawnSheet | null;
  drawnFor: SheetOptions | null;
  /** A draw in flight: "reading", then "drawing". */
  stage: ModelStage | null;
  saving: boolean;
  error: string | null;
  /** A room model picked in place of a file. */
  reuse: RoomModel | null;
  closed: boolean;
};

/** What makes two pictures one for Picture's color: the upload and its crop, or the icon and its color. */
export function pictureKey(image: ImageRef): string {
  return "icon" in image ? `icon:${image.icon}:${image.color.toLowerCase()}` : `asset:${image.assetId}:${image.crop.cx}:${image.crop.cy}:${image.crop.zoom}`;
}

/** The different pictures the wearers show, in order, or null when one has none. */
export function distinctPictures(wearers: readonly (ImageRef | undefined)[]): ImageRef[] | null {
  const seen = new Map<string, ImageRef>();
  for (const image of wearers) {
    if (!image) return null;
    const key = pictureKey(image);
    if (!seen.has(key)) seen.set(key, image);
  }
  return [...seen.values()];
}

/** Whether Picture's color is offered (every wearer has a picture) and whether it is on (at most 6 different ones). */
export function pictureColorOffer(wearers: readonly (ImageRef | undefined)[]): { shown: boolean; usable: boolean } {
  const pictures = wearers.length > 0 ? distinctPictures(wearers) : null;
  return { shown: pictures !== null, usable: pictures !== null && pictures.length <= PICTURE_COLORS_MAX };
}

/** The model the wearers share, shown as the sheet's stored views, or null when any has another or none. */
export function sharedModel(wearers: readonly (ImageRef | undefined)[]): ModelRef | null {
  const first = wearers[0]?.model;
  if (!first) return null;
  return wearers.every((image) => image?.model !== undefined && sameModel(image.model, first)) ? first : null;
}

/** The whole ref, as `sameImage` compares a model (D-261127-414). */
function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.assetId === b.assetId && a.side === b.side && a.anchorY === b.anchorY && a.boxes.length === b.boxes.length && a.boxes.every((box, i) => box.every((edge, j) => edge === b.boxes[i]![j]));
}

/**
 * The models on images this viewer's copy holds, one per sheet, in a
 * steady order: tokens and their other images, characters, the room's
 * monsters, SRD images and companion blocks. A viewer's copy holds only
 * what they may see, so this lists nothing they could not already see.
 */
export function roomModels(view: Partial<Pick<RoomState, "tokens" | "characters" | "monsters" | "srdImages" | "companionBlocks">>): RoomModel[] {
  const out = new Map<string, RoomModel>();
  const add = (image: ImageRef | undefined) => {
    if (image?.model && !out.has(image.model.assetId)) out.set(image.model.assetId, { model: image.model, image });
  };
  const sorted = <T>(record: Readonly<Record<string, T>> | undefined) => Object.keys(record ?? {}).sort().map((id) => record![id]!);
  for (const token of sorted(view.tokens)) {
    add(token.image);
    for (const alt of token.altImages ?? []) add(alt);
  }
  for (const c of sorted(view.characters)) add(c.defaultImage);
  for (const m of sorted(view.monsters)) add(m.defaultImage);
  for (const s of sorted(view.srdImages)) add(s.image);
  for (const b of sorted(view.companionBlocks)) add(b.defaultImage);
  return [...out.values()];
}

/** The image a wearer ends with when it takes `model`: its own picture with the model, or the front view where it has none. */
export function wearing(current: ImageRef | undefined, model: ModelRef, front: ImageRef | null): ImageRef | null {
  if (current) return { ...copyImage(current), model: copyModel(model) };
  return front ? { ...copyImage(front), model: copyModel(model) } : null;
}

function copyModel(model: ModelRef): ModelRef {
  return { assetId: model.assetId, side: model.side, anchorY: model.anchorY, boxes: model.boxes.map(([x0, y0, x1, y1]) => [x0, y0, x1, y1]) };
}

const FRONT_CROP = { cx: 0.5, cy: 0.5, zoom: 1 };

/** A drawing in another picture's color that a save needed and the worker refused, in the refusal's own words. */
class DrawRefused extends Error {}

function aborted(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function sameOptions(a: SheetOptions, b: SheetOptions | null): boolean {
  return b !== null && a.color === b.color && a.up === b.up && a.front === b.front && a.size === b.size;
}

export class ModelSession {
  #deps: SessionDeps;
  #wearers: readonly (ImageRef | undefined)[];
  #listeners = new Set<() => void>();
  /** Bumped by every pick, draw, cancel, save and close: an answer from an older one is dropped. */
  #gen = 0;
  #draw: AbortController | null = null;
  #save: AbortController | null = null;
  #state: SessionState = { file: null, options: START_OPTIONS, drawn: null, drawnFor: null, stage: null, saving: false, error: null, reuse: null, closed: false };

  constructor(deps: SessionDeps, wearers: readonly (ImageRef | undefined)[]) {
    this.#deps = deps;
    this.#wearers = wearers;
  }

  get state(): SessionState {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** The images worn now, which can change while the sheet is open (another member, or a remove here). */
  setWearers(wearers: readonly (ImageRef | undefined)[]): void {
    this.#wearers = wearers;
  }

  #set(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const l of this.#listeners) l();
  }

  /** Whether anything a cancel would throw away is held: a file read or being read, or a room model picked. */
  get pending(): boolean {
    const s = this.#state;
    return s.file !== null || s.reuse !== null;
  }

  pick(file: File): void {
    if (this.#state.closed || this.#state.saving) return;
    this.#set({ file, options: START_OPTIONS, drawn: null, drawnFor: null, error: null, reuse: null });
    this.#start("reading");
  }

  /** A change of Color, Stand it up, Turn its front or Size draws the 8 views again. */
  setOptions(patch: Partial<SheetOptions>): void {
    const s = this.#state;
    if (s.closed || s.saving || !s.file) return;
    if (patch.color === "picture" && !pictureColorOffer(this.#wearers).usable) return;
    const options = { ...s.options, ...patch };
    if (sameOptions(options, s.options)) return;
    this.#set({ options, error: null });
    this.#start("drawing");
  }

  useRoomModel(choice: RoomModel): void {
    if (this.#state.closed || this.#state.saving) return;
    this.#stopDraw();
    this.#set({ file: null, drawn: null, drawnFor: null, stage: null, error: null, reuse: choice, options: START_OPTIONS });
  }

  /** The Cancel shown while reading or drawing: a redraw goes back to the last drawing, a first read back to the start. */
  cancelDraw(): void {
    const s = this.#state;
    if (s.closed || s.stage === null) return;
    this.#stopDraw();
    if (s.drawn && s.drawnFor) this.#set({ stage: null, options: s.drawnFor });
    else this.#set({ stage: null, file: null });
  }

  #stopDraw(): void {
    this.#gen++;
    this.#draw?.abort();
    this.#draw = null;
  }

  #start(stage: ModelStage): void {
    this.#stopDraw();
    const gen = this.#gen;
    const file = this.#state.file!;
    const options = this.#state.options;
    const controller = new AbortController();
    this.#draw = controller;
    this.#set({ stage });
    void (async () => {
      try {
        const color = await this.#colorFor(options.color, this.#wearers[0]);
        if (gen !== this.#gen) return;
        const drawn = await this.#deps.draw(file, {
          ...options,
          color,
          signal: controller.signal,
          onStage: (stage) => {
            if (gen === this.#gen) this.#set({ stage });
          },
        });
        if (gen !== this.#gen) return;
        this.#draw = null;
        // The Size stepper stops at the model's cap, and the drawing has already been clamped to it.
        const size = Math.min(options.size, drawn.maxSize);
        const shown = size === options.size ? options : { ...options, size };
        this.#set({ drawn, drawnFor: shown, options: shown, stage: null });
      } catch (err) {
        if (gen !== this.#gen) return;
        this.#draw = null;
        if (aborted(err)) return;
        // A refusal ends the worker, so the file is chosen again.
        this.#set({ stage: null, file: null, drawn: null, drawnFor: null, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  async #colorFor(choice: ColorChoice, image: ImageRef | undefined): Promise<ModelColor> {
    if (choice !== "picture") return choice;
    const color = image ? await this.#deps.colorOf(image) : null;
    return color && /^#[0-9a-f]{6}$/i.test(color) ? (color as ModelColor) : "stone";
  }

  /** Whether Save would send something now. */
  get canSave(): boolean {
    const s = this.#state;
    return !s.closed && !s.saving && ((s.drawn !== null && s.stage === null) || s.reuse !== null);
  }

  save(): void {
    if (!this.canSave) return;
    const s = this.#state;
    this.#gen++;
    const gen = this.#gen;
    const controller = new AbortController();
    this.#save = controller;
    this.#set({ saving: true, error: null });
    const live = () => gen === this.#gen && !this.#state.closed;
    void (async () => {
      try {
        const change = s.reuse ? this.#reuseChange(s.reuse) : await this.#drawnChange(s.file!, s.drawn!, s.drawnFor!, controller.signal, live);
        if (!change || !live()) return;
        this.#save = null;
        this.#deps.commit(change);
        this.close();
      } catch (err) {
        if (!live()) return;
        this.#save = null;
        if (aborted(err)) {
          this.#set({ saving: false });
          return;
        }
        this.#set({ saving: false, error: err instanceof DrawRefused ? err.message : this.#deps.uploadWords(err) });
      }
    })();
  }

  #reuseChange(choice: RoomModel): (current: ImageRef | undefined) => ImageRef | null {
    // A wearer with no picture takes the picture the model came on, model and all.
    return (current) => wearing(current, choice.model, choice.image);
  }

  /**
   * Uploads one sheet per different color the wearers need, the drawing
   * shown as one of them, and the front view once where a wearer has no
   * picture, then answers the change each wearer takes.
   */
  async #drawnChange(
    file: File,
    drawn: DrawnSheet,
    drawnFor: SheetOptions,
    signal: AbortSignal,
    live: () => boolean,
  ): Promise<((current: ImageRef | undefined) => ImageRef | null) | null> {
    const wearers = this.#wearers;
    const colors = new Map<string, ModelColor>();
    const pictures = drawnFor.color === "picture" ? (distinctPictures(wearers) ?? []) : [];
    for (const picture of pictures) {
      colors.set(pictureKey(picture), await this.#colorFor("picture", picture));
      if (!live()) return null;
    }
    const shownColor = drawn.colorable ? await this.#colorFor(drawnFor.color, wearers[0]) : null;
    if (!live()) return null;
    const sheets = new Map<ModelColor | "", Omit<ModelRef, "assetId"> & { sheet: Blob }>();
    sheets.set(shownColor ?? "", { ...drawn.meta, sheet: drawn.sheet });
    // A file with no plain part draws the same whatever the color, so it needs one sheet.
    const needed: (ModelColor | "")[] = drawn.colorable && drawnFor.color === "picture" ? [...new Set(colors.values())] : [];
    if (needed.length === 0) needed.push(shownColor ?? "");
    for (const color of needed) {
      if (sheets.has(color)) continue;
      const other = await this.#deps.draw(file, { up: drawnFor.up, front: drawnFor.front, size: drawnFor.size, color: color as ModelColor, signal }).catch((err: unknown) => {
        throw aborted(err) ? err : new DrawRefused(err instanceof Error ? err.message : String(err));
      });
      if (!live()) return null;
      sheets.set(color, { ...other.meta, sheet: other.sheet });
    }
    const models = new Map<ModelColor | "", ModelRef>();
    for (const color of needed) {
      const { sheet, ...meta } = sheets.get(color)!;
      const assetId = await this.#deps.upload("model", sheet, signal);
      if (!live()) return null;
      models.set(color, { assetId, ...meta });
    }
    let front: ImageRef | null = null;
    if (wearers.some((w) => w === undefined)) {
      front = { assetId: await this.#deps.upload("token", drawn.front, signal), crop: FRONT_CROP };
      if (!live()) return null;
    }
    const fallback = models.get(needed[0]!)!;
    return (current) => {
      const color = current && drawnFor.color === "picture" && drawn.colorable ? colors.get(pictureKey(current)) : undefined;
      return wearing(current, (color !== undefined ? models.get(color) : undefined) ?? fallback, front);
    };
  }

  /** Remove model: each wearer keeps its picture without its model. A wearer without one is left as it is. */
  remove(): void {
    if (this.#state.closed || this.#state.saving) return;
    this.#deps.commit((current) => (current ? withoutModel(current) : null));
  }

  /**
   * Opens the sheet again after a close it did not ask for: React's strict
   * mode in development unmounts a component once and mounts it again,
   * which runs the unmount's close. A close drops everything that ran, so
   * the session starts again from what its state holds.
   */
  open(): void {
    if (this.#state.closed) this.#set({ closed: false });
  }

  /** Closes the sheet: whatever runs is dropped, nothing more is sent, and the worker ends. */
  close(): void {
    if (this.#state.closed) return;
    this.#stopDraw();
    this.#save?.abort();
    this.#save = null;
    this.#deps.endWorker();
    this.#set({ closed: true, stage: null, saving: false });
  }
}

/** The Size stepper's top: the model's cap, never under the smallest Size. */
export function sizeCap(drawn: Pick<DrawnSheet, "maxSize"> | null): number {
  return Math.max(MODEL_LIMITS.minSizePercent, drawn?.maxSize ?? MODEL_LIMITS.minSizePercent);
}
