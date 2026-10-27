import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { LightLevel, Scene } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import type { OpOf } from "#shared/protocol.ts";
import { sceneWalls } from "#shared/rules/walls.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Spinner, useDelayed } from "../../components/Loading.tsx";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { RowChevron } from "../../components/Row.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { Switch } from "../../components/Switch.tsx";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { Select } from "../scenes/controls.tsx";
import { HOLDERS_UNDER, holderRows, holdersAfter, lendsText, sharedOnlyText, unsharedMounts, untickQuestion } from "./holders.ts";
import { AskFirst, PlayersSeeChoice, useAsk, WarningStatus } from "./PlayersSee.tsx";
import { CUSTOM_TEXT, exploredHere, holdersExploredHere, leaveQuestion, playersSeeOf, presetPatch, sightQuestion, walllessImage, WALLLESS_TEXT, type PlayersSee } from "./playersSeeRules.ts";
import { lightText } from "./presets.ts";
import { sensesShort } from "./senses.ts";
import {
  carriedLightsNote,
  fogNote,
  LIGHT_LEVELS,
  lightOf,
  lightPatch,
  phaseWithLight,
  SIGHT_CHOICES,
  sightOf,
  sightPatch,
  sightShown,
  sightWorkingText,
  visionOnHelp,
  visionPatch,
  visionPending,
  type SightChoice,
} from "./settings.ts";
import { noSightText } from "./sources.ts";
import { usePartyReport } from "./usePartyReport.ts";

const PHASE_LIGHTS: readonly { value: LightLevel | "keep"; label: string }[] = [
  { value: "keep", label: "Leave the light" },
  ...LIGHT_LEVELS.map((l) => ({ value: l.value, label: l.label })),
];

type Patch = OpOf<"scene.update">["patch"];

/**
 * What players see of a scene, in its settings (docs/design-v1-map-discovery.md
 * 8.1 and 8.4, docs/design-v1-maps-vision.md 4.3.1): Players see first,
 * then the light level, the light each map phase brings, Sight, who sees
 * for themselves, and every party creature on the scene with its senses,
 * its light and whether it lends sight, so the DM sees what owners set.
 * The two switches a preset sets, Fog and Party vision, sit in a fold
 * after them, open while they make Custom.
 *
 * A change that leaves Explore where players explored, from the preset or
 * the switches, asks first, since players' remembered map goes with it.
 * Turning vision on makes the server work out what the party sees, which
 * can take a moment on a large scene, so Players see shows it is busy and
 * says so while the op is on its way.
 *
 * The Sight row makes the scene per player and back
 * (docs/design-v1-per-player-vision.md 7.1), and on a per-player scene
 * the list of who sees for themselves follows it. Each waits only on its
 * own changes.
 */
export function VisionSettings(props: { scene: Scene }) {
  const { scene } = props;
  const actions = useRoomActions();
  const update = (patch: Patch) => actions.dispatch({ t: "scene.update", sceneId: scene.id, patch });
  const on = scene.vision?.on === true;
  const light = lightOf(scene);
  const working = useRoomView((s) => visionPending(s.pending, scene.id).vision);
  const sightWorking = useRoomView((s) => visionPending(s.pending, scene.id).sight);
  const perPlayer = scene.vision?.perPlayer === true;
  const showWorking = useDelayed(working);
  const phases = scene.phases && scene.phases.length >= 2 ? scene.phases : null;
  const tokens = useRoomView((s) => (on && light !== "bright" ? s.view?.tokens : undefined));
  const unlit = useMemo(() => (tokens ? carriedLightsNote(tokens, scene.id, light) : null), [tokens, scene.id, light]);
  const choice = playersSeeOf(scene);
  const explored = useRoomView((s) => (s.view ? exploredHere(s.view, scene.id) : false));
  // Only an Explore scene with a map image needs its walls counted, for the warning.
  const chunks = useRoomView((s) => (choice === "explore" && scene.map ? s.view?.buildChunks : undefined));
  const wallless = useMemo(() => (chunks ? walllessImage(scene, sceneWalls(scene, chunks).sightPotential) : false), [chunks, scene]);
  const ask = useAsk<{ where: "preset" | "fold"; patch: Patch }>();
  const fold = useFold(choice === "custom");

  /** Sends a change of Players see or of its switches, asking first where it forgets what players remember. */
  const change = (where: "preset" | "fold", to: PlayersSee, patch: Patch) => {
    const question = leaveQuestion(choice, to, explored);
    if (question) {
      ask.ask(question, { where, patch });
      return;
    }
    if (ask.asking) ask.cancel();
    update(patch);
  };
  const confirm = () => {
    const held = ask.answer();
    if (held) update(held.patch);
  };
  const question = (where: "preset" | "fold") => (
    <AskFirst question={ask.asking?.change.where === where ? ask.asking.text : null} label="Change what players see?" busy={working} onCancel={ask.cancel} onConfirm={confirm} />
  );

  return (
    <Section label="What players see">
      <div onKeyDown={ask.asking?.change.where === "preset" ? ask.onKeyDown : undefined} style={{ display: "grid", minWidth: 0 }}>
        <PlayersSeeChoice
          value={choice === "custom" ? null : choice}
          none={CUSTOM_TEXT}
          busy={working}
          working={showWorking ? sightWorkingText(perPlayer) : null}
          onChange={(preset) => {
            if (preset === "like" || preset === choice) return;
            change("preset", preset, presetPatch(scene, preset));
          }}
        />
        <WarningStatus text={wallless ? WALLLESS_TEXT : null} />
        {question("preset")}
      </div>

      <SettingRow name="Light" help={LIGHT_LEVELS.find((l) => l.value === light)?.note} wide>
        <Segmented<LightLevel> label="Light level" value={light} options={LIGHT_LEVELS} onChange={(level) => update({ vision: lightPatch(scene, level) })} />
      </SettingRow>
      {unlit ? <Note>{unlit}</Note> : null}

      {phases ? (
        <SettingRow name="Light with each map phase" help="A phase's light becomes the scene's light when the map switches to it, and at once for the phase showing now, so Night can make the scene dark." wide>
          <div style={{ display: "grid", gap: theme.space(1), width: "100%", minWidth: 0 }}>
            {phases.map((phase) => (
              <div key={phase.id} style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0 }}>
                <span title={phase.name} style={{ flex: 1, minWidth: 0, fontSize: theme.font.body14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {phase.name}
                </span>
                <Select<LightLevel | "keep">
                  label={`Light with ${phase.name}`}
                  value={phase.light ?? "keep"}
                  options={PHASE_LIGHTS}
                  onChange={(v) => {
                    const list = phaseWithLight(scene.phases, phase.id, v === "keep" ? null : v);
                    if (list) update({ phases: list });
                  }}
                />
              </div>
            ))}
          </div>
        </SettingRow>
      ) : null}

      {sightShown(scene) ? <SightRow scene={scene} working={sightWorking} /> : null}
      {perPlayer ? <HolderList sceneId={scene.id} busy={sightWorking !== null} /> : null}
      {on ? <Sources sceneId={scene.id} perPlayer={perPlayer} /> : null}
      {perPlayer ? <MountNotes sceneId={scene.id} /> : null}

      <Fold
        label="Fog and party vision"
        open={fold.open}
        onToggle={() => {
          if (ask.asking?.change.where === "fold") ask.cancel();
          fold.toggle();
        }}
      >
        <div onKeyDown={ask.asking?.change.where === "fold" ? ask.onKeyDown : undefined} style={{ display: "grid", minWidth: 0 }}>
          <Switch
            label="Fog"
            help={scene.fogEnabled ? "Players see only what you reveal. Use the fog tool to reveal." : "Players see the whole scene."}
            checked={scene.fogEnabled}
            onChange={(fogEnabled) => change("fold", playersSeeOf({ fogEnabled, vision: scene.vision }), { fogEnabled })}
          />
          <Switch
            label="Party vision"
            help={
              on
                ? visionOnHelp(scene)
                : "Off: players see everything you reveal. Turn it on for dynamic lighting: players see what their characters see, and remember what they explored. It turns fog on too."
            }
            checked={on}
            busy={showWorking}
            // The reducer turns fog on with party vision, unless the patch says otherwise.
            onChange={(next) => change("fold", playersSeeOf({ fogEnabled: next || scene.fogEnabled, vision: { on: next, light } }), { vision: visionPatch(scene, next) })}
          />
          {on ? <FogLine scene={scene} /> : null}
          {question("fold")}
        </div>
      </Fold>
    </Section>
  );
}

/** What the switches say about the scene's fog while party vision is on, under them. */
function FogLine(props: { scene: Scene }) {
  const fog = fogNote(props.scene);
  return fog.warning ? <Note style={{ paddingBottom: theme.space(2) }}>{fog.text}</Note> : <Help style={{ paddingBottom: theme.space(2) }}>{fog.text}</Help>;
}

/**
 * The fold of Fog and Party vision (8.4): closed, since Players see sets
 * both, and open while they make Custom, the one pair no preset names, so
 * the DM sees which switch did it. The settings mount anew for each scene
 * (ScenesPanel.tsx), so each scene starts the fold again.
 */
function useFold(custom: boolean): { open: boolean; toggle(): void } {
  const [open, setOpen] = useState(custom);
  useEffect(() => {
    if (custom) setOpen(true);
  }, [custom]);
  return { open, toggle: () => setOpen((o) => !o) };
}

/** A disclosure named by its label alone, which takes focus as it folds so nothing under it keeps focus as it goes. */
function Fold(props: { label: string; open: boolean; onToggle(): void; children: ReactNode }) {
  return (
    <div style={{ display: "grid", minWidth: 0 }}>
      <button
        type="button"
        aria-expanded={props.open}
        onClick={(e) => {
          e.currentTarget.focus();
          props.onToggle();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: theme.space(2),
          width: "100%",
          minHeight: theme.touch,
          padding: 0,
          background: "transparent",
          border: "none",
          color: theme.color.text,
          fontFamily: theme.font.body,
          fontSize: theme.font.input,
          fontWeight: theme.weight.strong,
          lineHeight: theme.leading.tight,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{props.label}</span>
        <RowChevron open={props.open} />
      </button>
      {props.open ? props.children : null}
    </div>
  );
}

/**
 * Sight: Whole party or Per player (7.1), a radio group named by the row
 * and described by the chosen option's help. While its change or the
 * list's is on the way it refuses another, and after the shared delay
 * its help says what the server is working out, as a polite status, so
 * focus stays on the option through it all. Whole party asks first while
 * players hold maps of their own here, since they join the party's for
 * good (docs/design-v1-map-discovery.md 8.1).
 */
function SightRow(props: { scene: Scene; working: SightChoice | null }) {
  const { scene, working } = props;
  const actions = useRoomActions();
  const showWorking = useDelayed(working !== null);
  const choice = sightOf(scene);
  const help = SIGHT_CHOICES.find((c) => c.value === choice)?.help;
  const holdersExplored = useRoomView((s) => (s.view ? holdersExploredHere(s.view, scene.id) : false));
  const ask = useAsk<boolean>();
  const send = (perPlayer: boolean) => actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { vision: sightPatch(scene, perPlayer) } });
  return (
    // The row's box, which the alignment sweep measures (e2e/alignmentRoom.ts).
    <div data-vision-sight onKeyDown={ask.asking ? ask.onKeyDown : undefined}>
      <SettingRow name="Sight" wide>
        {(ids) => (
          <div aria-busy={working !== null ? true : undefined} style={{ width: "100%", minWidth: 0 }}>
            <Segmented<SightChoice>
              labelledBy={ids.nameId}
              value={choice}
              options={SIGHT_CHOICES}
              onChange={(next) => {
                if (working !== null || next === choice) return;
                const question = sightQuestion(scene, next === "player", holdersExplored);
                if (question) ask.ask(question, next === "player");
                else send(next === "player");
              }}
              description={
                <span role="status">
                  {showWorking && working !== null ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1) }}>
                      <Spinner size={theme.icon.sm} />
                      {sightWorkingText(working === "player")}
                    </span>
                  ) : (
                    help
                  )}
                </span>
              }
            />
          </div>
        )}
      </SettingRow>
      <AskFirst
        question={ask.asking?.text ?? null}
        label="Change Sight?"
        busy={working !== null}
        onCancel={ask.cancel}
        onConfirm={() => {
          const perPlayer = ask.answer();
          if (perPlayer !== null) send(perPlayer);
        }}
      />
    </div>
  );
}

/**
 * Who sees for themselves (7.1): every player of the roster, ticked while
 * they see and remember for themselves here. A seventh tick is refused on
 * the device with the server's words, and an untick asks once, since that
 * player forgets their map of the scene. Focus stays on the box through a
 * change, its wait and the question, and the question gives it back.
 */
function HolderList(props: { sceneId: string; busy: boolean }) {
  const { sceneId, busy } = props;
  const actions = useRoomActions();
  const members = useRoomView((s) => s.view?.members);
  const holders = useRoomView((s) => s.view?.holders);
  const rows = useMemo(() => holderRows({ members: members ?? {}, holders: holders ?? {} }, sceneId), [members, holders, sceneId]);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const boxes = useRef(new Map<string, HTMLInputElement>());
  const nameId = useId();
  const underId = useId();
  const send = (on: string[]) => {
    setRefusal(null);
    actions.dispatch({ t: "vision.holders", sceneId, on });
  };
  const backTo = (memberId: string) => {
    setAsking(null);
    boxes.current.get(memberId)?.focus();
  };
  // Escape answers the question no wherever focus is in its row, the box included, where focus stays as it opens.
  const escapeFrom = (memberId: string) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    backTo(memberId);
  };
  const change = (memberId: string, tick: boolean) => {
    if (busy) return;
    if (!tick) {
      setRefusal(null);
      setAsking(memberId);
      return;
    }
    setAsking(null);
    const next = holdersAfter(rows, memberId, true);
    if ("refused" in next) setRefusal(next.refused);
    else send(next.on);
  };
  return (
    <div
      role="group"
      aria-labelledby={nameId}
      aria-describedby={underId}
      aria-busy={busy ? true : undefined}
      style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(2)}px 0`, minWidth: 0 }}
    >
      <span id={nameId} style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight }}>
        Who sees for themselves
      </span>
      <div style={{ display: "grid", minWidth: 0 }}>
        {rows.map((row) => (
          <div key={row.memberId} onKeyDown={asking === row.memberId ? escapeFrom(row.memberId) : undefined} style={{ display: "grid", minWidth: 0 }}>
            <Checkbox
              ref={(el) => {
                if (el) boxes.current.set(row.memberId, el);
                else boxes.current.delete(row.memberId);
              }}
              label={<span style={{ overflowWrap: "anywhere" }}>{row.name}</span>}
              help={!row.on && row.listed ? sharedOnlyText(row.name) : undefined}
              checked={row.on}
              onChange={(tick) => change(row.memberId, tick)}
            />
            <UntickQuestion
              open={asking === row.memberId}
              name={row.name}
              busy={busy}
              onCancel={() => backTo(row.memberId)}
              onConfirm={() => {
                const next = holdersAfter(rows, row.memberId, false);
                if ("on" in next) send(next.on);
                backTo(row.memberId);
              }}
            />
          </div>
        ))}
      </div>
      <div role="status">{refusal ? <Note>{refusal}</Note> : null}</div>
      <Help id={underId}>{HOLDERS_UNDER}</Help>
    </div>
  );
}

/**
 * The question an untick asks, under its box. Its words go in a status
 * that stays mounted, empty while nothing is asked, so a screen reader
 * hears them as they come. Escape answers no (HolderList's row). While
 * another change is on its way, Untick waits.
 */
function UntickQuestion(props: { open: boolean; name: string; busy: boolean; onCancel(): void; onConfirm(): void }) {
  const { open } = props;
  return (
    <div
      role={open ? "group" : undefined}
      aria-label={open ? `Untick ${props.name}?` : undefined}
      style={
        open
          ? {
              display: "grid",
              gap: theme.space(2),
              padding: theme.space(3),
              margin: `${theme.space(1)}px 0`,
              borderRadius: theme.radius.md,
              border: `${theme.line.border}px solid ${theme.color.border}`,
              background: theme.color.bg,
              minWidth: 0,
            }
          : undefined
      }
    >
      <p role="status" style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
        {open ? untickQuestion(props.name) : null}
      </p>
      {open ? (
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" busy={props.busy} onClick={props.onConfirm}>
            Untick
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Riders whose controlled mount not every player sees, so they share no turn (7.1), each with what keeps it. */
function MountNotes(props: { sceneId: string }) {
  const view = useRoomView((s) => s.view);
  const notes = useMemo(() => (view ? unsharedMounts(view, props.sceneId) : []), [view, props.sceneId]);
  if (notes.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), paddingBottom: theme.space(2) }}>
      {notes.map((text) => (
        <Note key={text}>{text}</Note>
      ))}
    </div>
  );
}

/**
 * The party creatures on the scene, what each sees and carries, and whether it lends sight. On a per-player
 * scene each lending row says to whom (7.1).
 */
function Sources(props: { sceneId: string; perPlayer: boolean }) {
  const report = usePartyReport(props.sceneId, true);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const members = useRoomView((s) => (props.perPlayer ? s.view?.members : undefined));
  const holders = useRoomView((s) => (props.perPlayer ? s.view?.holders : undefined));
  const characters = useRoomView((s) => (props.perPlayer ? s.view?.characters : undefined));
  // The DM's view holds every owner and the scene's list, all lendsText reads.
  const owners = useMemo(() => (members ? { members, holders: holders ?? {}, characters: characters ?? {} } : null), [members, holders, characters]);
  const lending = report.rows.filter((r) => r.lends).length;
  return (
    <SettingRow name={props.perPlayer ? "Who lends sight" : "Who lends the party sight"} wide>
      <div style={{ display: "grid", gap: theme.space(2), width: "100%", minWidth: 0 }}>
        {report.rows.length === 0 ? (
          <Note>No party creature is on this scene. Players see only what they explored before.</Note>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
            {report.rows.map((row, i) => (
              <li
                key={row.token.id}
                style={{
                  display: "grid",
                  gap: theme.space(0.5),
                  padding: `${theme.space(2)}px 0`,
                  borderTop: i === 0 ? undefined : `${theme.line.border}px solid ${theme.color.border}`,
                  fontSize: theme.font.small,
                  lineHeight: theme.leading.body,
                }}
              >
                <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{displayName(row.token)}</span>
                <span style={{ color: theme.color.textMuted }}>
                  Senses: {sensesShort(row.senses, feetPerCell)}. Light: {row.light ? lightText(row.light, feetPerCell) : "none"}.
                </span>
                <span style={{ color: row.lends ? theme.color.textMuted : theme.color.warning }}>
                  {row.lends && owners ? lendsText(owners, props.sceneId, row.token) : noSightText(row)}
                  {row.lends && row.blinded ? ". Blinded: Blindsight only" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {report.rows.length > 0 && lending === 0 ? <Note>No party creature here lends sight, so players see only what they explored before.</Note> : null}
        {report.overCap > 0 ? (
          <Note>
            {report.overCap} {report.overCap === 1 ? "creature lends" : "creatures lend"} no sight: at most {LIMITS.partySourcesPerScene} do. They stay on players' maps.
          </Note>
        ) : null}
      </div>
    </SettingRow>
  );
}
