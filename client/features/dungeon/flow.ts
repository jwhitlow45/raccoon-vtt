/*
 * How the Generate a dungeon dialog's preview stands
 * (docs/design/design-v1-dungeon-generator.md 4.3), kept pure so a
 * randomized test walks it. Make sends the answer it holds, so Make is on
 * only for the newest request's answer once that very answer's picture is
 * on screen. The worker answers before the picture is drawn (textures load
 * and the image encodes after), and until it is, the box still shows the
 * previous dungeon. A picture that fails to draw keeps Make off, since the
 * DM would be making a dungeon they never saw.
 */

/** A worker's answer: the dungeon, or why there is none. */
export type Answer<T> = { ok: true; value: T } | { ok: false; error: "fit" | "bug" };

export type Flow<T extends { drawn: object }> = {
  /** The newest request's number. An answer to any other is dropped. */
  asked: number;
  /** The newest request is not answered yet. */
  pending: boolean;
  /** The seed field reads as a seed. */
  seedOk: boolean;
  /** The newest dungeon answered. It stays through a later error, as the old picture does. */
  shown: T | null;
  problem: "fit" | "bug" | null;
  /** The drawing whose picture the box shows, null while it shows none. */
  pictured: object | null;
  /** A drawing whose picture could not be made. */
  failed: object | null;
};

export type FlowEvent<T> =
  | { k: "ask"; id: number }
  /** The seed stopped reading as one. A request still drawing is overtaken, so its answer never replaces the one shown. */
  | { k: "invalid"; id: number }
  | { k: "answer"; id: number; answer: Answer<T> }
  | { k: "pictured"; drawn: object }
  | { k: "pictureFailed"; drawn: object };

export function startFlow<T extends { drawn: object }>(): Flow<T> {
  return { asked: 0, pending: false, seedOk: true, shown: null, problem: null, pictured: null, failed: null };
}

export function flowStep<T extends { drawn: object }>(f: Flow<T>, e: FlowEvent<T>): Flow<T> {
  switch (e.k) {
    case "ask":
      return { ...f, asked: e.id, pending: true, seedOk: true };
    case "invalid":
      return { ...f, asked: e.id, pending: false, seedOk: false };
    case "answer":
      // A bad seed asks nothing, so an answer then is a stale one.
      if (e.id !== f.asked || !f.seedOk) return f;
      return e.answer.ok ? { ...f, pending: false, shown: e.answer.value, problem: null } : { ...f, pending: false, problem: e.answer.error };
    case "pictured":
      // A picture of a drawing already overtaken still shows, but stands for nothing Make would send.
      return { ...f, pictured: e.drawn, failed: f.failed === e.drawn ? null : f.failed };
    case "pictureFailed":
      // The box empties on a failure, so nothing is pictured.
      return { ...f, pictured: null, failed: e.drawn };
  }
}

export type Readiness<T> = {
  /** What Make would send, or null while Make is off for the preview's sake. */
  current: T | null;
  /** "Drawing the dungeon…": a request out, or an answer whose picture is not in yet. */
  drawing: boolean;
  /** The newest dungeon's picture could not be drawn. */
  pictureFailed: boolean;
};

export function readiness<T extends { drawn: object }>(f: Flow<T>): Readiness<T> {
  const answered = f.seedOk && !f.pending && f.problem === null ? f.shown : null;
  const failed = answered !== null && f.failed === answered.drawn;
  const pictured = answered !== null && f.pictured === answered.drawn;
  return {
    current: pictured ? answered : null,
    drawing: f.seedOk && (f.pending || (answered !== null && !pictured && !failed)),
    pictureFailed: failed,
  };
}

/**
 * The drawing the box should be rendering, or null for none. A seed that
 * stopped reading cancels a render in flight, so a picture made after it
 * never replaces the one kept, and a failed encode never clears it.
 */
export function drawable<T extends { drawn: object }>(f: Flow<T>): T["drawn"] | null {
  return f.seedOk ? (f.shown?.drawn ?? null) : null;
}
