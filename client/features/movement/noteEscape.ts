/**
 * Whether an Escape closes the stopped walk's note. One Escape closes one thing: a press that a
 * pop-up, a pane or a list step back used (`defaultPrevented`) leaves the note open, unless it was
 * Room's own letting go of the action bar or the selection, which takes the note with it. A modal
 * dialog or a text field keeps its Escape.
 */
export function escapeClosesNote(input: { busy: boolean; defaultPrevented: boolean; roomLetGo: boolean; editing: boolean; dialogOpen: boolean }): boolean {
  if (input.busy || input.editing || input.dialogOpen) return false;
  return !input.defaultPrevented || input.roomLetGo;
}
