/**
 * What Escape closes in the room, nearest first: a phone's panel sheet,
 * then the token action bar, then a Multi-select group whose bar is
 * hidden, which Escape lets go of as Done does, then a selected token
 * whose bar is hidden, which it lets go of (state/selection.ts
 * dismissal). A modal dialog over the room (a handout, the image picker,
 * "view as a player") closes itself on Escape, so nothing under it closes
 * too. In a text field Escape belongs to the field, which uses it to drop
 * an edit.
 */
export function escapeTarget(input: {
  dialogOpen: boolean;
  editing: boolean;
  sheetOpen: boolean;
  actionBar: boolean;
  group: boolean;
  token?: boolean;
}): "sheet" | "actionBar" | "group" | "token" | null {
  if (input.dialogOpen || input.editing) return null;
  if (input.sheetOpen) return "sheet";
  if (input.actionBar) return "actionBar";
  if (input.group) return "group";
  if (input.token) return "token";
  return null;
}

/**
 * The Escape presses that room's own handler (pages/RoomChrome.tsx useEscape) used to let go of the
 * action bar or the selection. Room marks every Escape it takes as used, and a layer that listens
 * after it, as the stopped walk's note does, tells this one from a pop-up's or a pane's by this set.
 */
export const roomLetGo = new WeakSet<Event>();
