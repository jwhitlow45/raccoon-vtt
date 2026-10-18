import { useMemo, useState } from "react";
import type { LogNames } from "#shared/logText.ts";
import { usePanelHere, type PanelProps } from "../panels.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomUi, useRoomView } from "../../state/view.ts";
import { RecentRolls } from "./RecentRolls.tsx";
import { RollOptions } from "./RollOptions.tsx";
import { LastResult, Roller } from "./Roller.tsx";
import { useDicePanel } from "./useDicePanel.ts";
import { GroupSave, OpenGroupSave, useRestoreGroupSave } from "./groupSave/GroupSave.tsx";
import { useGroupSave, useGroupSaveStore } from "./groupSave/store.ts";

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
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <GroupSave parent="Dice" onBack={() => groupStore.setState({ shownIn: null })} />
      </div>
    );
  }
  return (
    // One column no wider than the pane: an auto column grows to its widest row's content, so one long roll would widen the whole panel past the screen.
    // A plain box, as above: the sheet or the tab names the panel.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
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
      <RecentRolls names={names} me={me} open={open} again={(rolls, to) => void panel.again(rolls, to)} />
    </div>
  );
}
