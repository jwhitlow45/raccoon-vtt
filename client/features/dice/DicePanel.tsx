import { useMemo, useState } from "react";
import type { LogNames } from "#shared/logText.ts";
import type { PanelProps } from "../panels.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { RecentRolls } from "./RecentRolls.tsx";
import { RollOptions } from "./RollOptions.tsx";
import { LastResult, Roller } from "./Roller.tsx";
import { useDicePanel } from "./useDicePanel.ts";

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
  // The line a tap on the sticky result opened, unfolded in Recent rolls and scrolled into view.
  const [open, setOpen] = useState<string | null>(null);
  const show = (lineId: string) => {
    setOpen(lineId);
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-roll-row~="${CSS.escape(lineId)}"]`);
      row?.scrollIntoView({ block: "nearest" });
    });
  };
  return (
    <section aria-label="Dice" style={{ display: "grid", gap: theme.space(2) }}>
      <LastResult onOpen={show} />
      <Roller />
      <RollOptions {...props} />
      <RecentRolls names={names} me={me} open={open} again={(rolls, to) => void panel.again(rolls, to)} />
    </section>
  );
}
