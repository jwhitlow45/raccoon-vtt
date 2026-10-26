import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { LightLevel, Scene } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import type { OpOf } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Spinner, useDelayed } from "../../components/Loading.tsx";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { Switch } from "../../components/Switch.tsx";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { Select } from "../scenes/controls.tsx";
import { HOLDERS_UNDER, holderRows, holdersAfter, lendsText, sharedOnlyText, unsharedMounts, untickQuestion } from "./holders.ts";
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

/**
 * A scene's Vision settings, in its settings (docs/design-v1-maps-vision.md
 * section 4.3.1): party vision on or off, the light level, the light each
 * map phase brings, and every party creature on the scene with its senses,
 * its light and whether it lends sight, so the DM sees what owners set.
 *
 * Turning vision on makes the server work out what the party sees, which
 * can take a moment on a large scene, so the switch shows it is busy and
 * says so while the op is on its way.
 *
 * Under the switch, the Sight row makes the scene per player and back
 * (docs/design-v1-per-player-vision.md 7.1), and on a per-player scene
 * the list of who sees for themselves follows it. Each waits only on its
 * own changes.
 */
export function VisionSettings(props: { scene: Scene }) {
  const { scene } = props;
  const actions = useRoomActions();
  const update = (patch: OpOf<"scene.update">["patch"]) => actions.dispatch({ t: "scene.update", sceneId: scene.id, patch });
  const on = scene.vision?.on === true;
  const light = lightOf(scene);
  const working = useRoomView((s) => visionPending(s.pending, scene.id).vision);
  const sightWorking = useRoomView((s) => visionPending(s.pending, scene.id).sight);
  const perPlayer = scene.vision?.perPlayer === true;
  const showWorking = useDelayed(working);
  const fog = fogNote(scene);
  const phases = scene.phases && scene.phases.length >= 2 ? scene.phases : null;
  const tokens = useRoomView((s) => (on && light !== "bright" ? s.view?.tokens : undefined));
  const unlit = useMemo(() => (tokens ? carriedLightsNote(tokens, scene.id, light) : null), [tokens, scene.id, light]);

  return (
    <Section label="Vision">
      <Switch
        label="Party vision"
        help={
          on
            ? visionOnHelp(scene)
            : "Off: players see everything you reveal. Turn it on for dynamic lighting: players see what their characters see, and remember what they explored. It turns fog on too."
        }
        checked={on}
        busy={showWorking}
        onChange={(next) => update({ vision: visionPatch(scene, next) })}
      />
      {showWorking ? <Help>{sightWorkingText(perPlayer)}</Help> : null}
      {sightShown(scene) ? <SightRow scene={scene} working={sightWorking} /> : null}
      {perPlayer ? <HolderList sceneId={scene.id} busy={sightWorking !== null} /> : null}
      {on ? fog.warning ? <Note>{fog.text}</Note> : <Help>{fog.text}</Help> : null}
      {on && !scene.fogEnabled ? (
        <div>
          <Button size="sm" onClick={() => update({ fogEnabled: true })}>
            Turn fog on
          </Button>
        </div>
      ) : null}

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

      {on ? <Sources sceneId={scene.id} perPlayer={perPlayer} /> : null}
      {perPlayer ? <MountNotes sceneId={scene.id} /> : null}
    </Section>
  );
}

/**
 * Sight: Whole party or Per player (7.1), a radio group named by the row
 * and described by the chosen option's help. While its change or the
 * list's is on the way it refuses another, and after the shared delay
 * its help says what the server is working out, as a polite status, so
 * focus stays on the option through it all.
 */
function SightRow(props: { scene: Scene; working: SightChoice | null }) {
  const { scene, working } = props;
  const actions = useRoomActions();
  const showWorking = useDelayed(working !== null);
  const choice = sightOf(scene);
  const help = SIGHT_CHOICES.find((c) => c.value === choice)?.help;
  return (
    // The row's box, which the alignment sweep measures (e2e/alignmentRoom.ts).
    <div data-vision-sight>
      <SettingRow name="Sight" wide>
        {(ids) => (
          <div aria-busy={working !== null ? true : undefined} style={{ width: "100%", minWidth: 0 }}>
            <Segmented<SightChoice>
              labelledBy={ids.nameId}
              value={choice}
              options={SIGHT_CHOICES}
              onChange={(next) => {
                if (working !== null || next === choice) return;
                actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { vision: sightPatch(scene, next === "player") } });
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
