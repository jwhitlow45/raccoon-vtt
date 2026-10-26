/**
 * One draw a frame for the isometric board (docs/design-v1-isometric-view.md
 * 5.1). The tops of raised ground copy the ground stage's pixels, so the
 * relief must draw after the ground in the same frame, and again whenever
 * the ground draws. The scheduler takes over `batchDraw` on the ground and
 * relief layer instances, so react-konva's commits, Konva's own requests
 * and `Stage.batchDraw` all reach it. Each frame it draws the ground if
 * marked, then the relief if marked or if the ground drew. The drag and
 * overlay layers keep Konva's own batchDraw.
 */

/** What the scheduler needs of a Konva layer. */
export type DrawTarget = { draw(): unknown; batchDraw(): unknown };

type Frames = { request(run: () => void): number; cancel(id: number): void };

const BROWSER_FRAMES: Frames = {
  request: (run) => requestAnimationFrame(run),
  cancel: (id) => cancelAnimationFrame(id),
};

export class FrameScheduler {
  readonly #ground: DrawTarget;
  readonly #relief: DrawTarget;
  readonly #frames: Frames;
  #groundMarked = false;
  #reliefMarked = false;
  #frame = 0;
  /** Frames drawn and layer draws made, for the bench and the tests. */
  frames = 0;
  draws = 0;

  constructor(ground: DrawTarget, relief: DrawTarget, frames: Frames = BROWSER_FRAMES) {
    this.#ground = ground;
    this.#relief = relief;
    this.#frames = frames;
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

  mark(which: "ground" | "relief"): void {
    if (which === "ground") this.#groundMarked = true;
    else this.#reliefMarked = true;
    if (this.#frame === 0) this.#frame = this.#frames.request(() => this.run());
  }

  /** Draws what is marked: the ground first, then the relief, which copies it. */
  run(): void {
    this.#frame = 0;
    this.frames++;
    if (this.#groundMarked) {
      this.#groundMarked = false;
      this.#reliefMarked = true;
      this.#ground.draw();
      this.draws++;
    }
    if (this.#reliefMarked) {
      this.#reliefMarked = false;
      this.#relief.draw();
      this.draws++;
    }
  }

  detach(): void {
    if (this.#frame !== 0) this.#frames.cancel(this.#frame);
    this.#frame = 0;
    delete (this.#ground as { batchDraw?: unknown }).batchDraw;
    delete (this.#relief as { batchDraw?: unknown }).batchDraw;
  }
}
