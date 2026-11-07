import { useEffect, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { Help, Section } from "../../../components/Panel.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { LOOP_START_VOLUME, type Playing, type Sound } from "#shared/sound.ts";
import { AddSounds } from "../upload/AddSounds.tsx";
import { Actions } from "./controls.tsx";
import { send } from "./ops.ts";
import { loopOf, loopsFull, nameOf, soundsByUse, soundsOf } from "./state.ts";
import { FIFTH_LOOP, lengthText, NO_LOOPS } from "./words.ts";

/**
 * Background's toggles (4.1 item 3), pure: each loop sound pressed while it
 * plays, a press starting it at 70% or stopping it. With four playing, a
 * fifth press says why nothing started.
 */
export function LoopToggles(props: { loops: readonly Sound[]; playing: Playing | null; refused: boolean; onToggle(sound: Sound): void; onEdit(sound: Sound): void; editing: boolean }) {
  if (props.loops.length === 0) return <Help>{NO_LOOPS}</Help>;
  return (
    <div style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <div role="list" aria-label="Background sounds" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))", gap: theme.space(2) }}>
        {props.loops.map((s) => {
          const name = nameOf(s);
          const on = loopOf(props.playing, s.id) !== null;
          return (
            <div role="listitem" key={s.id} style={{ display: "grid", minWidth: 0 }}>
              <Button
                size="sm"
                pressed={props.editing ? undefined : on}
                data-opener={`sound-${s.id}`}
                aria-label={props.editing ? `Edit ${name}` : name}
                onClick={() => (props.editing ? props.onEdit(s) : props.onToggle(s))}
                style={{ width: "100%", minWidth: 0, height: "auto", minHeight: theme.touch, whiteSpace: "normal" }}
              >
                <span style={{ display: "grid", gap: 2, textAlign: "center", minWidth: 0 }}>
                  <span style={{ overflowWrap: "anywhere" }}>{name}</span>
                  <span style={{ fontSize: theme.font.small, fontWeight: theme.weight.regular, fontVariantNumeric: "tabular-nums", opacity: 0.8 }}>{lengthText(s.ms)}</span>
                </span>
              </Button>
            </div>
          );
        })}
      </div>
      {props.refused ? <Help>{FIFTH_LOOP}</Help> : null}
    </div>
  );
}

export function LoopsSection(props: { editing: boolean; onEditing(editing: boolean): void; onOpenSound(id: string): void; onStorageChanged(): void }) {
  const actions = useRoomActions();
  const sounds = useRoomView((s) => soundsOf(s.view));
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const [refused, setRefused] = useState(false);
  const { editing } = props;
  const loops = soundsByUse(sounds, "loop");
  const { onEditing } = props;
  // With nothing left to edit, Edit ends, so the next background sound added shows as a toggle.
  useEffect(() => {
    if (editing && loops.length === 0) onEditing(false);
  }, [editing, loops.length, onEditing]);
  const toggle = (sound: Sound) => {
    const id = loopOf(playing, sound.id);
    if (id !== null) {
      setRefused(false);
      send(actions, { t: "loop.stop", id });
      return;
    }
    if (loopsFull(playing)) {
      setRefused(true);
      return;
    }
    setRefused(false);
    send(actions, { t: "loop.start", id: actions.newId(), soundId: sound.id, volume: LOOP_START_VOLUME });
  };
  return (
    <Section
      label="Background"
      search="sound.background"
      action={
        loops.length > 0 ? (
          <Button size="sm" onClick={() => props.onEditing(!editing)}>
            {editing ? "Done" : "Edit"}
          </Button>
        ) : undefined
      }
    >
      <LoopToggles loops={loops} playing={playing} refused={refused && loopsFull(playing)} editing={editing} onToggle={toggle} onEdit={(s) => props.onOpenSound(s.id)} />
      <Actions>
        <AddSounds use="loop" onStorageChanged={props.onStorageChanged} />
      </Actions>
    </Section>
  );
}
