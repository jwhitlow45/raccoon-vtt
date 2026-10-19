import { useEffect } from "react";
import { scopeSlot, type RoomScope } from "../../state/scope.ts";
import { isTextField } from "../../state/shortcuts.ts";
import {
  clipboardImage,
  holdsImage,
  IOS_NO_IMAGE,
  pasteError,
  pastedFile,
  REFUSED,
  severalImages,
  type ClipItem,
  type PasteAccepts,
  type PasteData,
  type Pasted,
} from "./paste.ts";

/**
 * Which entry takes a paste, and one entry's own paste in progress
 * (docs/design-v1-paste.md 1.2 and 1.3).
 *
 * Every image entry registers with its Room page's router, which holds one
 * `paste` listener on the document, so exactly one entry takes a paste even
 * with two panels open. It listens in the bubble phase, so the paste box's
 * own handler and React's run first, and a paste they cancel stays theirs.
 */

/**
 * When an entry takes a key paste: while it is open, only with focus inside
 * it (a scene's Map image and Add a phase, which upload at once and are on
 * screen whenever the Scenes panel is), or never (its Paste button only).
 */
export type PasteTake = "open" | "focus" | "none";

/** What an entry declares: what it takes, when, whether it is busy, and the handlers its file control already calls. */
export type PasteSpec = {
  accepts: PasteAccepts;
  takes: PasteTake;
  /**
   * Busy by the same rule as its file control (uploading, or finding a
   * grid), or closed. Checked again when a late answer or a box paste
   * arrives, so a disabled entry hands nothing on by any path.
   */
  disabled: boolean;
  /**
   * The entry is closed or unconfirmed: a form folded away, or the players'
   * Map image row before the DM confirms. It is disabled too, and turning
   * closed drops a read still waiting, the box and the note (design 3.3).
   */
  closed?: boolean;
  onFile(file: File): void;
  /** An https link, for Choose an image alone. */
  onLink?(url: string): void;
};

/** The parts of an element the choice reads, so it is tested without a DOM. */
export type PasteElement = {
  contains(other: unknown): boolean;
  checkVisibility?: () => boolean;
  getClientRects(): { length: number };
};

export type PasteCandidate<T> = { el: PasteElement | null; takes: PasteTake; seq: number; value: T };

export type PasteInput<T> = {
  defaultPrevented: boolean;
  preview: boolean;
  /** Where the paste was aimed: the focused element, or the body when nothing has focus. */
  at: unknown;
  /** The clipboard holds text, which a text field takes. */
  hasText: boolean;
  /** The clipboard holds a file, which a plain text field cannot take. */
  hasFiles: boolean;
  /** The clipboard holds an image file, the one thing the room-level offer takes. */
  hasImage: boolean;
  /** Every open modal dialog (`[aria-modal="true"]`), oldest first. */
  modals: readonly PasteElement[];
  /** The registered entries, in the order they opened. */
  targets: readonly PasteCandidate<T>[];
  /** The DM's room-level offer is there to take an image no entry took (4). */
  roomOffer: boolean;
};

export type PasteChoice<T> = { kind: "target"; target: T } | { kind: "room" } | null;

/**
 * Shown on screen. The side panel, a split's second pane and a phone's
 * panel sheet stay mounted while hidden, and a form left open there must
 * never take a paste out of sight. A closed sheet hides through a CSS rule
 * with no `[hidden]` to find, so where `checkVisibility` is missing (Safari
 * before 17.4) the element's boxes tell.
 */
function shown(el: PasteElement): boolean {
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0;
}

/** The innermost of several entries that all hold the focus. */
function innermost<T>(list: readonly PasteCandidate<T>[]): PasteCandidate<T> | undefined {
  return list.find((a) => !list.some((b) => b !== a && b.el !== null && a.el !== null && a.el.contains(b.el)));
}

/**
 * The entry a paste goes to, the room-level offer, or nothing (1.3). A
 * disabled entry is chosen all the same, and then takes the paste and does
 * nothing, so a second Ctrl+V during an upload never passes to another.
 */
export function pasteTarget<T>(input: PasteInput<T>): PasteChoice<T> {
  if (input.defaultPrevented || input.preview) return null;
  const inField = isTextField(input.at);
  // A field's own paste whenever there is text to paste, and an image only when it holds a file and no text.
  if (inField && (input.hasText || !input.hasFiles)) return null;
  const newest = input.modals.at(-1);
  const live = input.targets.filter((t): t is PasteCandidate<T> & { el: PasteElement } => t.el !== null && t.takes !== "none" && shown(t.el) && (!newest || newest.contains(t.el)));
  const focused = innermost(live.filter((t) => t.el.contains(input.at)));
  if (focused) return { kind: "target", target: focused.value };
  // A field's image goes only to the entry around it.
  if (inField) return null;
  const open = live.filter((t) => t.takes === "open").sort((a, b) => b.seq - a.seq)[0];
  if (open) return { kind: "target", target: open.value };
  if (!newest && input.roomOffer && input.hasImage) return { kind: "room" };
  return null;
}

/** A note under an entry: why a paste gave nothing, or that the clipboard held several images. */
export type PasteNote = { text: string; tone: "error" | "info" };

export type PasteView = { reading: boolean; note: PasteNote | null; box: boolean };

export type PasteControlDeps = {
  spec(): PasteSpec;
  /** `navigator.clipboard.read`, or null where the browser has none. */
  read: (() => Promise<readonly ClipItem[]>) | null;
  now(): Date;
  /** iOS, where a `read()` that finds no picture opens the box too (3.2). */
  ios: boolean;
  /** Where to paste instead, after the refusal's words: a phone's press and hold or a computer's key. */
  boxHint: string;
  /** The view changed. */
  onChange(): void;
};

const NO_IMAGE_SHORT = "The clipboard has no image in it.";

/**
 * One entry's paste: the Paste button's `clipboard.read()`, a key paste the
 * router hands it, and a paste into the box. It juggles a read that answers
 * late, an entry that turns busy meanwhile, and the entry closing, so its
 * rules hold whatever comes in whatever order (pasteRouter.test.ts):
 *
 * - At most one read whose answer counts is in flight, and a key paste
 *   while it is cannot start a second upload: the entry counts as disabled.
 * - Nothing is handed on after the entry unmounts or closes, nor to an
 *   entry that is busy or closed when the answer comes. A read the entry
 *   closed on never counts, even once it opens again.
 * - Each read hands on at most one file.
 */
export class PasteControl {
  #view: PasteView = { reading: false, note: null, box: false };
  #live = true;
  /** Bumped when the entry closes, so an answer to a read started before then is dropped. */
  #round = 0;
  readonly #deps: PasteControlDeps;

  constructor(deps: PasteControlDeps) {
    this.#deps = deps;
  }

  get view(): PasteView {
    return this.#view;
  }

  /** Busy, closed, or reading the clipboard: a paste chosen for this entry stops here and does nothing. */
  get disabled(): boolean {
    return this.#view.reading || this.#off();
  }

  /** The entry itself takes nothing now: busy or closed. */
  #off(): boolean {
    const spec = this.#deps.spec();
    return spec.disabled || spec.closed === true;
  }

  /** The entry is on screen again, as after React's development double mount. */
  attach(): void {
    this.#live = true;
  }

  /** The entry closed: a late answer finds nothing to hand on. */
  detach(): void {
    this.#live = false;
  }

  /**
   * The Paste button. `read()` is called before anything awaits, so the
   * press's activation holds in Safari and Firefox, and nothing asks the
   * permission's state first.
   */
  press(): void {
    if (!this.#live || this.disabled) return;
    const { read } = this.#deps;
    const accepts = this.#deps.spec().accepts;
    let answer: Promise<readonly ClipItem[]> | null = null;
    try {
      answer = read ? read() : null;
    } catch {
      // A browser may refuse at once, by throwing rather than rejecting.
    }
    if (!answer) {
      this.#refused();
      return;
    }
    this.#set({ reading: true, note: null });
    const round = this.#round;
    const counts = () => this.#live && round === this.#round;
    answer
      .then((items) => clipboardImage(items, accepts))
      .then(
        (pasted) => {
          if (!counts()) return;
          this.#set({ reading: false });
          this.#take(pasted, "button");
        },
        () => {
          if (!counts()) return;
          this.#set({ reading: false });
          // A refusal for an entry that turned busy or closed meanwhile opens no box there.
          if (!this.#off()) this.#refused();
        },
      );
  }

  /** A key paste the router chose this entry for. */
  fromKey(data: PasteData): void {
    if (!this.#live || this.disabled) return;
    this.#take(clipboardImage(data, this.#deps.spec().accepts), "key");
  }

  /** A paste into the box, which keeps its entry's rule. */
  fromBox(data: PasteData): void {
    if (!this.#live || this.disabled) return;
    this.#take(clipboardImage(data, this.#deps.spec().accepts), "box");
  }

  /** The box's Cancel, which takes its words with it. */
  closeBox(): void {
    if (this.#view.box || this.#view.note) this.#set({ box: false, note: null });
  }

  /** The entry closed or disarmed while still mounted: a read still waiting no longer counts, and the box and the note go. */
  close(): void {
    this.#round++;
    if (this.#view.reading || this.#view.box || this.#view.note) this.#set({ reading: false, box: false, note: null });
  }

  #take(pasted: Pasted, from: "button" | "key" | "box"): void {
    // The entry turned busy or closed while the clipboard was read: a second upload would compete with its first, and a closed entry takes nothing.
    if (this.#off()) return;
    const spec = this.#deps.spec();
    if (pasted.kind === "file") {
      const several = severalImages(pasted.images);
      this.#set({ note: several ? { text: several, tone: "info" } : null, ...(from === "box" ? { box: false } : null) });
      spec.onFile(pastedFile(pasted.blob, pasted.name, this.#deps.now()));
      return;
    }
    if (pasted.kind === "link") {
      if (!spec.onLink) return;
      this.#set({ note: null, ...(from === "box" ? { box: false } : null) });
      spec.onLink(pasted.url);
      return;
    }
    // On iOS a photo held only as JPEG reaches the page through the box, as a file (3.2).
    if (from === "button" && this.#deps.ios && (pasted.why === "empty" || pasted.why === "page")) {
      this.#set({ note: { text: `${NO_IMAGE_SHORT} ${IOS_NO_IMAGE}`, tone: "error" }, box: true });
      return;
    }
    this.#set({ note: { text: pasteError(pasted.why), tone: "error" } });
  }

  #refused(): void {
    this.#set({ note: { text: `${REFUSED} ${this.#deps.boxHint}`, tone: "error" }, box: true });
  }

  #set(patch: Partial<PasteView>): void {
    if (!this.#live) return;
    this.#view = { ...this.#view, ...patch };
    this.#deps.onChange();
  }
}

/** One registered entry, read afresh at each paste. */
export type PasteRegistration = { seq: number; el(): Element | null; takes(): PasteTake; control: PasteControl };

/**
 * The room-level offer's taker (design 4), which the DM's Room page
 * registers: the pasted image, and how many the clipboard held.
 */
export type RoomPasteOffer = (file: File, images: number) => void;

/** One Room page's entries and its room-level offer (client/state/scope.ts). */
export const pasteSlot = scopeSlot(() => ({
  targets: new Set<PasteRegistration>(),
  seq: 0,
  room: null as RoomPasteOffer | null,
}));

/**
 * The Room page's one paste listener, beside its keyboard listener
 * (state/shortcuts.ts useShortcuts). A "view as a player" preview mounts
 * it switched off, as its keys are.
 */
export function usePasteRouter(input: { scope: RoomScope; preview: boolean }): void {
  const { scope, preview } = input;
  useEffect(() => {
    const registry = scope.get(pasteSlot);
    const candidates = (): PasteCandidate<PasteRegistration>[] => [...registry.targets].map((r) => ({ el: r.el(), takes: r.takes(), seq: r.seq, value: r }));
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const choice = pasteTarget({
        defaultPrevented: e.defaultPrevented,
        preview,
        at: e.target,
        hasText: data.types.includes("text/plain"),
        hasFiles: data.types.includes("Files") || data.files.length > 0,
        hasImage: holdsImage(data),
        modals: [...document.querySelectorAll('[aria-modal="true"]')],
        targets: candidates(),
        roomOffer: registry.room !== null,
      });
      if (!choice) return;
      e.preventDefault();
      if (choice.kind === "target") {
        choice.target.control.fromKey(data);
        return;
      }
      const pasted = clipboardImage(data, "image");
      if (pasted.kind === "file") registry.room?.(pastedFile(pasted.blob, pasted.name, new Date()), pasted.images);
    };
    /*
     * WebKit long fired no paste event without an editable element focused
     * (WebKit bug 75891), and its source enables Paste on a page whose
     * `beforepaste` handler cancels the event. So while an open entry is
     * on screen, the router cancels it. The Paste button works either way.
     */
    const onBeforePaste = (e: Event) => {
      if (preview || isTextField(e.target)) return;
      if (candidates().some((c) => c.takes === "open" && c.el !== null && shown(c.el))) e.preventDefault();
    };
    document.addEventListener("paste", onPaste);
    document.addEventListener("beforepaste", onBeforePaste);
    return () => {
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("beforepaste", onBeforePaste);
    };
  }, [scope, preview]);
}
