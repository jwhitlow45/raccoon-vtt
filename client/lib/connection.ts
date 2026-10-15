/**
 * Connection states from design section 7.5. Only `open` counts as
 * connected, and the socket layer must report `open` only once the snapshot
 * has arrived, so a socket stuck behind a database retry on the server never
 * looks like an empty, healthy room.
 */
export type ConnectionState = "connecting" | "open" | "reconnecting" | "offline";

/** The banner waits this long, so a quick blip on a phone does not flash it. */
export const BANNER_DELAY_MS = 3000;

export function dotColor(state: ConnectionState): "green" | "amber" | "red" {
  if (state === "open") return "green";
  if (state === "offline") return "red";
  return "amber";
}

export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "open":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return "Offline";
  }
}
