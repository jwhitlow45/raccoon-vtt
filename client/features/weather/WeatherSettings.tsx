import { useEffect, useId, useState } from "react";
import type { Scene } from "#shared/model.ts";
import { weatherHasRules, weatherRules } from "#shared/rules/weather.ts";
import { weatherParts, type SceneWeather, type WeatherKind } from "#shared/weather.ts";
import { choiceLook } from "../../components/looks.ts";
import { Icon } from "../../components/Icon.tsx";
import { Help, Note, Section } from "../../components/Panel.tsx";
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
 * The Weather fold in What players see (docs/design/design-v1-weather.md 4.1),
 * after the light rows and before Sight: the kind, its strength, the wind and
 * where it blows, the switch that drops the roll rules for an indoor scene,
 * and the rules line. Every change sends one `scene.update` with the whole
 * weather, composed valid by `buildWeather`, so Undo puts the old one back.
 *
 * Its open state is the component's own, as the Fog and party vision fold's
 * is: open on a scene with weather, folded on a clear one, fresh each time
 * the settings open. The settings mount anew for each scene.
 */
export function WeatherSettings(props: { scene: Scene }) {
  const { scene } = props;
  const actions = useRoomActions();
  const weather = scene.weather;
  const picker = pickerOf(weather);
  const [open, setOpen] = useState(weather !== undefined);
  useEffect(() => {
    if (weather !== undefined) setOpen(true);
  }, [weather === undefined]);
  // Why the last pick moved something the DM did not pick, said in the wind's help while the scene holds what that pick sent.
  const [forced, setForced] = useState<Forced | null>(null);

  const change = (pick: Partial<Picker>) => {
    const built = buildWeather(picker, pick);
    if (built.refused) return;
    setForced(built.forced === null ? null : { text: built.forced, weather: built.weather });
    actions.dispatch({ t: "scene.update", sceneId: scene.id, patch: { weather: built.weather } });
  };

  return (
    <Section
      label="Weather"
      fold={{
        open,
        onToggle: () => setOpen((o) => !o),
        summary: open ? undefined : <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>{weatherSummary(weather)}</span>,
      }}
    >
      <WeatherBody picker={picker} weather={weather} forced={forcedNow(forced, weather)} change={change} />
    </Section>
  );
}

/** The fold's folded summary: "Clear", or the weather's names such as "Heavy rain · Strong wind". */
export function weatherSummary(weather: SceneWeather | undefined): string {
  const parts = weatherParts(weather);
  return parts.length === 0 ? "Clear" : parts.join(" · ");
}

function WeatherBody(props: { picker: Picker; weather: SceneWeather | undefined; forced: string | null; change(pick: Partial<Picker>): void }) {
  const { picker, weather, forced, change } = props;
  const clear = picker.kind === "clear";
  const [light, heavy] = strengthWords(picker.kind);
  const help = windHelp(picker, forced);
  const rules = weatherRules(weather);
  const RulesLine = rules.tone === "note" ? Note : Help;
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
        <SettingRow name="Blows toward" wide help="The map's edges as Top-down shows them.">
          <Compass value={picker.toward} onChange={(toward) => change({ toward })} />
        </SettingRow>
      )}
      {weatherHasRules(weather) ? (
        <Switch
          label="Weather rules on rolls"
          help="Rolls in this scene follow the rules below. Turn it off when the party is indoors. The weather still shows."
          checked={picker.rules}
          onChange={(on) => change({ rules: on })}
        />
      ) : null}
      <RulesLine style={{ paddingBottom: theme.space(2) }}>{rules.text}</RulesLine>
      <Help style={{ paddingBottom: theme.space(2) }}>Players see it at once. Each device can show it still or turn it off in This device.</Help>
    </div>
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
