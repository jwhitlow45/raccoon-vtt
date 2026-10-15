/**
 * The table display's own scale: a TV read from across the room, typed on
 * with a remote. Larger than the app's (lib/theme.ts), which is made for a
 * phone in the hand, and kept apart from it so a change to the app's type
 * never shrinks what the table reads (docs/design-v1-visual.md 3.6).
 */
export const TV_TEXT = {
  /** The notes under the menu, its errors and the text size row's name. */
  small: 16,
  /** Menu buttons, the connection banner and the closing page's message. */
  body: 18,
  /** "Waiting for the DM to choose a scene" and a handout that did not load. */
  message: 20,
  /** Whose turn it is, over the map. */
  turn: 22,
  /** A handout's title and the closing page's heading. */
  title: 28,
  /** The pairing code as it is typed. */
  code: 36,
} as const;

/** The height of a button a remote's arrow keys land on, and of the code field, read from the couch. */
export const TV_BUTTON_HEIGHT = 56;
export const TV_CODE_FIELD_HEIGHT = 72;

/** Behind a handout on the TV: darker than a dialog's scrim, since the picture is the only thing to read. */
export const TV_HANDOUT_SCRIM = "rgba(0, 0, 0, 0.88)";
