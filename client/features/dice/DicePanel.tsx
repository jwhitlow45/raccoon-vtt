import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import type { LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { usePanelHere, type PanelProps } from "../panels.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { RecentRolls } from "./RecentRolls.tsx";
import { RollOptions } from "./RollOptions.tsx";
import { LastResult, Roller } from "./Roller.tsx";
import { useDicePanel } from "./useDicePanel.ts";
import { GroupSave, OpenGroupSave, useRestoreGroupSave } from "./groupSave/GroupSave.tsx";
import { useGroupSave, useGroupSaveStore } from "./groupSave/store.ts";
import { recentRolls } from "./logic.ts";
import { kindsIn } from "./throw/layout.ts";
import type { ThrowStore } from "./throw/store.ts";
import { useThrows } from "./throw/useThrows.ts";

/** The control a pointer or key went to, which a roll from it throws its dice from. */
function controlOf(e: SyntheticEvent): Element | null {
  const target = e.target instanceof Element ? e.target : null;
  return target?.closest("button, input, [role='button']") ?? target;
}

/** The dice of the newest rolls in Recent rolls, whose kinds the warm-up draws first. */
function recentKinds(log: readonly LogEntry[]) {
  return kindsIn(recentRolls(log).slice(0, 8).flatMap((row) => (row.kind === "dice" ? row.rolls : row.kind === "answer" && row.line.dice ? [row.line.dice] : [])));
}

/**
 * The panel's part in a throw (docs/design-v1-roll-animation.md 3.5): it
 * is mounted, and any tap or key in it, or a change of its pane's size,
 * ends the throw. The listeners are on the capture phase and never stop
 * or prevent the event, so the tap or key still does its own job.
 */
function useThrowPanel(throws: ThrowStore) {
  const root = useRef<HTMLDivElement>(null);
  const log = useRoomView((s) => s.view?.log);
  const logRef = useRef(log);
  logRef.current = log;
  useEffect(() => throws.mount({ kinds: () => recentKinds(logRef.current ?? []) }), [throws]);
  useEffect(() => {
    const pane = root.current?.closest("[data-pane-body]");
    if (!pane || typeof ResizeObserver === "undefined") return;
    let first = true;
    const observer = new ResizeObserver(() => {
      // An observer reports once as it starts, which is no change.
      if (first) first = false;
      else throws.resized();
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, [throws]);
  return {
    ref: root,
    onPointerDownCapture: (e: SyntheticEvent) => throws.pointerDown(controlOf(e)),
    onPointerUpCapture: () => throws.pointerUp(),
    onPointerCancelCapture: () => throws.pointerCancel(),
    onClickCapture: () => throws.click(),
    onKeyDownCapture: (e: SyntheticEvent) => throws.keyDown(controlOf(e)),
  };
}

/**
 * The Dice panel (docs/design-v1-dice.md 8), for everyone: the newest
 * panel roll stuck at the top, the formula field with its quick dice and
 * one-roll choices, a creature's roll options, then Recent rolls. Every
 * roll happens on the server, so the panel only sends and shows.
 */
export default function DicePanel(props: PanelProps) {
  const members = useRoomView((s) => s.view?.members);
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const handouts = useRoomView((s) => s.view?.handouts);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const me = useRoomView((s) => s.you?.memberId ?? "");
  const names = useMemo<LogNames>(() => ({ members: members ?? {}, tokens: tokens ?? {}, characters: characters ?? {}, handouts: handouts ?? {}, encounter }), [members, tokens, characters, handouts, encounter]);
  const panel = useDicePanel();
  const ui = useRoomUi();
  const here = usePanelHere();
  const role = useRoomView((s) => s.you?.role ?? null);
  const groupStore = useGroupSaveStore();
  const group = useGroupSave((s) => s.page);
  const groupShown = useGroupSave((s) => s.shownIn === "dice");
  const throwPanel = useThrowPanel(useThrows());
  useRestoreGroupSave();
  // The line a tap on the sticky result opened, unfolded in Recent rolls and scrolled into view.
  const [open, setOpen] = useState<string | null>(null);
  const show = (lineId: string) => {
    setOpen(lineId);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-roll-row~="${CSS.escape(lineId)}"]`);
      row?.scrollIntoView({ block: "nearest" });
    });
  };
  if (groupShown && group) {
    return (
      // The page shows its own results, and its rolls never become the panel's last roll, so the sticky line would only take room.
      // A plain box: the sheet or the tab around it already names the panel "Dice", and a second region of that name is heard twice.
      <div {...throwPanel} style={{ display: "grid", gap: theme.space(2) }}>
        <GroupSave parent="Dice" onBack={() => groupStore.setState({ shownIn: null })} />
      </div>
    );
  }
  return (
    // One column no wider than the pane: an auto column grows to its widest row's content, so one long roll would widen the whole panel past the screen.
    // A plain box, as above: the sheet or the tab names the panel.
    <div {...throwPanel} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <LastResult onOpen={show} />
      <Roller />
      {group && role === "dm" ? (
        <OpenGroupSave
          page={group}
          onOpen={() => {
            // An area's page reads its creatures from the area, which the Areas panel holds. With two panels it opens beside this one (docs/design-v1-split-panel.md 5.1).
            const panel = group.source.kind === "area" ? "areas" : "dice";
            groupStore.setState({ shownIn: panel });
            if (panel === "areas") ui.openPanel("areas", here ? { from: here } : undefined);
          }}
        />
      ) : null}
      <RollOptions {...props} />
      <RecentRolls names={names} me={me} open={open} again={(rolls, to, origin) => void panel.again(rolls, to, origin)} />
    </div>
  );
}
