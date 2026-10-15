/**
 * What Escape closes in the room, nearest first: a phone's panel sheet,
 * then the token action bar. A modal dialog over the room (a handout, the image
 * picker, "view as a player") closes itself on Escape, so nothing under it
 * closes too. In a text field Escape belongs to the field, which uses it to
 * drop an edit.
 */
export function escapeTarget(input: { dialogOpen: boolean; editing: boolean; sheetOpen: boolean; actionBar: boolean }): "sheet" | "actionBar" | null {
  if (input.dialogOpen || input.editing) return null;
  if (input.sheetOpen) return "sheet";
  if (input.actionBar) return "actionBar";
  return null;
}
