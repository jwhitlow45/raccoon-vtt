import { createStore, type StoreApi } from "zustand/vanilla";
import { uuidv7 } from "#shared/ids.ts";
import type { RoomState } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { shareState } from "../../state/share.ts";
import type { RoomUi } from "../../state/store.ts";
import { addToSelection, doneSelecting, keepSelected, selectToken, setMultiSelect, showActions, tapToken } from "../../state/selection.ts";
import { crossWide, EMPTY_EPHEMERAL, INITIAL_LOCAL, withoutPanel, withoutSheets, withPanel, withPanelList, withSheetHidden, withSidePanelHidden, type RoomActions, type RoomView } from "../../state/types.ts";

/**
 * "View as a player" (features section 13): the DM sees exactly what one
 * player sees, with fog and without hidden things.
 *
 * Nothing is asked of the server. The DM's own view already holds the whole
 * scene the DM is looking at, so the shared projection (shared/project.ts,
 * the same code the server runs before anything reaches a player) turns it
 * into that player's view. That only works when the DM is looking at the
 * players' scene: another scene's contents are not in the DM's view.
 */
export function playerPreview(dmView: RoomState, dmSceneId: string | null, memberId: string): RoomState | null {
  const playerScene = dmView.meta.playerSceneId;
  if (playerScene !== null && playerScene !== dmSceneId) return null;
  return projectState(dmView, { memberId, role: "player" }, { sceneId: null }) as unknown as RoomState;
}

/** The parts of a store the preview reads. The live store and the fixture's both fit. */
export type PreviewSource = Pick<StoreApi<RoomView>, "getState" | "subscribe">;

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
 * follows the DM's store, and every action is refused locally, so a tap in
 * the preview can never change the room or reach the server. `onRefuse`
 * lets the preview's own banner say so. Without it, a toast does.
 */
export function createPreview(source: PreviewSource, memberId: string, options: { name?: string; onRefuse?: () => void } = {}): Preview {
  const notice = `You are viewing as ${options.name ?? "a player"}. Nothing you do here is saved.`;
  let toastSeq = 0;
  let snapTimer: ReturnType<typeof setTimeout> | null = null;

  const derive = (src: RoomView, prevView: RoomState | null): Pick<RoomView, "view" | "sceneId" | "connection" | "online" | "roomId"> => {
    const projected = src.view ? playerPreview(src.view, src.sceneId, memberId) : null;
    return {
      roomId: src.roomId,
      view: projected ? shareState(prevView, projected) : null,
      sceneId: src.view?.meta.playerSceneId ?? null,
      connection: src.connection,
      online: src.online,
    };
  };

  const store = createStore<RoomView>()(() => ({
    ...derive(source.getState(), null),
    you: { memberId, role: "player" },
    // A player never gets the signal.
    accessVersion: 0,
    ephemeral: EMPTY_EPHEMERAL,
    busy: {},
    toasts: [],
    ended: null,
    local: INITIAL_LOCAL,
    // The preview never sends anything.
    pending: [],
  }));

  const refresh = () => store.setState(derive(source.getState(), store.getState().view));

  const unsubscribe = source.subscribe((s, prev) => {
    if (s.view !== prev.view || s.sceneId !== prev.sceneId || s.connection !== prev.connection || s.online !== prev.online) refresh();
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
    select: (tokenId) => store.setState({ local: selectToken(store.getState().local, tokenId) }),
    tap: (tokenId, add) => store.setState({ local: tapToken(store.getState().local, tokenId, add) }),
    selectMany: (tokenIds) => store.setState({ local: addToSelection(store.getState().local, tokenIds) }),
    keepSelected: (present) => store.setState({ local: keepSelected(store.getState().local, present) }),
    setMultiSelect: (on) => store.setState({ local: setMultiSelect(store.getState().local, on) }),
    doneSelecting: () => store.setState({ local: doneSelecting(store.getState().local) }),
    showActions: (open) => store.setState({ local: showActions(store.getState().local, open) }),
    openPanel: (id) => store.setState({ local: withPanel(store.getState().local, id) }),
    closePanel: () => store.setState({ local: withoutPanel(store.getState().local) }),
    showPanelList: (open) => store.setState({ local: withPanelList(store.getState().local, open) }),
    closeSheets: () => store.setState({ local: withoutSheets(store.getState().local) }),
    hideSheet: (hidden) => store.setState({ local: withSheetHidden(store.getState().local, hidden) }),
    hideSidePanel: (hidden) => store.setState({ local: withSidePanelHidden(store.getState().local, hidden) }),
    crossWide: (wide) => store.setState({ local: crossWide(store.getState().local, wide) }),
    notify: (text, tone = "info") => {
      const toasts = store.getState().toasts;
      if (!toasts.some((t) => t.text === text)) store.setState({ toasts: [...toasts, { id: ++toastSeq, text, tone }].slice(-3) });
    },
    dismissToast: (id) => store.setState({ toasts: store.getState().toasts.filter((t) => t.id !== id) }),
    // The preview has no socket, so no X-card ever reaches it.
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
