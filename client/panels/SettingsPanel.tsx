import { useId, useState, type FormEvent, type InputHTMLAttributes } from "react";
import type { RoomSettings, ScenePreset, WhichPlayers } from "#shared/model.ts";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { Empty } from "../components/Empty.tsx";
import { Input, NUMBER_FIELD_WIDTH } from "../components/Field.tsx";
import { Loading } from "../components/Loading.tsx";
import { Help, Section } from "../components/Panel.tsx";
import { RadioCards } from "../components/RadioCards.tsx";
import { SettingRow } from "../components/SettingRow.tsx";
import { Switch } from "../components/Switch.tsx";
import { roomHasHexes, type ShapeChoice } from "../features/grid/words.ts";
import type { PanelProps } from "../features/panels.ts";
import { timerChoices } from "../features/encounter/timer.ts";
import { ExportSection } from "../features/settings/ExportSection.tsx";
import {
  choiceOf,
  drawersOf,
  moveAnyFor,
  moveAnyMode,
  newScenesChoice,
  newScenesOptions,
  newScenesShape,
  parseFeetPerCell,
  parseRoomName,
  settingGroups,
  settingsOp,
  toggleOn,
  withMover,
  type MoveAnyMode,
  type SettingField,
} from "../features/settings/form.ts";
import { useUnsavedInput } from "../lib/sheetSwipe.ts";
import { theme } from "../lib/theme.ts";
import { useRoomActions, useRoomView } from "../state/view.ts";

/**
 * Room settings (design section 6, RoomSettings), DM only. A switch or a
 * choice applies at once as one `room.update` op, so the room changes for
 * everyone the moment the DM taps. Typed values apply on Save.
 *
 * Laid out as every panel's settings are (docs/design-v1-visual.md 2.3):
 * a capitals label over each group, so a group's title no longer reads
 * at the size of the settings under it, and one setting row per setting.
 */
export default function SettingsPanel(_props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  const settings = useRoomView((s) => s.view?.meta.settings);
  const name = useRoomView((s) => s.view?.meta.name);
  const actions = useRoomActions();
  // One boolean, so the form redraws only when the room first or last holds a hex scene.
  const hexes = useRoomView((s) => (s.view ? roomHasHexes(Object.values(s.view.scenes), s.view.meta.settings) : false));
  if (role !== "dm") return <Empty>Only the DM can change the room's settings.</Empty>;
  if (!settings || name === undefined) return <Loading text="Loading…" />;

  const apply = (next: Partial<RoomSettings>) => {
    const op = settingsOp(settings, next);
    if (op) actions.dispatch(op);
  };

  return (
    <div style={{ display: "grid" }}>
      <Section divider={false}>
        <RoomName current={name} onSave={(value) => actions.dispatch({ t: "room.update", name: value })} />
      </Section>
      {settingGroups(hexes).map((group) => (
        <Section key={group.heading} label={group.heading}>
          {group.fields.map((field) => (
            <SettingControl key={field.key} field={field} settings={settings} onChange={apply} />
          ))}
        </Section>
      ))}
      <ExportSection />
    </div>
  );
}

function SettingControl(props: { field: SettingField; settings: RoomSettings; onChange(next: Partial<RoomSettings>): void }) {
  const { field, settings, onChange } = props;
  switch (field.kind) {
    case "toggle":
      return <Switch label={field.label} help={field.help} checked={toggleOn(settings, field.key)} onChange={(v) => onChange({ [field.key]: v })} />;
    case "number":
      return <FeetPerCell label={field.label} help={field.help} value={settings.feetPerCell} onSave={(v) => onChange({ feetPerCell: v })} />;
    case "seconds":
      // Rooms from before the timer have no value, which is off.
      return (
        <div style={{ padding: `${theme.space(2)}px 0` }}>
          <RadioCards<string>
            legend={field.label}
            help={field.help}
            value={String(settings[field.key] ?? 0)}
            options={timerChoices(settings[field.key] ?? 0).map((o) => ({ value: String(o.value), label: o.label }))}
            onChange={(v) => onChange({ [field.key]: Number(v) })}
          />
        </div>
      );
    case "movers":
      return <ChosenPlayers field={field} group="Players who can move any token" value={settings.playersMoveAny} onChange={(playersMoveAny) => onChange({ playersMoveAny })} />;
    case "drawers":
      return <ChosenPlayers field={field} group="Players who can draw" value={drawersOf(settings)} onChange={(playersDraw) => onChange({ playersDraw })} />;
    case "newScenes":
      return (
        <div style={{ padding: `${theme.space(2)}px 0` }}>
          <RadioCards<ScenePreset | "before">
            legend={field.label}
            help={field.help}
            value={newScenesChoice(settings)}
            options={newScenesOptions(field, settings)}
            onChange={(v) => {
              if (v !== "before") onChange({ newScenePlayers: v });
            }}
          />
        </div>
      );
    case "gridShape":
      return (
        <div style={{ padding: `${theme.space(2)}px 0` }}>
          <RadioCards<ShapeChoice>
            legend={field.label}
            help={field.help}
            value={newScenesShape(settings)}
            options={field.options}
            onChange={(v) => onChange({ newScenes: v } as Partial<RoomSettings>)}
          />
        </div>
      );
    case "choice":
      // Each key's options are typed to its own values, so the cast only widens for the shared component.
      return (
        <div style={{ padding: `${theme.space(2)}px 0` }}>
          <RadioCards<string>
            legend={field.label}
            help={field.help}
            value={choiceOf(settings, field.key)}
            options={field.options}
            onChange={(v) => onChange({ [field.key]: v } as Partial<RoomSettings>)}
          />
        </div>
      );
  }
}

/**
 * Who may move tokens they do not own (features section 5), or who may draw
 * (docs/design-v1-dm-tools.md 3.9): no one, every player, or the players
 * ticked below. Each tap applies at once, like the switches. Only players
 * are listed, since a DM does both anyway.
 */
function ChosenPlayers(props: { field: Extract<SettingField, { kind: "movers" | "drawers" }>; group: string; value: WhichPlayers; onChange(value: WhichPlayers): void }) {
  const { field, value } = props;
  const members = useRoomView((s) => s.view?.members);
  const players = Object.values(members ?? {})
    .filter((m) => m.kind === "player")
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosen = Array.isArray(value) ? value : null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(2)}px 0` }}>
      <RadioCards<MoveAnyMode>
        legend={field.label}
        help={field.help}
        value={moveAnyMode(value)}
        options={field.options}
        onChange={(mode) => props.onChange(moveAnyFor(mode, value))}
      />
      {chosen ? (
        players.length > 0 ? (
          <div role="group" aria-label={props.group} style={{ display: "grid", paddingLeft: theme.space(4) }}>
            {players.map((m) => (
              <Checkbox key={m.id} label={m.name} checked={chosen.includes(m.id)} onChange={(on) => props.onChange(withMover(value, m.id, on))} />
            ))}
          </div>
        ) : (
          <Help>No players have joined yet. They show here once they do.</Help>
        )
      ) : null}
    </div>
  );
}

/**
 * A typed setting with its own Save, as a setting row: the room's name,
 * which needs the panel's width, under its name, and the feet per square,
 * a number, at the right of its name. A refusal reads under the whole row,
 * where it has room.
 */
function SavedSetting(props: {
  name: string;
  help: string;
  wide?: boolean;
  dirty: boolean;
  error: string | null;
  onSubmit(e: FormEvent): void;
  input: InputHTMLAttributes<HTMLInputElement>;
}) {
  const errorId = useId();
  return (
    <form onSubmit={props.onSubmit} style={{ display: "grid", gap: theme.space(1) }}>
      <SettingRow name={props.name} help={props.help} wide={props.wide}>
        {(ids) => (
          <div style={{ display: "flex", gap: theme.space(2), flex: props.wide ? 1 : "none", minWidth: 0 }}>
            <Input
              {...props.input}
              aria-labelledby={ids.nameId}
              aria-describedby={[ids.helpId, props.error ? errorId : undefined].filter(Boolean).join(" ") || undefined}
              error={props.error !== null}
              // A wide field has no width of its own, only its share of the row: a text field's own width, about 20 characters, set the row's least width and pushed Room settings sideways on a 320 px phone at 130%.
              style={props.wide ? { flex: 1, minWidth: 0, width: 0 } : { width: NUMBER_FIELD_WIDTH, textAlign: "right" }}
            />
            <Button type="submit" size="sm" disabled={!props.dirty}>
              Save
            </Button>
          </div>
        )}
      </SettingRow>
      {props.error ? (
        <p id={errorId} role="alert" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
          {props.error}
        </p>
      ) : null}
    </form>
  );
}

/** Typed numbers apply on Save or Enter, not on every keystroke, so "15" never passes through "1". */
function FeetPerCell(props: { label: string; help: string; value: number; onSave(value: number): void }) {
  const [text, setText] = useState(String(props.value));
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(props.value);
  // Another DM device changed it: show the new value unless this one is mid-edit.
  if (synced !== props.value) {
    setSynced(props.value);
    if (text === String(synced)) setText(String(props.value));
  }
  const dirty = text.trim() !== String(props.value);
  // Typed values apply on Save, so a sheet's swipe springs back until then (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(dirty);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseFeetPerCell(text);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    setText(String(parsed.value));
    props.onSave(parsed.value);
  };
  return (
    <SavedSetting
      name={props.label}
      help={props.help}
      dirty={dirty}
      error={error}
      onSubmit={submit}
      input={{
        value: text,
        inputMode: "numeric",
        pattern: "[0-9]*",
        onChange: (e) => {
          setText(e.target.value);
          setError(null);
        },
      }}
    />
  );
}

function RoomName(props: { current: string; onSave(name: string): void }) {
  const [text, setText] = useState(props.current);
  const [error, setError] = useState<string | null>(null);
  const [synced, setSynced] = useState(props.current);
  if (synced !== props.current) {
    setSynced(props.current);
    if (text === synced) setText(props.current);
  }
  const dirty = text.trim() !== props.current;
  useUnsavedInput(dirty);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseRoomName(text);
    if (!parsed.ok) return setError(parsed.error);
    setError(null);
    setText(parsed.value);
    if (parsed.value !== props.current) props.onSave(parsed.value);
  };
  return (
    <SavedSetting
      name="Room name"
      help="Shown in the top bar for everyone in the room."
      wide
      dirty={dirty}
      error={error}
      onSubmit={submit}
      input={{
        value: text,
        maxLength: 80,
        onChange: (e) => {
          setText(e.target.value);
          setError(null);
        },
      }}
    />
  );
}
