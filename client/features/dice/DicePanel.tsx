import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import type { LogNames } from "#shared/logText.ts";
import type { LogEntry } from "#shared/model.ts";
import { usePanelHere, type PanelProps } from "../panels.ts";
import { scrollBox, startInScrollBox } from "../../lib/reveal.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { useDiceFolds } from "./diceFolds.ts";
import { RecentRolls } from "./RecentRolls.tsx";
import { RollOptions, useOptionsEndOnGroup } from "./RollOptions.tsx";
import { LastResult, Roller } from "./Roller.tsx";
import { useDicePanel } from "./useDicePanel.ts";
import { GroupSave, OpenGroupSave } from "./groupSave/GroupSave.tsx";
import { useRestoreGroupSave } from "./groupSave/start.ts";
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
  useEffect(() => {
    const node = root.current;
    const fromMenu = (e: Event) => throws.keyDown(e.target instanceof Element ? e.target : null);
    node?.addEventListener("rvtt-roll-mode-origin", fromMenu);
    return () => node?.removeEventListener("rvtt-roll-mode-origin", fromMenu);
  }, [throws]);
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
 * Brings a Recent rolls row into view as scrollIntoView's "nearest" would,
 * moving only the panel's own scroller, with the row's head clear of the
 * sticky line: a row above the view, or taller than the room under the
 * line, starts right under it, and one below shows its foot. The line's
 * height is measured, since at 130% it is a fraction of a pixel more than
 * any fixed margin (docs/design-v1-dice.md 8.3, LP7-DICE-5).
 */
function revealUnderLine(row: HTMLElement, line: HTMLElement | null): void {
  const node = row as unknown as Parameters<typeof scrollBox>[0];
  const box = scrollBox(node);
  if (!box) return;
  const b = box.getBoundingClientRect();
  const zoom = box.offsetHeight > 0 ? (b.bottom - b.top) / box.offsetHeight : 1;
  const r = row.getBoundingClientRect();
  // Once stuck, the line covers this much of the scroller's head: it takes back the pane's top padding.
  const covered = line ? line.getBoundingClientRect().height / zoom : 0;
  const top = (r.top - b.top) / zoom;
  const bottom = (r.bottom - b.top) / zoom;
  if (top < covered || bottom - top > box.clientHeight - covered) startInScrollBox(node, covered);
  else if (bottom > box.clientHeight) box.scrollTop += bottom - box.clientHeight;
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
  const folds = useDiceFolds();
  /*
   * A tap on the sticky line opens a folded Recent rolls for the page,
   * writing nothing (docs/design-v1-dice-pass.md 6.4), and its row comes
   * into view once it has rendered. The opening reaches the folds a render
   * later, so the scroll waits for the commit that has Recent rolls open.
   * Each tap counts anew, so a second tap after the viewer folds the list
   * again opens it and scrolls once more.
   */
  const reveal = useRef<string | null>(null);
  const [asked, setAsked] = useState(0);
  const show = (lineId: string) => {
    setOpen(lineId);
    folds.store.open("recent");
    reveal.current = lineId;
    setAsked((n) => n + 1);
  };
  const recentOpen = folds.folds.recent;
  const root = throwPanel.ref;
  useEffect(() => {
    const lineId = reveal.current;
    if (lineId === null || !recentOpen) return;
    reveal.current = null;
    const row = root.current?.querySelector<HTMLElement>(`[data-roll-row~="${CSS.escape(lineId)}"]`);
    if (row) revealUnderLine(row, root.current?.querySelector<HTMLElement>("[data-dice-last]") ?? null);
  }, [asked, recentOpen, root]);
  // Recent rolls follows the options' last group with no gap, as the groups follow each other (6.1).
  const joined = useOptionsEndOnGroup();
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
    <div {...throwPanel} data-dice-panel="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <LastResult onOpen={show} />
      <Roller />
      {/* The roller and what it rolls for part by the panel's section line, 16 px each side, the grid's gap and this margin making the 16 above (docs/design-v1-dice-pass.md 7.1). */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), marginTop: theme.space(2), paddingTop: theme.space(4), borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", marginTop: joined ? -theme.space(2) : 0 }}>
          <RecentRolls names={names} me={me} open={open} again={(rolls, to, origin) => void panel.again(rolls, to, origin)} />
        </div>
      </div>
    </div>
  );
}
