import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { Empty } from "../../components/Empty.tsx";
import { Group } from "../../components/Panel.tsx";
import { ambianceFoldsSlot, useFolds, type AmbianceSection } from "../../lib/folds.ts";
import { startInScrollBox } from "../../lib/reveal.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { useClockChipText } from "../clock/ClockChip.tsx";
import { START_DRAFT, type StartDraft } from "../clock/StartClock.tsx";
import { NO_OTHER_AMOUNT, type OtherAmount } from "../clock/StepButtons.tsx";
import { TimeSection } from "../clock/TimePanel.tsx";
import { PanelGuideLink } from "../guide/GuideLink.tsx";
import { takeOverPanelScroll, usePanelHere, type PanelProps } from "../panels.ts";
import { openSceneSettings } from "../scenes/request.ts";
import { MusicWindowHost } from "../sound/music/MusicWindowHost.tsx";
import { useTicking } from "../sound/panel/controls.tsx";
import { PlayerSound } from "../sound/panel/PlayerSound.tsx";
import { DmSoundSection, useDmSoundPages } from "../sound/panel/SoundPanel.tsx";
import { musicShown, playlistsOf, serverNow, somethingPlays, soundsOf } from "../sound/panel/state.ts";
import { weatherSummary } from "../weather/WeatherSettings.tsx";
import { ambianceKeptSlot, shownSections } from "./kept.ts";
import { ambianceRequestSlot, useAmbianceRoot } from "./request.ts";
import { AMBIANCE_GUIDES, AMBIANCE_TITLE, EMPTY_LINE, NO_SCENE, SOUND_GROUP, soundSummary, TIME_GROUP, timeSummary, WEATHER_ROW, weatherRowLabel } from "./words.ts";

/**
 * Ambiance (docs/design/design-v1-panel-groups.md 4 and 5): the room's live
 * time and sound in one panel, in place of the Time and Sound panels. The
 * DM's holds Time and Sound, groups that fold and remember (lib/folds.ts),
 * and between them a Weather row for the scene in view that opens its
 * weather in Scenes (docs/design/design-v1-scenes-reorg.md 4.2). A player's
 * holds Time and Sound only while each has something to say, or was shown
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
  const fold = useFolds(ambianceFoldsSlot);
  const pages = useDmSoundPages(AMBIANCE_TITLE);
  // Kept here, above the Sound subpages that replace the whole first page, so Back finds them as they were (D-261102-763).
  const [amount, setAmount] = useState<OtherAmount>(NO_OTHER_AMOUNT);
  const [draft, setDraft] = useState<StartDraft>(START_DRAFT);
  const clockId = useRoomView((s) => s.view?.clock?.id ?? null);
  // A clock started, here or on another device, used the form up: the next start begins afresh, as a remounted form did.
  useEffect(() => {
    if (clockId !== null) setDraft(START_DRAFT);
  }, [clockId]);
  const sections = useRef<Partial<Record<AmbianceSection, HTMLDivElement | null>>>({});
  useRequestScroll(sections, pages.subpage !== null, pages.toFirstPage);

  // First in both, so the Music window stays mounted as a subpage comes or goes under it (docs/design/design-v1-music-player.md 3.2).
  const musicWindow = <MusicWindowHost />;
  if (pages.subpage) {
    return (
      <>
        {musicWindow}
        {pages.subpage}
      </>
    );
  }
  const time = fold("time");
  const sound = fold("sound");
  return (
    <>
      {musicWindow}
      <div ref={(el) => void (sections.current.time = el)}>
        <Group label={TIME_GROUP} icon="time" {...time} keep wholeSummary summary={<TimeSummary />} divider={false}>
          <TimeSection kept={{ amount, onAmount: setAmount, draft, onDraft: setDraft }} />
          <PanelGuideLink section={AMBIANCE_GUIDES.time} panel={TIME_GROUP} />
        </Group>
      </div>
      <WeatherRow />
      <div ref={(el) => void (sections.current.sound = el)}>
        <Group label={SOUND_GROUP} icon="music" {...sound} keep wholeSummary summary={<SoundSummary />}>
          <DmSoundSection {...pages.first} />
          <PanelGuideLink section={AMBIANCE_GUIDES.sound} panel={SOUND_GROUP} />
        </Group>
      </div>
    </>
  );
}

/**
 * Acts on a request from elsewhere, the top bar's chip (request.ts, 4.3),
 * once per press, for the DM's Ambiance and a player's: a Sound subpage
 * goes back to the first page as Back does, then the asked section's
 * header goes to the top of the panel's body and counts as the viewer
 * taking the scroller, so a remembered offset never pulls it away. After
 * the commit, since the sheet or pane around the panel puts its remembered
 * offset back in its own layout effect, which runs after this one. A
 * restore still pending after that stops at the take-over, so no later try
 * is needed.
 */
function useRequestScroll(sections: { current: Partial<Record<AmbianceSection, HTMLDivElement | null>> }, onSubpage: boolean, toFirstPage: () => void): void {
  const request = useScoped(ambianceRequestSlot);
  const asked = useStore(request);
  useLayoutEffect(() => {
    const section = asked.section;
    if (section === null) return;
    if (onSubpage) {
      toFirstPage();
      return;
    }
    request.setState({ section: null });
    const bring = () => {
      const el = sections.current[section];
      if (!el?.isConnected) return;
      startInScrollBox(el, 0);
      takeOverPanelScroll(el);
    };
    queueMicrotask(bring);
  }, [asked, onSubpage, toFirstPage, request, sections]);
}

/** Time folded: the chip's text, "Hidden" while players don't see it, or "Not started". */
function TimeSummary() {
  const chip = useClockChipText();
  const shown = useRoomView((s) => s.view?.clock?.shown ?? false);
  return <>{timeSummary(chip === null ? null : { chip, shown })}</>;
}

/** Sound folded: what plays. Drawn only while folded, so it steps with the music only then. */
function SoundSummary() {
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const music = playing?.music ?? null;
  // The run line's place moves on with the track, so it is read again while the music plays.
  const t = useTicking(() => serverNow({ serverOffset }), music !== null && music.paused === undefined);
  const shown = music ? musicShown(music, sounds, playlists, t) : null;
  return <>{soundSummary(shown, playing ? Object.keys(playing.loops).length : 0)}</>;
}

/**
 * The scene's weather, one row that never folds and holds nothing
 * (docs/design/design-v1-scenes-reorg.md 4.2): a tap opens Scenes on the
 * scene in view with Light and weather revealed and the Weather select
 * focused, or with no scene in view only opens Scenes.
 */
function WeatherRow() {
  const scope = useRoomScope();
  const ui = useRoomUi();
  const store = useRoomStore();
  const here = usePanelHere();
  const name = useRoomView((s) => (s.sceneId ? (s.view?.scenes[s.sceneId]?.name ?? null) : null));
  const summary = useRoomView((s) => {
    const scene = s.sceneId ? s.view?.scenes[s.sceneId] : undefined;
    return scene ? weatherSummary(scene.weather) : null;
  });
  const label = weatherRowLabel(name !== null && summary !== null ? { name, summary } : null);
  return (
    <Group
      label={WEATHER_ROW}
      icon="weather"
      reserve="chevron"
      wholeSummary
      summary={summary ?? NO_SCENE}
      openLabel={label}
      onOpen={() => openSceneSettings(scope, ui, "weather", { from: here, room: store })}
    />
  );
}

/** A player's Ambiance has no subpages, so a request never has one to leave. */
const NO_SUBPAGE = () => {};

function PlayerAmbiance() {
  const kept = useStore(useScoped(ambianceKeptSlot));
  const clock = useRoomView((s) => !!s.view?.clock);
  const sound = useRoomView((s) => somethingPlays(s.view?.playing));
  const shown = shownSections(kept, { clock, sound });
  // The chip asks a player's Ambiance for Time too, as a DM's (4.3).
  const sections = useRef<Partial<Record<AmbianceSection, HTMLDivElement | null>>>({});
  useRequestScroll(sections, false, NO_SUBPAGE);
  if (!shown.time && !shown.sound) return <Empty>{EMPTY_LINE}</Empty>;
  // No folds for a player (5): two short sections read at a glance, each a group with its icon and name and no chevron.
  const groups: ReactNode[] = [];
  if (shown.time)
    groups.push(
      <div key="time" ref={(el) => void (sections.current.time = el)}>
        <Group label={TIME_GROUP} icon="time" divider={false}>
          <TimeSection />
        </Group>
      </div>,
    );
  if (shown.sound)
    groups.push(
      <div key="sound" ref={(el) => void (sections.current.sound = el)}>
        <Group label={SOUND_GROUP} icon="music" holds="sections" divider={shown.time}>
          <PlayerSound />
        </Group>
      </div>,
    );
  return <>{groups}</>;
}
