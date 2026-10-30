import { useEffect, useId, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { SheetDialog } from "../tokens/SheetDialog.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { turned, type View, type ViewKind } from "../../lib/view.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { keySuffix, useKeyHint } from "../../state/shortcuts.ts";
import { useRoomView } from "../../state/view.ts";
import {
  choiceOf,
  choiceWords,
  isoOffered,
  pickOf,
  menuLine,
  previewViewSlot,
  sayView,
  turnsReason,
  turnsReasons,
  suggestedKind,
  topDownTool,
  TURN_LEFT,
  TURN_LEFT_DESCRIPTION,
  TURN_RIGHT,
  TURN_RIGHT_DESCRIPTION,
  VIEW_CHOICES,
  VIEW_GROUP,
  VIEW_NAMES,
  viewGestureSlot,
  viewSaid,
  viewVoiceSlot,
  wantedKind,
  type ViewState,
} from "./choice.ts";
import { createStore, type StoreApi } from "zustand/vanilla";
import { usePreview } from "../dm/previewContext.ts";
import { FOLLOW_THE_SCENE, pickView, settledView, shownView, turnView, useStoredView, viewKey, withPick, withTurn, type StoredView, type ViewPick } from "./store.ts";

/*
 * The view choice's parts (docs/design-v1-isometric-view.md 7 and 8): the
 * view a page shows, the menu's rows, and the polite status. The View
 * button that opens the menu is the top bar's (pages/RoomChrome.tsx), and
 * the table display draws its own rows (features/display/DisplayRoom.tsx).
 */

/** What a page knows of its view: where the pick is kept, the scene's suggestion, the pick, and the view the board shows. */
export type ViewChoiceState = {
  key: string;
  sceneId: string | null;
  suggested: Scene["suggestedView"];
  stored: StoredView;
  /** The tool in use that shows Top-down, else null. */
  forcedBy: string | null;
  /** The view the user wants here, before a tool shows Top-down. */
  wanted: ViewKind;
  /** The view the board shows. */
  shown: View;
  /** Picks a view, or Follow the scene with null, where this page keeps its view. */
  pick(pick: ViewPick): void;
  /** Turns this scene's view a step, while the board shows Isometric. */
  turn(by: 1 | -1): void;
};

/** Read when a page keeps its view in storage, so the hooks run the same on every page. */
const NO_MEMORY = createStore<StoredView>(() => FOLLOW_THE_SCENE);

/**
 * A page's view from where its pick is kept: the pick, else the scene's
 * suggestion, at the scene's turn, Top-down while Isometric is not offered
 * or a tool shows Top-down (store.ts shownView). A change waits for a
 * gesture under way to end (settledView), so the map never turns under a
 * finger. `memory` keeps it in memory instead of this device's storage, as
 * "View as a player" does (choice.ts previewViewSlot).
 */
export function useViewChoice(input: {
  key: string;
  sceneId: string | null;
  suggested: Scene["suggestedView"];
  tool?: string | null;
  gesture?: boolean;
  memory?: StoreApi<StoredView> | null;
}): ViewChoiceState {
  const saved = useStoredView(input.key);
  const kept = useStore(input.memory ?? NO_MEMORY);
  const { memory, key, sceneId } = input;
  const stored = memory ? kept : saved;
  const forcedBy = topDownTool(input.tool);
  const target = shownView({ stored, sceneId: input.sceneId ?? "", suggested: input.suggested, forcedTopDown: forcedBy !== null, ready: isoOffered });
  const [showing, setShowing] = useState(target);
  // Views are kept one object each (lib/view.ts isometric), so the same view is the same object.
  const shown = settledView(showing, target, input.gesture === true);
  if (shown !== showing) setShowing(shown);
  const pick = (p: ViewPick) => {
    if (memory) memory.setState(withPick(memory.getState(), p), true);
    else pickView(key, p);
  };
  const turn = (by: 1 | -1) => {
    if (shown.kind !== "isometric" || !sceneId) return;
    const next = turned(shown.turn, by);
    if (memory) memory.setState(withTurn(memory.getState(), sceneId, next), true);
    else turnView(key, sceneId, next);
  };
  return { key, sceneId, suggested: input.suggested, stored, forcedBy, wanted: wantedKind(stored, input.suggested), shown, pick, turn };
}

/** The Room page's view: this device's pick in this room, or a preview's own, the scene on screen, the tool in use and the board's gestures. */
export function useRoomViewChoice(): ViewChoiceState {
  const preview = usePreview() !== null;
  const memory = useScoped(previewViewSlot);
  const roomId = useRoomView((s) => s.roomId);
  const sceneId = useRoomView((s) => s.sceneId);
  const suggested = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId]?.suggestedView : undefined));
  const tool = useRoomView((s) => s.local.tool);
  const gesture = useStore(useScoped(viewGestureSlot), (g) => g.active);
  return useViewChoice({ key: viewKey(roomId), sceneId, suggested, tool, gesture, memory: preview ? memory : null });
}

/** Says each change of the view in the polite status (choice.ts viewSaid), whatever made it: the menu, a key, the DM's suggestion or a tool. */
export function useViewVoice(choice: ViewChoiceState): void {
  const scope = useRoomScope();
  const before = useRef<ViewState | null>(null);
  const { sceneId, shown, wanted, forcedBy } = choice;
  const pick = choice.stored.pick;
  useEffect(() => {
    const now: ViewState = { sceneId, shown, pick, wanted, forcedBy };
    const was = before.current;
    before.current = now;
    const said = was ? viewSaid(was, now) : null;
    if (said) sayView(scope, said);
  }, [scope, sceneId, shown, pick, wanted, forcedBy]);
}

/**
 * The status's region. One stands beside the View button, and while the
 * menu is open one stands inside it instead, since a phone's sheet is
 * modal and leaves the room's regions out of reach. Each starts empty, so
 * moving it says nothing again.
 */
export function ViewVoice() {
  const said = useStore(useScoped(viewVoiceSlot));
  const [from] = useState(said.key);
  return (
    <div role="status" data-rvtt-view-status="" style={VISUALLY_HIDDEN}>
      {said.key === from ? null : <span key={said.key}>{said.text}</span>}
    </div>
  );
}

/**
 * The menu's rows: the radio group "View", the line of a tool that shows
 * Top-down, and Turn left and Turn right while the board is Isometric. A
 * pick keeps the menu open, so Isometric's turns are a tap away. However
 * it opens, by a key, a click or a tap, focus goes to the checked radio
 * (design 8, D-261026-12), whose ring shows only after keys (globals.css).
 *
 * A popover keeps the size it opened with, and its content scrolls past
 * it (components/Popover.tsx), so a pick of Isometric would add the turns
 * under "Scroll for more". With `steadyTurns` the turns stay in every view,
 * disabled in Top-down with their reason under them (choice.ts
 * turnsReason), which holds a tool's line too (D-261026-12). The reason's
 * place is held in every view, so a pick never pushes it past the panel's
 * foot or leaves the panel taller than what it holds (ISO5-OPUS-9).
 */
export function ViewMenuBody(props: { choice: ViewChoiceState; steadyTurns?: boolean }) {
  const { choice } = props;
  const group = useRef<HTMLDivElement>(null);
  // After the sheet's dialog has opened and the popover has placed itself, both in layout effects.
  useEffect(() => {
    group.current?.querySelector<HTMLInputElement>("input:checked")?.focus({ preventScroll: true });
  }, []);
  const name = useId();
  const helpId = useId();
  const leftId = useId();
  const rightId = useId();
  const value = choiceOf(choice.stored.pick);
  const forced = menuLine(choice);
  const turns = choice.shown.kind === "isometric";
  const reasonId = useId();
  const reason = props.steadyTurns ? turnsReason(choice) : null;
  const described = (id: string) => (reason ? `${id} ${reasonId}` : id);
  const leftKey = useKeyHint("turnLeft");
  const rightKey = useKeyHint("turnRight");
  return (
    <div data-view-menu="" style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
      <div ref={group} role="radiogroup" aria-label={VIEW_GROUP} style={{ display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
        {VIEW_CHOICES.map((c) => {
          const chosen = c === value;
          return (
            <label key={c} className="rvtt-choice" style={{ ...ROW, ...buttonLook("quiet", { pressed: chosen }) }}>
              <input
                type="radio"
                name={name}
                value={c}
                checked={chosen}
                aria-describedby={c === "follow" ? helpId : undefined}
                onChange={() => choice.pick(pickOf(c))}
                style={RADIO_COVER}
              />
              <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
                <span>{choiceWords(c)}</span>
                {c === "follow" ? (
                  <span id={helpId} style={{ fontSize: theme.font.small, fontWeight: theme.weight.regular, color: theme.color.textMuted, lineHeight: theme.leading.body }}>
                    <SuggestionHelp suggested={choice.suggested} />
                  </span>
                ) : null}
              </span>
              {chosen ? <Icon name="check" size="sm" style={{ flex: "none" }} /> : null}
            </label>
          );
        })}
      </div>
      {forced && !props.steadyTurns ? <Help>{forced}</Help> : null}
      {turns || props.steadyTurns ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          {/* The key after the words, on a device with a keyboard, inside one span so the button's gap never parts them. */}
          <Button size="sm" icon="turnLeft" disabled={!turns} aria-describedby={described(leftId)} aria-keyshortcuts={leftKey?.aria} onClick={() => choice.turn(-1)} style={TURN_BUTTON}>
            <span>
              {TURN_LEFT}
              <span aria-hidden>{keySuffix(leftKey)}</span>
            </span>
          </Button>
          <Button size="sm" icon="turnRight" disabled={!turns} aria-describedby={described(rightId)} aria-keyshortcuts={rightKey?.aria} onClick={() => choice.turn(1)} style={TURN_BUTTON}>
            <span>
              {TURN_RIGHT}
              <span aria-hidden>{keySuffix(rightKey)}</span>
            </span>
          </Button>
          <span id={leftId} style={VISUALLY_HIDDEN}>
            {TURN_LEFT_DESCRIPTION}
          </span>
          <span id={rightId} style={VISUALLY_HIDDEN}>
            {TURN_RIGHT_DESCRIPTION}
          </span>
        </div>
      ) : null}
      {props.steadyTurns ? (
        // Every reason in one cell, the one that applies shown: the place is as tall as the tallest.
        <div style={{ display: "grid" }}>
          {turnsReasons(choice.forcedBy).map((line) =>
            line === reason ? (
              <Help key={line} id={reasonId} style={STACKED}>
                {line}
              </Help>
            ) : (
              <div key={line} aria-hidden="true" style={{ ...STACKED, visibility: "hidden" }}>
                <Help>{line}</Help>
              </div>
            ),
          )}
        </div>
      ) : null}
      <ViewVoice />
    </div>
  );
}

/**
 * The View menu as a bottom sheet, a centered card from 600 px up: the
 * phone's View button opens it, and the room's menu's View row where the
 * narrowest phone's bar folded the button away.
 */
export function ViewSheetDialog(props: { choice: ViewChoiceState; opener?: RefObject<HTMLElement | null>; onClose(): void }) {
  return (
    <SheetDialog title={VIEW_GROUP} opener={props.opener} onClose={props.onClose} width={theme.layout.dialog.sm}>
      <ViewMenuBody choice={props.choice} />
    </SheetDialog>
  );
}

/** The help under Follow the scene, on the View menu and the display's. Its words are only here, and e2e/iso.e2e.ts reads them as drawn. */
export function SuggestionHelp(props: { suggested: Scene["suggestedView"] }) {
  return (
    <>
      This scene suggests <ViewName kind={suggestedKind(props.suggested)} />.
    </>
  );
}

/** A view's name in running words, kept on one line: at 320 px and 130% "Top-down" broke at its hyphen (ISO5-OPUS-5). */
export function ViewName(props: { kind: ViewKind }) {
  return (
    <span data-view-name="" style={{ whiteSpace: "nowrap" }}>
      {VIEW_NAMES[props.kind]}
    </span>
  );
}

/** A row the whole of its 44 px, as components/Segmented.tsx builds its options: a tap anywhere on it hits the radio. Its words wrap rather than cut at a large interface size. */
const ROW: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  minHeight: theme.touch,
  padding: `${theme.space(1)}px ${theme.space(3)}px`,
  boxSizing: "border-box",
  borderRadius: theme.radius.md,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  lineHeight: theme.leading.tight,
  whiteSpace: "normal",
  overflowWrap: "break-word",
  cursor: "pointer",
};

const RADIO_COVER: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" };

const STACKED: CSSProperties = { gridArea: "1 / 1", minWidth: 0 };

/** The two share their line, and stack where one line cannot hold both. */
const TURN_BUTTON: CSSProperties = { flex: "1 1 auto" };
