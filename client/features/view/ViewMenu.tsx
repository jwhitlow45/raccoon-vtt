import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { Scene } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { turned, type View, type ViewKind } from "../../lib/view.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import {
  choiceOf,
  choiceWords,
  isoOffered,
  pickOf,
  sayView,
  suggestionHelp,
  topDownLine,
  topDownTool,
  TURN_LEFT,
  TURN_LEFT_LABEL,
  TURN_RIGHT,
  TURN_RIGHT_LABEL,
  VIEW_CHOICES,
  VIEW_GROUP,
  viewGestureSlot,
  viewSaid,
  viewVoiceSlot,
  wantedKind,
  type ViewState,
} from "./choice.ts";
import { pickView, settledView, shownView, turnView, useStoredView, viewKey, type StoredView } from "./store.ts";

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
};

/**
 * A page's view from where its pick is kept: the pick, else the scene's
 * suggestion, at the scene's turn, Top-down while Isometric is not offered
 * or a tool shows Top-down (store.ts shownView). A change waits for a
 * gesture under way to end (settledView), so the map never turns under a
 * finger.
 */
export function useViewChoice(input: { key: string; sceneId: string | null; suggested: Scene["suggestedView"]; tool?: string | null; gesture?: boolean }): ViewChoiceState {
  const stored = useStoredView(input.key);
  const forcedBy = topDownTool(input.tool);
  const target = shownView({ stored, sceneId: input.sceneId ?? "", suggested: input.suggested, forcedTopDown: forcedBy !== null, ready: isoOffered });
  const [showing, setShowing] = useState(target);
  // Views are kept one object each (lib/view.ts isometric), so the same view is the same object.
  const shown = settledView(showing, target, input.gesture === true);
  if (shown !== showing) setShowing(shown);
  return { key: input.key, sceneId: input.sceneId, suggested: input.suggested, stored, forcedBy, wanted: wantedKind(stored, input.suggested), shown };
}

/** The Room page's view: this device's pick in this room, the scene on screen, the tool in use and the board's gestures. */
export function useRoomViewChoice(): ViewChoiceState {
  const roomId = useRoomView((s) => s.roomId);
  const sceneId = useRoomView((s) => s.sceneId);
  const suggested = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId]?.suggestedView : undefined));
  const tool = useRoomView((s) => s.local.tool);
  const gesture = useStore(useScoped(viewGestureSlot), (g) => g.active);
  return useViewChoice({ key: viewKey(roomId), sceneId, suggested, tool, gesture });
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
 * pick keeps the menu open, so Isometric's turns are a tap away. A sheet
 * opened by a key puts focus on the checked radio (`keyOpen`), as the
 * popover does on its own.
 *
 * A popover keeps the size it opened with, and its content scrolls past
 * it (components/Popover.tsx), so a pick of Isometric would add the turns
 * under "Scroll for more". `reserveTurns` keeps their room, unseen, while
 * the board shows Top-down and no tool holds it there, which only a tool
 * change ends, and a tool change closes the popover.
 */
export function ViewMenuBody(props: { choice: ViewChoiceState; keyOpen?: boolean; reserveTurns?: boolean }) {
  const { choice } = props;
  const name = useId();
  const helpId = useId();
  const value = choiceOf(choice.stored.pick);
  const forced = topDownLine(choice.forcedBy);
  const turns = choice.shown.kind === "isometric";
  const turn = (by: 1 | -1) => {
    if (choice.shown.kind === "isometric" && choice.sceneId) turnView(choice.key, choice.sceneId, turned(choice.shown.turn, by));
  };
  return (
    <div data-view-menu="" style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
      <div role="radiogroup" aria-label={VIEW_GROUP} style={{ display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
        {VIEW_CHOICES.map((c) => {
          const chosen = c === value;
          return (
            <label key={c} className="rvtt-choice" style={{ ...ROW, ...buttonLook("quiet", { pressed: chosen }) }}>
              <input
                type="radio"
                name={name}
                value={c}
                checked={chosen}
                autoFocus={props.keyOpen === true && chosen}
                aria-describedby={c === "follow" ? helpId : undefined}
                onChange={() => pickView(choice.key, pickOf(c))}
                style={RADIO_COVER}
              />
              <span style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
                <span>{choiceWords(c)}</span>
                {c === "follow" ? (
                  <span id={helpId} style={{ fontSize: theme.font.small, fontWeight: theme.weight.regular, color: theme.color.textMuted, lineHeight: theme.leading.body }}>
                    {suggestionHelp(choice.suggested)}
                  </span>
                ) : null}
              </span>
              {chosen ? <Icon name="check" size="sm" style={{ flex: "none" }} /> : null}
            </label>
          );
        })}
      </div>
      {forced ? <Help>{forced}</Help> : null}
      {turns || (props.reserveTurns && !forced) ? (
        <div aria-hidden={turns ? undefined : true} inert={!turns} style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), visibility: turns ? undefined : "hidden" }}>
          <Button size="sm" icon="turnLeft" aria-label={TURN_LEFT_LABEL} onClick={() => turn(-1)} style={TURN_BUTTON}>
            {TURN_LEFT}
          </Button>
          <Button size="sm" icon="turnRight" aria-label={TURN_RIGHT_LABEL} onClick={() => turn(1)} style={TURN_BUTTON}>
            {TURN_RIGHT}
          </Button>
        </div>
      ) : null}
      <ViewVoice />
    </div>
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

/** The two share their line, and stack where one line cannot hold both. */
const TURN_BUTTON: CSSProperties = { flex: "1 1 auto" };
