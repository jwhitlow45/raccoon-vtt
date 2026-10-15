import { passwordOfLink } from "./shareLink.ts";

export type LinkState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "shown"; password: string }
  /** The server holds no copy of the password it can open. */
  | { kind: "none" }
  | { kind: "error"; message: string };

export type PlayerLinkLoader = {
  readonly state: LinkState;
  /** Fetches the link, dropping any request still on its way. */
  show(): Promise<void>;
  hide(): void;
  /** The server's `access` signal: the password may have changed. */
  accessChanged(): void;
};

/**
 * The requests behind the DM's player link section (design 10.2). Each
 * request is numbered, and only the newest one's answer is shown. Another
 * DM device can change the password while a request is out, and the
 * server's answer to it may then carry the old password. So an access
 * signal fetches again whenever a link is on screen or on its way, and the
 * older answer, whenever it lands, is dropped.
 *
 * Plain functions, so the tests run without a DOM.
 */
export function createPlayerLinkLoader(deps: {
  /** The player link from the server, or null when it has none it can show. */
  fetch(): Promise<string | null>;
  describe(err: unknown): string;
  onChange(state: LinkState): void;
}): PlayerLinkLoader {
  let state: LinkState = { kind: "hidden" };
  let latest = 0;
  const set = (next: LinkState) => {
    state = next;
    deps.onChange(next);
  };

  const loader: PlayerLinkLoader = {
    get state() {
      return state;
    },
    async show() {
      const request = ++latest;
      set({ kind: "loading" });
      let next: LinkState;
      try {
        const link = await deps.fetch();
        const password = link ? passwordOfLink(link) : null;
        next = password ? { kind: "shown", password } : { kind: "none" };
      } catch (err) {
        next = { kind: "error", message: deps.describe(err) };
      }
      if (request === latest) set(next);
    },
    hide() {
      latest++;
      set({ kind: "hidden" });
    },
    accessChanged() {
      if (state.kind === "shown" || state.kind === "none" || state.kind === "loading") void loader.show();
    },
  };
  return loader;
}
