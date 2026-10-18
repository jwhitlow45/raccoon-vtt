import { useMemo } from "react";
import type { LightLevel, Scene } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import type { OpOf } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { useDelayed } from "../../components/Loading.tsx";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { Switch } from "../../components/Switch.tsx";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { Select } from "../scenes/controls.tsx";
import { lightText } from "./presets.ts";
import { sensesShort } from "./senses.ts";
import { carriedLightsNote, fogNote, LIGHT_LEVELS, lightOf, lightPatch, phaseWithLight, visionPatch } from "./settings.ts";
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
 */
export function VisionSettings(props: { scene: Scene }) {
  const { scene } = props;
  const actions = useRoomActions();
  const update = (patch: OpOf<"scene.update">["patch"]) => actions.dispatch({ t: "scene.update", sceneId: scene.id, patch });
  const on = scene.vision?.on === true;
  const light = lightOf(scene);
  const working = useRoomView((s) => s.pending.some((p) => p.op.t === "scene.update" && p.op.sceneId === scene.id && p.op.patch.vision !== undefined));
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
            ? "On: players see only what their characters see, by their own senses and the light around them."
            : "Off: players see everything you reveal. Turn it on for dynamic lighting: players see what their characters see, and remember what they explored. It turns fog on too."
        }
        checked={on}
        busy={showWorking}
        onChange={(next) => update({ vision: visionPatch(scene, next) })}
      />
      {showWorking ? <Help>Working out what the party sees…</Help> : null}
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

      {on ? <Sources sceneId={scene.id} /> : null}
    </Section>
  );
}

/** The party creatures on the scene, what each sees and carries, and whether it lends sight. */
function Sources(props: { sceneId: string }) {
  const report = usePartyReport(props.sceneId, true);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const lending = report.rows.filter((r) => r.lends).length;
  return (
    <SettingRow name="Who lends the party sight" wide>
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
                  {noSightText(row)}
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
