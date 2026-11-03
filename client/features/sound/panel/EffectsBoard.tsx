import { useEffect } from "react";
import { Button } from "../../../components/Button.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { Row, RowList } from "../../../components/Row.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import type { BuiltinSound, Sound } from "#shared/sound.ts";
import { AddSounds } from "../upload/AddSounds.tsx";
import { Actions, Subhead, useTicking, useWakeAt } from "./controls.tsx";
import { send } from "./ops.ts";
import { effectsSounding, nameOf, serverNow, soundsByUse, soundsOf } from "./state.ts";
import { BUILT_IN, BUILTINS, fireName, lengthText, NO_EFFECTS } from "./words.ts";

/** The board's grid (4.1 item 4, 4.7): two columns on a 390 px phone, one at 320 px and 130%. */
const BOARD = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: theme.space(2) } as const;

function EffectButton(props: { name: string; pressed: boolean; onFire(): void; opener?: string }) {
  return (
    <div role="listitem" style={{ display: "grid", minWidth: 0 }}>
      <Button
        size="sm"
        pressed={props.pressed}
        aria-label={fireName(props.name)}
        data-opener={props.opener}
        onClick={props.onFire}
        style={{ width: "100%", minWidth: 0, height: "auto", minHeight: theme.touch, whiteSpace: "normal" }}
      >
        <span style={{ overflowWrap: "anywhere", textAlign: "center" }}>{props.name}</span>
      </Button>
    </div>
  );
}

/**
 * The board, pure: Built in, then the room's effects, each a tap that plays
 * it for everyone, pressed for its length. In Edit the room's effects are a
 * list whose rows open each effect's page. `builtInOnly` while the server
 * offers no sound files.
 */
export function Board(props: {
  effects: readonly Sound[];
  sounding: ReadonlySet<string>;
  editing: boolean;
  builtInOnly: boolean;
  onFireBuiltin(b: BuiltinSound): void;
  onFire(sound: Sound): void;
  onEdit(sound: Sound): void;
}) {
  return (
    <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
      <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
        <Subhead>{BUILT_IN}</Subhead>
        <div role="list" aria-label={BUILT_IN} style={BOARD}>
          {BUILTINS.map((b) => (
            <EffectButton key={b.id} name={b.name} pressed={props.sounding.has(`builtin:${b.id}`)} onFire={() => props.onFireBuiltin(b.id)} />
          ))}
        </div>
      </div>
      {props.builtInOnly ? null : (
        <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
          <Subhead>The room's effects</Subhead>
          {props.effects.length === 0 ? (
            <Help>{NO_EFFECTS}</Help>
          ) : props.editing ? (
            <RowList label="The room's effects">
              {props.effects.map((s) => (
                <Row key={s.id} title={nameOf(s)} detail={lengthText(s.ms)} opener={`sound-${s.id}`} onClick={() => props.onEdit(s)} />
              ))}
            </RowList>
          ) : (
            <div role="list" aria-label="The room's effects" style={BOARD}>
              {props.effects.map((s) => (
                <EffectButton key={s.id} name={nameOf(s)} opener={`sound-${s.id}`} pressed={props.sounding.has(`sound:${s.id}`)} onFire={() => props.onFire(s)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function EffectsBoard(props: { serverOn: boolean; editing: boolean; onEditing(editing: boolean): void; onOpenSound(id: string): void; onStorageChanged(): void }) {
  const actions = useRoomActions();
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const serverOffset = useRoomView((s) => s.serverOffset);
  const { editing } = props;
  const effects = soundsByUse(sounds, "effect");
  const t = useTicking(() => serverNow({ serverOffset }), false);
  const { keys, nextEnd } = effectsSounding(playing, sounds, t);
  // Renders once when the next pressed effect ends (or a fired one starts), not every second.
  useWakeAt(nextEnd, t);
  const canEdit = props.serverOn && effects.length > 0;
  const { onEditing } = props;
  // With nothing left to edit, Edit ends, so the next effect added shows on the board, not as a row.
  useEffect(() => {
    if (editing && !canEdit) onEditing(false);
  }, [editing, canEdit, onEditing]);
  return (
    <Section
      label="Effects"
      action={
        canEdit ? (
          // One button whose words change, so focus stays on it through Edit and Done (10).
          <Button size="sm" onClick={() => props.onEditing(!editing)}>
            {editing ? "Done" : "Edit"}
          </Button>
        ) : undefined
      }
    >
      <Board
        effects={effects}
        sounding={keys}
        editing={editing && canEdit}
        builtInOnly={!props.serverOn}
        onFireBuiltin={(builtin) => send(actions, { t: "effect.fire", id: actions.newId(), builtin })}
        onFire={(s) => send(actions, { t: "effect.fire", id: actions.newId(), soundId: s.id })}
        onEdit={(s) => props.onOpenSound(s.id)}
      />
      {props.serverOn ? (
        <Actions>
          <AddSounds use="effect" onStorageChanged={props.onStorageChanged} />
        </Actions>
      ) : null}
    </Section>
  );
}
