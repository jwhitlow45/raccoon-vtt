import { useEffect, useId, useState } from "react";
import { Button } from "../../../components/Button.tsx";
import { Field } from "../../../components/Field.tsx";
import { Help, Note, Section } from "../../../components/Panel.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { SettingRow } from "../../../components/SettingRow.tsx";
import { api, assetUrl } from "../../../lib/api.ts";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../../state/view.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { useLengthRefusal } from "#shared/reducer/sound.ts";
import { SOUND_USES, type Sound, type SoundUse } from "#shared/sound.ts";
import { Actions } from "./controls.tsx";
import { listenHere, stopListening, useListening } from "./engine.ts";
import { send } from "./ops.ts";
import { deleteRefusal, nameOf, playlistsOf, serverNow, soundsOf, useLeaves, useRefusal } from "./state.ts";
import { deleteSoundAsk, lengthText, LISTEN_HELP, USE_NAMES, useLeavesLine } from "./words.ts";

/** Why each use is off for this length, in the words of 4.1, or null when it fits. */
export function useReasons(ms: number): Record<SoundUse, string | null> {
  const out = {} as Record<SoundUse, string | null>;
  for (const use of SOUND_USES) out[use] = useLengthRefusal(use, ms);
  return out;
}

/** The sound's name, saved on Enter or leaving the field (4.1). */
function NameField(props: { name: string; onSave(name: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? props.name;
  const save = () => {
    const name = value.trim();
    setDraft(null);
    if (name !== "" && name !== props.name) props.onSave(name.slice(0, MAX_NAME));
  };
  return (
    <Field
      label="Name"
      value={value}
      maxLength={MAX_NAME}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape" && draft !== null) {
          e.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}

/**
 * A sound's page (4.1): Name, Used as with each use its length rules out
 * disabled and why, its length, Listen here on this device alone, and
 * Delete on a second tap. A sound that plays now refuses a change of use
 * and a delete, in words, before anything is sent. A track only queued
 * deletes and leaves the queue, while a change of its use is refused
 * (docs/design/design-v1-music-player.md 6.4). A sounding effect deletes at
 * once and stops.
 */
export function SoundPage(props: { sound: Sound; onDeleted(): void }) {
  const { sound } = props;
  const actions = useRoomActions();
  const playing = useRoomView((s) => s.view?.playing ?? null);
  const playlists = useRoomView((s) => playlistsOf(s.view));
  const sounds = useRoomView((s) => soundsOf(s.view));
  const serverOffset = useRoomView((s) => s.serverOffset);
  const scenes = useRoomView((s) => s.view?.scenes ?? {});
  const roomId = useRoomView((s) => s.roomId);
  const listening = useListening();
  const [said, setSaid] = useState<{ text: string; tone: "help" | "note" } | null>(null);
  const [armed, setArmed] = useState(false);
  const reasonsId = useId();
  const name = nameOf(sound);
  const reasons = useReasons(sound.ms);
  const lines = SOUND_USES.flatMap((u) => (reasons[u] ? [reasons[u]] : []));
  const mine = listening.soundId === sound.id;

  // A Listen here that outlives its page would play on with nothing to stop it.
  useEffect(() => () => stopListening(), [sound.id]);

  const changeUse = (use: SoundUse) => {
    if (use === sound.use) return;
    const refusal = useRefusal(playing, sounds, sound.id, serverNow({ serverOffset }));
    if (refusal) {
      setSaid({ text: refusal, tone: "note" });
      return;
    }
    const leaves = useLeaves(sound, use, playlists, scenes);
    send(actions, { t: "sound.update", id: sound.id, use });
    const line = useLeavesLine(name, leaves.playlists, leaves.scenes);
    setSaid(line ? { text: line, tone: "help" } : null);
  };

  const remove = () => {
    const refusal = deleteRefusal(playing, sounds, sound.id, serverNow({ serverOffset }));
    if (refusal) {
      setArmed(false);
      setSaid({ text: refusal, tone: "note" });
      return;
    }
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    // The file goes once the op is taken. Another sound may share it, which the route answers with asset_in_use, and the day's cleanup takes it when nothing names it (7.3).
    const assetId = sound.assetId;
    send(actions, { t: "sound.delete", id: sound.id }, (answer) => {
      if (answer === "taken") void api.deleteAssets(roomId, [assetId]).catch(() => {});
    });
    props.onDeleted();
  };

  return (
    <div style={{ display: "grid", gap: theme.space(4), minWidth: 0 }}>
      <NameField key={sound.id} name={name} onSave={(next) => send(actions, { t: "sound.update", id: sound.id, name: next })} />
      <SettingRow name="Used as" wide>
        {(ids) => (
          <Segmented<SoundUse>
            labelledBy={ids.nameId}
            describedBy={lines.length > 0 ? reasonsId : undefined}
            value={sound.use}
            options={SOUND_USES.map((u) => ({ value: u, label: USE_NAMES[u], disabled: reasons[u] !== null && u !== sound.use }))}
            onChange={changeUse}
          />
        )}
      </SettingRow>
      {lines.length > 0 ? <Help id={reasonsId}>{lines.join(" ")}</Help> : null}
      {said ? (
        <div role="status" aria-live="polite">
          {said.tone === "note" ? <Note>{said.text}</Note> : <Help>{said.text}</Help>}
        </div>
      ) : null}
      <p data-sound-length="" style={{ margin: 0, fontSize: theme.font.body14, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>
        Length {lengthText(sound.ms)}
      </p>
      <Actions>
        <Button
          size="sm"
          icon={mine && !listening.busy ? "stop" : "play"}
          busy={mine && listening.busy}
          onClick={() => {
            if (mine) stopListening();
            else listenHere({ soundId: sound.id, url: assetUrl(sound.assetId, "full"), ...(sound.level !== undefined ? { level: sound.level } : null) });
          }}
        >
          {mine ? (listening.busy ? "Starting…" : "Stop") : "Listen here"}
        </Button>
      </Actions>
      <Help>{LISTEN_HELP}</Help>
      <Section label="Delete" tone="danger">
        {armed ? <Note>{deleteSoundAsk(name)}</Note> : null}
        <Actions>
          <Button size="sm" variant="danger" armed={armed} onBlur={() => setArmed(false)} onClick={remove}>
            {armed ? `Delete ${name}` : "Delete"}
          </Button>
        </Actions>
      </Section>
    </div>
  );
}
