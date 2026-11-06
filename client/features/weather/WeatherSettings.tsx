import { useId, useState } from "react";
import type { Scene } from "#shared/model.ts";
import { weatherHasRules, weatherRuleLines, type WeatherRuleLine } from "#shared/rules/weather.ts";
// The shared type is read here as Weather, since SceneWeather names this file's controls.
import { weatherParts, type SceneWeather as Weather, type WeatherKind } from "#shared/weather.ts";
import { choiceLook } from "../../components/looks.ts";
import { Icon } from "../../components/Icon.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SettingRow } from "../../components/SettingRow.tsx";
import { Switch } from "../../components/Switch.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { Select } from "../scenes/controls.tsx";
import {
  buildWeather,
  COMPASS,
  forcedNow,
  KIND_CHOICES,
  pickerOf,
  strengthWords,
  windHelp,
  windOffered,
  WIND_CHOICES,
  type Forced,
  type Picker,
  type WindLevel,
} from "./buildWeather.ts";

/**
 * A scene's weather, rows of Light and weather under the light with no fold
 * of their own (docs/design/design-v1-scenes-reorg.md 4.1): the kind, its
 * strength, the wind and where it blows, Weather rules on rolls, and where
 * each device decides how it shows. Every change sends one `scene.update`
 * with the whole weather, composed valid by `buildWeather`, so Undo puts the
 * old one back. Key it by the scene, so another scene starts it fresh.
 */
export function SceneWeather(props: { scene: Scene }) {
  const { scene } = props;
  const actions = useRoomActions();
  const weather = scene.weather;
  const picker = pickerOf(weather);
  // Why the last pick moved something the DM did not pick, said in the wind's help while the scene holds what that pick sent.
  const [forced, setForced] = useState<Forced | null>(null);

  const change = (pick: Partial<Picker>) => {
    const built = buildWeather(picker, pick);
    if (built.refused) return;
    setForced(built.forced === null ? null : { text: built.forced, weather: built.weather });
    actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { weather: built.weather } });
  };

  return <WeatherBody picker={picker} weather={weather} forced={forcedNow(forced, weather)} change={change} />;
}

/** The weather in a few words: "Clear", or its names such as "Heavy rain · Strong wind". The folded Light and weather group shows it (docs/design/design-v1-scenes-reorg.md 4.2). */
export function weatherSummary(weather: Weather | undefined): string {
  const parts = weatherParts(weather);
  return parts.length === 0 ? "Clear" : parts.join(" · ");
}

function WeatherBody(props: { picker: Picker; weather: Weather | undefined; forced: string | null; change(pick: Partial<Picker>): void }) {
  const { picker, weather, forced, change } = props;
  const clear = picker.kind === "clear";
  const [light, heavy] = strengthWords(picker.kind);
  const help = windHelp(picker, forced);
  const rules = weatherRuleLines(weather);
  return (
    <div style={{ display: "grid", minWidth: 0 }}>
      <SettingRow name="Weather">
        <Select<WeatherKind> label="Weather" value={picker.kind} options={KIND_CHOICES} onChange={(kind) => change({ kind })} />
      </SettingRow>
      {clear ? null : (
        <SettingRow name="Strength" wide>
          {(ids) => (
            <Segmented<"light" | "heavy">
              labelledBy={ids.nameId}
              value={picker.heavy ? "heavy" : "light"}
              options={[
                { value: "light", label: light },
                { value: "heavy", label: heavy },
              ]}
              onChange={(strength) => change({ heavy: strength === "heavy" })}
            />
          )}
        </SettingRow>
      )}
      <SettingRow name="Wind" wide help={help ? <span role="status">{help}</span> : undefined}>
        {(ids) => (
          <Segmented<WindLevel>
            labelledBy={ids.nameId}
            {...(ids.helpId ? { describedBy: ids.helpId } : {})}
            value={picker.wind}
            options={WIND_CHOICES.map((w) => ({ ...w, disabled: !windOffered(picker, w.value) }))}
            onChange={(wind) => change({ wind })}
          />
        )}
      </SettingRow>
      {picker.wind === "calm" ? null : (
        <SettingRow name="Direction" wide help="Where it blows toward, by the map's edges as Top-down shows them.">
          <Compass value={picker.toward} onChange={(toward) => change({ toward })} />
        </SettingRow>
      )}
      {/*
       * What rolls here do is the switch's help, in one sentence, and what
       * the SRD says follows it, a line per weather part at the panel's
       * width (docs/design/design-v1-polish-pass.md 3.2), so neither is said
       * twice. The lines stay with the switch off: the SRD still says them.
       * With no rule, the line says the weather is a look only.
       */}
      {weatherHasRules(weather) ? (
        <>
          <Switch label="Weather rules on rolls" help={rules.rolls} checked={picker.rules} onChange={(on) => change({ rules: on })} />
          <div style={{ display: "grid", gap: theme.space(1), paddingBottom: theme.space(2) }}>
            {rules.lines.map((line) => (
              <RuleLine key={line.name} line={line} />
            ))}
          </div>
        </>
      ) : (
        <Help style={{ paddingBottom: theme.space(2) }}>{rules.rolls}</Help>
      )}
      <Help style={{ paddingBottom: theme.space(2) }}>Players see it at once. Each device can show it still or turn it off in This device.</Help>
    </div>
  );
}

/** A weather part's rule: its name in the line's own color, as the dice sheet's reminders name each rule, then the SRD's words. Heavy fog's is a Note, its advice after them. */
function RuleLine(props: { line: WeatherRuleLine }) {
  const { line } = props;
  if (line.tone === "note") {
    return (
      <Note>
        <span style={{ fontWeight: theme.weight.strong }}>{line.name}:</span> {line.text}
        {line.advice ? ` ${line.advice}` : null}
      </Note>
    );
  }
  return (
    <Help>
      <span style={{ fontWeight: theme.weight.strong, color: theme.color.text }}>{line.name}:</span> {line.text}
    </Help>
  );
}

/**
 * Eight directions as one radio group: native radios in a three by three
 * grid around a small square that stands for the map, so the group is one Tab
 * stop and the arrow keys walk it, as in every radio group of the app. The DOM
 * order is clockwise from the top. Each button is 44 px, 140 px across with
 * its gaps, which fits the 320 px phone at 130%.
 */
function Compass(props: { value: number; onChange(toward: number): void }) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label="Wind blows toward"
      style={{ display: "grid", gridTemplateColumns: `repeat(3, ${theme.touch}px)`, gridTemplateRows: `repeat(3, ${theme.touch}px)`, gap: theme.space(1), flex: "none" }}
    >
      {/* A cell as tall as the buttons around it, so the row is level whatever its box, with the square centered in it. */}
      <span aria-hidden style={{ gridRow: 2, gridColumn: 2, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ width: 20, height: 20, border: `${theme.line.border}px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.sm }} />
      </span>
      {COMPASS.map((c) => {
        const chosen = c.toward === props.value;
        return (
          <label
            key={c.toward}
            className="rvtt-choice"
            style={{ gridRow: c.row, gridColumn: c.col, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: theme.radius.md, cursor: "pointer", ...choiceLook(chosen) }}
          >
            <input
              type="radio"
              name={name}
              value={c.toward}
              checked={chosen}
              aria-label={c.name}
              onChange={() => props.onChange(c.toward)}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" }}
            />
            <Icon name="windToward" style={{ transform: `rotate(${c.toward}deg)`, pointerEvents: "none" }} />
          </label>
        );
      })}
    </div>
  );
}
