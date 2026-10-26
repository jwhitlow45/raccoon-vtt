import { createStore, type StoreApi } from "zustand/vanilla";
import { uuidv7 } from "#shared/ids.ts";
import { realClock, type Clock } from "../../state/timing.ts";
import { drawnToasts, heldToasts, type RoomUi } from "../../state/store.ts";
import { addToSelection, doneSelecting, keepSelected, selectToken, setMultiSelect, showActions, tapToken } from "../../state/selection.ts";
import { crossWide, INITIAL_LOCAL, withoutBelow, withoutPanel, withoutSheets, withPanel, withPanelList, withSheetExpanded, withSheetHidden, withSidePanelHidden, withSplit, withSplitFits, withSwap, type RoomActions, type RoomView } from "../../state/types.ts";
import { panelById } from "../panels.ts";

/**
 * "View as a player" (features section 13): the DM sees exactly what one
 * player sees, with fog and without hidden things.
 *
 * The server projects it (docs/design-v1-per-player-vision.md 7.4): a
 * preview socket asks for the room as that player (state/socket.ts
 * previewOf), on whichever scene the DM is looking at, and the room store
 * behind it holds that player's own projection, their own sight and map
 * on a per-player scene included, which the DM's view cannot make, and no
 * whisper between players. This file turns that store into a read-only
 * room for the Room page: every action is refused on the device, and the
 * socket sends nothing but its hello.
 */

/** The notice of a refused action, where no banner says it (PlayerPreview's does). */
export function previewNotice(name: string | undefined): string {
  return `You are viewing as ${name ?? "a player"}. Nothing you do here is saved. Whispers between players are not shown.`;
}

/** The parts of a store the preview reads. The live store and the fixture's both fit. */
export type PreviewSource = Pick<StoreApi<RoomView>, "getState" | "subscribe">;

/** How long the preview waits for the player's snapshot before it says it could not load (docs/design-v1-per-player-vision.md 7.4). */
export const PREVIEW_LOAD_MS = 10_000;

export type PreviewLoad = "loading" | "loaded" | "failed";

/**
 * Where a preview's wait stands (7.4): loading until the player's
 * snapshot lands in its store, then loaded, and failed once its socket
 * ended (refused, closed before it loaded, or turned away later) or
 * PREVIEW_LOAD_MS passed with no snapshot. Failed is final: it stops the
 * socket (`stop`), so a snapshot that comes late draws nothing. Each
 * change is told to `onChange`, the first one at once when the store
 * already says it.
 */
export function watchPreviewLoad(source: PreviewSource, options: { stop(): void; onChange(load: PreviewLoad): void; clock?: Clock }): { readonly load: PreviewLoad; dispose(): void } {
  const clock = options.clock ?? realClock;
  let load: PreviewLoad = "loading";
  const set = (next: PreviewLoad) => {
    if (load === next || load === "failed") return;
    load = next;
    if (next === "failed") options.stop();
    options.onChange(next);
  };
  const read = () => {
    const s = source.getState();
    if (s.ended !== null) set("failed");
    else if (s.view !== null) set("loaded");
  };
  const unsubscribe = source.subscribe(read);
  const timer = clock.setTimeout(() => {
    if (load === "loading") set("failed");
  }, PREVIEW_LOAD_MS);
  read();
  return {
    get load() {
      return load;
    },
    dispose() {
      unsubscribe();
      clock.clearTimeout(timer);
    },
  };
}

export type Preview = {
  store: StoreApi<RoomView>;
  ui: RoomUi;
  actions: RoomActions;
  dispose(): void;
};

/** How long a refused drag shows where it was dropped before it snaps back, as a server refusal would. */
const SNAP_BACK_MS = 250;

/**
 * A read-only room for the Room page to draw a player's view from. It
 * follows the preview socket's store (`source`), the player's own
 * projection as the server sent it, and every action is refused locally,
 * so a tap in the preview can never change the room or reach the server.
 * `onRefuse` lets the preview's own banner say so. Without it, a toast
 * does.
 */
export function createPreview(source: PreviewSource, memberId: string, options: { name?: string; onRefuse?: () => void } = {}): Preview {
  const notice = previewNotice(options.name);
  let toastSeq = 0;
  let snapTimer: ReturnType<typeof setTimeout> | null = null;

  // What the player's own room shows, as their socket holds it. The view keeps its identity until the server changes it.
  const derive = (src: RoomView): Pick<RoomView, "view" | "sceneId" | "connection" | "online" | "roomId" | "ephemeral"> => ({
    roomId: src.roomId,
    view: src.view,
    sceneId: src.sceneId,
    connection: src.connection,
    online: src.online,
    ephemeral: src.ephemeral,
  });

  const store = createStore<RoomView>()(() => ({
    ...derive(source.getState()),
    you: { memberId, role: "player" },
    // A player never gets the signal.
    accessVersion: 0,
    busy: {},
    toasts: [],
    ended: null,
    local: INITIAL_LOCAL,
    // The preview never sends anything.
    pending: [],
  }));

  const refresh = () => store.setState(derive(source.getState()));

  const unsubscribe = source.subscribe((s, prev) => {
    if (s.view !== prev.view || s.sceneId !== prev.sceneId || s.connection !== prev.connection || s.online !== prev.online || s.ephemeral !== prev.ephemeral) refresh();
  });

  const refuse = () => {
    if (options.onRefuse) return options.onRefuse();
    const toasts = store.getState().toasts;
    if (toasts.some((t) => t.text === notice)) return;
    store.setState({ toasts: [...toasts, { id: ++toastSeq, text: notice, tone: "info" as const }].slice(-3) });
  };

  const setLocal = (patch: Partial<RoomView["local"]>) => {
    const local = store.getState().local;
    store.setState({ local: { ...local, ...patch } });
  };

  const ui: RoomUi = {
    setTool: (id) => setLocal({ tool: id }),
    select: (tokenId, opts) => store.setState({ local: selectToken(store.getState().local, tokenId, opts?.opens === true) }),
    tap: (tokenId, add) => store.setState({ local: tapToken(store.getState().local, tokenId, add) }),
    selectMany: (tokenIds) => store.setState({ local: addToSelection(store.getState().local, tokenIds) }),
    keepSelected: (present) => store.setState({ local: keepSelected(store.getState().local, present) }),
    setMultiSelect: (on) => store.setState({ local: setMultiSelect(store.getState().local, on) }),
    doneSelecting: () => store.setState({ local: doneSelecting(store.getState().local) }),
    showActions: (open) => store.setState({ local: showActions(store.getState().local, open) }),
    openPanel: (id, how) => store.setState({ local: withPanel(store.getState().local, id, how, panelById(id)?.narrowOnly === true) }),
    // The preview is a player's room, so its split starts on a player's panels and never meets the DM's (docs/design-v1-split-panel.md 8).
    splitPanels: (on, pair) => store.setState({ local: on ? withSplit(store.getState().local, "player", pair) : withoutBelow(store.getState().local) }),
    swapPanels: () => store.setState({ local: withSwap(store.getState().local) }),
    fitSplit: (fits) => store.setState({ local: withSplitFits(store.getState().local, fits) }),
    closePanel: () => store.setState({ local: withoutPanel(store.getState().local) }),
    showPanelList: (open) => store.setState({ local: withPanelList(store.getState().local, open) }),
    closeSheets: () => store.setState({ local: withoutSheets(store.getState().local) }),
    hideSheet: (hidden) => store.setState({ local: withSheetHidden(store.getState().local, hidden) }),
    expandSheet: (on) => store.setState({ local: withSheetExpanded(store.getState().local, on) }),
    hideSidePanel: (hidden) => store.setState({ local: withSidePanelHidden(store.getState().local, hidden) }),
    crossWide: (wide) => store.setState({ local: crossWide(store.getState().local, wide) }),
    notify: (text, tone = "info") => {
      const toasts = store.getState().toasts;
      if (!toasts.some((t) => t.text === text)) store.setState({ toasts: [...toasts, { id: ++toastSeq, text, tone }].slice(-3) });
    },
    dismissToast: (id) => store.setState({ toasts: store.getState().toasts.filter((t) => t.id !== id) }),
    // The preview's toasts keep the room's times (store.ts toastsLeft).
    toastsDrawn: (ids) => {
      const toasts = drawnToasts(store.getState().toasts, ids, Date.now());
      if (toasts !== store.getState().toasts) store.setState({ toasts: [...toasts] });
    },
    holdToast: (id, held) => {
      const toasts = heldToasts(store.getState().toasts, id, held, Date.now());
      if (toasts !== store.getState().toasts) store.setState({ toasts: [...toasts] });
    },
    // The preview's socket is read only, so its X-card is the DM's own room's to answer.
    dismissXcard: () => {},
  };

  /**
   * The canvas leaves dropped tokens where the finger let go until the view
   * moves them. Show the drop for a moment, then the unchanged view, so the
   * tokens snap back the way a refused move does.
   */
  const showRefusedMoves = (moves: readonly { tokenId: string; x: number; y: number }[]) => {
    const view = store.getState().view;
    refuse();
    if (!view) return;
    const tokens = { ...view.tokens };
    for (const m of moves) {
      const token = tokens[m.tokenId];
      if (token) tokens[m.tokenId] = { ...token, x: m.x, y: m.y };
    }
    store.setState({ view: { ...view, tokens } });
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      snapTimer = null;
      refresh();
    }, SNAP_BACK_MS);
  };

  const actions: RoomActions = {
    dispatch() {
      refuse();
      return null;
    },
    sendEph() {},
    switchScene() {},
    undo: refuse,
    redo: refuse,
    newId: () => uuidv7(),
    moveToken(tokenId, x, y) {
      showRefusedMoves([{ tokenId, x, y }]);
    },
    moveTokens(moves) {
      showRefusedMoves(moves);
    },
  };

  return {
    store,
    ui,
    actions,
    dispose() {
      unsubscribe();
      if (snapTimer) clearTimeout(snapTimer);
    },
  };
}
