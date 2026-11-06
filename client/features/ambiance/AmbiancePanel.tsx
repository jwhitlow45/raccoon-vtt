import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { Empty } from "../../components/Empty.tsx";
import { Group } from "../../components/Panel.tsx";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { START_DRAFT, type StartDraft } from "../clock/StartClock.tsx";
import { NO_OTHER_AMOUNT, type OtherAmount } from "../clock/StepButtons.tsx";
import { TimeSection } from "../clock/TimePanel.tsx";
import { PanelGuideLink } from "../guide/GuideLink.tsx";
import type { PanelProps } from "../panels.ts";
import { PlayerSound } from "../sound/panel/PlayerSound.tsx";
import { DmSoundSection, useDmSoundPages } from "../sound/panel/SoundPanel.tsx";
import { somethingPlays } from "../sound/panel/state.ts";
import { ambianceKeptSlot, shownSections } from "./kept.ts";
import { useAmbianceRoot } from "./request.ts";
import { AMBIANCE_GUIDES, AMBIANCE_TITLE, EMPTY_LINE, SOUND_GROUP, TIME_GROUP } from "./words.ts";

/**
 * Ambiance (docs/design/design-v1-panel-groups.md 4 and 5): the room's live
 * time and sound in one panel, in place of the Time and Sound panels. The
 * DM's holds both. A player's holds Time and Sound only while each has
 * something to say, or was shown
 * since Ambiance opened (kept.ts), with no folds. Nothing here reads more
 * than the player's projection already holds.
 */
export default function AmbiancePanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  // A request blurs a field typed in here before it leaves a Sound subpage (request.ts openAmbiance).
  const root = useAmbianceRoot();
  if (role !== "dm" && role !== "player") return null;
  return (
    <div ref={root} style={{ display: "grid", minWidth: 0 }}>
      {role === "dm" ? <DmAmbiance /> : <PlayerAmbiance />}
    </div>
  );
}

function DmAmbiance() {
  const pages = useDmSoundPages(AMBIANCE_TITLE);
  // Kept here, above the Sound subpages that replace the whole first page, so Back finds them as they were (D-261102-763).
  const [amount, setAmount] = useState<OtherAmount>(NO_OTHER_AMOUNT);
  const [draft, setDraft] = useState<StartDraft>(START_DRAFT);
  const clockId = useRoomView((s) => s.view?.clock?.id ?? null);
  // A clock started, here or on another device, used the form up: the next start begins afresh, as a remounted form did.
  useEffect(() => {
    if (clockId !== null) setDraft(START_DRAFT);
  }, [clockId]);

  if (pages.subpage) return pages.subpage;
  return (
    <>
      <Group label={TIME_GROUP} icon="time" divider={false}>
        <TimeSection kept={{ amount, onAmount: setAmount, draft, onDraft: setDraft }} />
        <PanelGuideLink section={AMBIANCE_GUIDES.time} panel={TIME_GROUP} />
      </Group>
      <Group label={SOUND_GROUP} icon="music">
        <DmSoundSection {...pages.first} />
        <PanelGuideLink section={AMBIANCE_GUIDES.sound} panel={SOUND_GROUP} />
      </Group>
    </>
  );
}

function PlayerAmbiance() {
  const kept = useStore(useScoped(ambianceKeptSlot));
  const clock = useRoomView((s) => !!s.view?.clock);
  const sound = useRoomView((s) => somethingPlays(s.view?.playing));
  const shown = shownSections(kept, { clock, sound });
  if (!shown.time && !shown.sound) return <Empty>{EMPTY_LINE}</Empty>;
  // No folds for a player (5): two short sections read at a glance, each a group with its icon and name and no chevron.
  const groups: ReactNode[] = [];
  if (shown.time)
    groups.push(
      <Group key="time" label={TIME_GROUP} icon="time" divider={false}>
        <TimeSection />
      </Group>,
    );
  if (shown.sound)
    groups.push(
      <Group key="sound" label={SOUND_GROUP} icon="music" holds="sections" divider={shown.time}>
        <PlayerSound />
      </Group>,
    );
  return <>{groups}</>;
}
