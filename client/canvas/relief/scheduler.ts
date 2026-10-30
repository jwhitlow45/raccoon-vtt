import { KeptRelief, type KeptAt, type KeptCanvas } from "./kept.ts";
import type { VBox } from "./pieces.ts";

/**
 * One draw a frame for the isometric board (docs/design-v1-isometric-view.md
 * 5.1). The tops of raised ground copy the ground stage's pixels, so the
 * relief must draw after the ground in the same frame, and again whenever
 * the ground draws. The scheduler takes over `batchDraw` on the ground and
 * relief layer instances, so react-konva's commits, Konva's own requests
 * and `Stage.batchDraw` all reach it. Each frame it draws the ground if
 * marked, then the relief if marked or if the ground drew. The drag and
 * overlay layers keep Konva's own batchDraw.
 *
 * It also keeps the relief's picture across a pan (docs/design-v1-relief-pan.md
 * 5): a mark made inside `moveCamera` is the camera's, any other is
 * content, and the relief scrolls when everything since its last draw was
 * the camera's. And it owns the frame loop for background work, so a build
 * slice never lands in a frame that repaints whole (8, D-261030-547).
 */

/** What the scheduler needs of a Konva layer. */
export type DrawTarget = { draw(): unknown; batchDraw(): unknown };

/** A frame source: `run` gets the frame's timestamp, as `requestAnimationFrame` gives it. */
export type Frames = { request(run: (time: number) => void): number; cancel(id: number): void };

const BROWSER_FRAMES: Frames = {
  request: (run) => requestAnimationFrame(run),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Work the scheduler runs in its own frames after it draws: it works until
 * `until` (a `performance.now()` time) and says whether it has more.
 */
export type BackgroundJob = (until: number) => boolean;

/** The most a frame gives background work, in ms (docs/design-v1-iso-area-shapes.md 6). */
export const BACKGROUND_MS = 6;
/** Background work ends this long after the frame began, so a heavy draw leaves it less. */
export const FRAME_END_MS = 12;

/**
 * What the kept picture reads from the board (IsoBoard.tsx): where the
 * stage stands, the ground's draw counter, and how to draw the whole view
 * or only what meets some regions.
 */
export type KeptHost = {
  /** The relief layer: its own canvas, and Konva's events. */
  layer: KeptLayer;
  /** Where the picture stands now, read from the main stage as it draws. */
  at(canvas: KeptCanvas): KeptAt;
  /** How many times the ground layer has drawn, on every path (Konva's `draw` event). */
  groundVersion(): number;
  /** Sets the board's draw context for a draw at the stage's camera into a canvas of this pixel ratio, with the regions a scroll paints (null for the whole view) and where toned cells go. */
  prepare(ratio: number, regions: readonly VBox[] | null, toned: VBox[] | undefined): void;
  /** The toned cells' boxes at the camera prepared, from a pass over the layout. */
  tonedNow(): VBox[];
  /** Draws the relief root's children whose painted bounds meet a region, in order, into the clipped canvas. */
  drawChildren(canvas: unknown, regions: readonly VBox[]): void;
};

/** What the kept picture needs of a Konva layer. */
export type KeptLayer = {
  getCanvas(): { getContext(): { _context: CanvasRenderingContext2D }; width: number; height: number; getPixelRatio(): number; _trimIsolationCanvas?(): void };
  drawScene(canvas?: unknown, top?: unknown): unknown;
  _fire(type: string, evt: object): void;
};

export class FrameScheduler {
  readonly #ground: DrawTarget;
  readonly #relief: DrawTarget;
  readonly #frames: Frames;
  readonly #now: () => number;
  #groundMarked = false;
  #reliefMarked = false;
  /** A mark not the camera's since that layer last drew. */
  #groundContent = false;
  #reliefContent = false;
  /** Inside `moveCamera`. */
  #camera = false;
  #frame = 0;
  /** The ground counter and the scheduler's camera draws of the ground, as they stood at the relief's last draw. */
  #keptGround = 0;
  #keptCameraDraws = 0;
  /** This frame repainted the relief whole. */
  #whole = false;
  #sliced = false;
  readonly #jobs = new Set<BackgroundJob>();
  #afterDraw: (() => void) | null = null;
  #host: KeptHost | null = null;
  /** The relief's kept picture, once `keep` has given it its canvas. */
  kept: KeptRelief | null = null;
  /** Frames drawn and layer draws made, for the bench and the tests. */
  frames = 0;
  draws = 0;
  /** Ground draws the scheduler made for the camera alone. */
  cameraGroundDraws = 0;
  /** Background job calls, and those in a frame that repainted whole: always 0 by the budget's rule, counted for the bench. */
  slices = 0;
  slicesInWhole = 0;

  constructor(ground: DrawTarget, relief: DrawTarget, frames: Frames = BROWSER_FRAMES, now: () => number = () => performance.now()) {
    this.#ground = ground;
    this.#relief = relief;
    this.#frames = frames;
    this.#now = now;
    // An own property over the prototype's method: deleting it in detach puts Konva's back.
    ground.batchDraw = () => {
      this.mark("ground");
      return ground;
    };
    relief.batchDraw = () => {
      this.mark("relief");
      return relief;
    };
  }

  /** Runs `apply`, which moves the stages: every mark it makes is the camera's. */
  moveCamera(apply: () => void): void {
    const was = this.#camera;
    this.#camera = true;
    try {
      apply();
    } finally {
      this.#camera = was;
    }
  }

  mark(which: "ground" | "relief"): void {
    if (which === "ground") {
      this.#groundMarked = true;
      if (!this.#camera) this.#groundContent = true;
    } else {
      this.#reliefMarked = true;
      if (!this.#camera) this.#reliefContent = true;
    }
    this.#request();
  }

  /** Called after each frame that drew, so the chrome hears of the camera drawn (liveCamera.ts). */
  afterDraw(run: (() => void) | null): void {
    this.#afterDraw = run;
  }

  /** Adds background work. It runs in the scheduler's frames until it says it has no more, or the returned function stops it. */
  background(job: BackgroundJob): () => void {
    this.#jobs.add(job);
    this.#request();
    return () => void this.#jobs.delete(job);
  }

  #request(): void {
    if (this.#frame === 0) this.#frame = this.#frames.request((time) => this.run(time));
  }

  /**
   * Whether everything since the relief's last draw was the camera's: only
   * camera marks on it, and every ground draw since one the scheduler made
   * for the camera alone, by the ground's own counter, so a draw Konva
   * makes on its own counts as content (5.2). Taking it starts the count again.
   */
  takeClean(groundVersion: number): boolean {
    const groundOnlyCamera = groundVersion - this.#keptGround === this.cameraGroundDraws - this.#keptCameraDraws;
    const clean = !this.#reliefContent && groundOnlyCamera;
    this.#reliefContent = false;
    this.#keptGround = groundVersion;
    this.#keptCameraDraws = this.cameraGroundDraws;
    return clean;
  }

  /** Draws what is marked: the ground first, then the relief, which copies it. Then the background work, with what the frame leaves it. */
  run(time: number = this.#now()): void {
    this.#frame = 0;
    this.frames++;
    if (this.#sliced && this.#whole) this.slicesInWhole++;
    this.#sliced = false;
    this.#whole = false;
    // A content mark waiting as the frame begins means this frame repaints whole.
    const pending = this.#reliefContent || this.#groundContent;
    let drew = false;
    if (this.#groundMarked) {
      const camera = !this.#groundContent;
      this.#groundMarked = false;
      this.#groundContent = false;
      this.#reliefMarked = true;
      if (camera) this.cameraGroundDraws++;
      this.#ground.draw();
      this.draws++;
      drew = true;
    }
    if (this.#reliefMarked) {
      this.#reliefMarked = false;
      // With no kept picture every relief draw is whole, and a content mark is what asked for it.
      if (!this.#host && this.#reliefContent) this.#whole = true;
      this.#relief.draw();
      if (!this.#host) this.#reliefContent = false;
      this.draws++;
      drew = true;
    }
    if (drew) this.#afterDraw?.();
    this.#runJobs(time, pending || this.#whole);
  }

  #runJobs(start: number, repaint: boolean): void {
    if (this.#jobs.size === 0) return;
    // The budget starts at the frame's own timestamp, so a heavy draw before it leaves the jobs less (D-261030-547).
    const budget = repaint ? 0 : Math.max(0, Math.min(BACKGROUND_MS, start + FRAME_END_MS - this.#now()));
    if (budget > 0) {
      const until = this.#now() + budget;
      for (const job of [...this.#jobs]) {
        if (this.#now() >= until) break;
        this.slices++;
        this.#sliced = true;
        if (!job(until)) this.#jobs.delete(job);
      }
    }
    if (this.#jobs.size > 0) this.#request();
  }

  /**
   * Keeps the relief's picture across a pan: replaces only the relief
   * layer's `drawScene` with an own property. A draw into another canvas
   * (`toDataURL`, the bench's images) takes Konva's own path into it.
   */
  keep(host: KeptHost): KeptRelief {
    const kept = (this.kept = new KeptRelief());
    this.#host = host;
    const layer = host.layer;
    const konvaDraw = Object.getPrototypeOf(layer).drawScene as KeptLayer["drawScene"];
    layer.drawScene = (can?: unknown, top?: unknown) => {
      const own = layer.getCanvas();
      if ((can && can !== own) || top) {
        const other = (can ?? own) as { getPixelRatio?(): number };
        host.prepare(other.getPixelRatio?.() ?? own.getPixelRatio(), null, undefined);
        return konvaDraw.call(layer, can, top);
      }
      const canvas: KeptCanvas = { g: own.getContext()._context, width: own.width, height: own.height, ratio: own.getPixelRatio() };
      const at = host.at(canvas);
      const clean = this.takeClean(host.groundVersion());
      const plan = kept.draw(canvas, {
        at,
        clean,
        whole: (toned) => {
          host.prepare(canvas.ratio, null, toned);
          konvaDraw.call(layer, can, top);
        },
        tonedNow: () => {
          host.prepare(canvas.ratio, null, undefined);
          return host.tonedNow();
        },
        regions: (regions) => {
          layer._fire("beforeDraw", { node: layer });
          host.prepare(canvas.ratio, regions, undefined);
          host.drawChildren(own, regions);
        },
      });
      if (plan.kind === "whole") this.#whole = true;
      else {
        own._trimIsolationCanvas?.();
        layer._fire("draw", { node: layer });
      }
      return layer;
    };
    return kept;
  }

  detach(): void {
    if (this.#frame !== 0) this.#frames.cancel(this.#frame);
    this.#frame = 0;
    this.#jobs.clear();
    this.#afterDraw = null;
    delete (this.#ground as { batchDraw?: unknown }).batchDraw;
    delete (this.#relief as { batchDraw?: unknown }).batchDraw;
    if (this.#host) delete (this.#host.layer as { drawScene?: unknown }).drawScene;
    this.#host = null;
  }
}
