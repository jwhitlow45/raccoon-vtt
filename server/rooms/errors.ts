/** Thrown by the manager when a room must load and no loaded room may be unloaded to make space (design 10.5). */
export class TooBusyError extends Error {
  constructor() {
    super("no room can be unloaded to make space");
    this.name = "TooBusyError";
  }
}
