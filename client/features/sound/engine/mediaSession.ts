/**
 * The Media Session while this page plays the room's sound
 * (docs/design/design-v1-music.md 4.4): the lock screen and the headset's
 * buttons. Its title is "RaccoonVTT · <room name>", never a track, so the
 * lock screen tells no one what plays. Its pause turns Room sound off on
 * this device and its play turns it on.
 */

export type MediaSessionDeps = { roomName(): string; setOn(on: boolean): void };

type Session = MediaSession & { setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void };

function session(): Session | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return null;
  return navigator.mediaSession as Session;
}

export function mediaTitle(roomName: string): string {
  return roomName ? `RaccoonVTT · ${roomName}` : "RaccoonVTT";
}

export class SoundMediaSession {
  readonly #deps: MediaSessionDeps;
  #shown = false;
  #title = "";

  constructor(deps: MediaSessionDeps) {
    this.#deps = deps;
  }

  /** While this page plays the room's sound, the session names the room and takes play and pause. */
  set(playing: boolean): void {
    const s = session();
    if (!s) return;
    const title = mediaTitle(this.#deps.roomName());
    if (playing) {
      if (!this.#shown || title !== this.#title) {
        try {
          s.metadata = typeof MediaMetadata === "function" ? new MediaMetadata({ title, artist: "", album: "" }) : null;
          s.setActionHandler("pause", () => this.#deps.setOn(false));
          s.setActionHandler("play", () => this.#deps.setOn(true));
        } catch {
          // A browser that knows the session but not an action: the rest still works.
        }
      }
      this.#shown = true;
      this.#title = title;
      s.playbackState = "playing";
      return;
    }
    if (!this.#shown) return;
    // Paused rather than cleared, so the lock screen's play can turn the sound back on.
    s.playbackState = "paused";
  }

  dispose(): void {
    const s = session();
    if (!s || !this.#shown) return;
    try {
      s.setActionHandler("pause", null);
      s.setActionHandler("play", null);
      s.metadata = null;
      s.playbackState = "none";
    } catch {
      // As above.
    }
    this.#shown = false;
  }
}
