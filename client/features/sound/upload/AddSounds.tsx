import { useEffect, useRef, useState, type ReactElement } from "react";
import { useStore } from "zustand";
import type { SoundId, SoundUse } from "#shared/sound.ts";
import { Button } from "../../../components/Button.tsx";
import { Spinner, useDelayed } from "../../../components/Loading.tsx";
import { api } from "../../../lib/api.ts";
import { theme } from "../../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../../state/scope.ts";
import type { RoomActions, RoomViewStore } from "../../../state/view.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../../state/view.ts";
import { SoundQueue, type CreateAnswer, type QueueDeps, type Row, type SoundCreate } from "./job.ts";
import { ADD_LABEL, addedWords, cancelLabel, dismissLabel, filesLabel, PICK_CAPPED, stepWords } from "./words.ts";

/**
 * An Add button of the Sound panel and its queue of files
 * (docs/design/design-v1-music.md 4.2): "Add music…", "Add background
 * sounds…" or "Add effects…" by its use, a file picker of up to
 * SOUND_LIMITS.pickFiles files, one row a file with its step, percent and
 * Cancel, and each refusal on its row. It reads the room and sends
 * `sound.create` itself, so the panel only places it. The panel shows none
 * while the server's switch is off.
 */
export type AddSoundsProps = {
  /** The section's use: every file added becomes a sound of this use, and its length caps apply. */
  use: SoundUse;
  /** After a file's `sound.create` was sent, with the new sound's id. */
  onAdded?: (soundId: SoundId) => void;
  /** After an upload settles, added, refused or cancelled, so the storage line checks again (4.1 item 6). */
  onStorageChanged?: () => void;
};

/** One queue for the room's three Add buttons, so only one file is read at a time on this device. */
const queueSlot = scopeSlot(
  () => ({ queue: null as SoundQueue | null }),
  (value) => value.queue?.dispose(),
);

function liveDeps(roomId: string, actions: RoomActions, store: RoomViewStore, props: AddSoundsProps): QueueDeps {
  return {
    // The reader, its worker and the encoder load only when a DM adds a file.
    prepare: async (input) => (await import("./read.ts")).prepareSound(input),
    upload: (blob, options) => api.uploadAssetWithProgress(roomId, "sound", blob, options),
    create: (op) => createSound(actions, op),
    holds: (soundId) => store.getState().view?.sounds?.[soundId] !== undefined,
    newId: () => actions.newId(),
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    onAdded: props.onAdded,
    onStorageChanged: props.onStorageChanged,
  };
}

/** `sound.create` (design 6.2), whose answer the row waits for. */
function createSound(actions: RoomActions, op: SoundCreate): Promise<CreateAnswer> {
  return new Promise((resolve) => {
    const n = actions.dispatch({ t: "sound.create", ...op }, {
      onAnswer: (answer, refusal) => resolve(answer === "taken" ? { t: "taken" } : answer === "refused" ? { t: "refused", text: refusal?.text ?? "the room refused it." } : { t: "unknown" }),
    });
    if (n === null) resolve({ t: "refused", text: "this app could not send it." });
  });
}

export function AddSounds(props: AddSoundsProps): ReactElement {
  const slot = useScoped(queueSlot);
  const roomId = useRoomView((s) => s.roomId);
  const actions = useRoomActions();
  const store = useRoomStore();
  slot.queue ??= new SoundQueue(liveDeps(roomId, actions, store, props));
  const queue = slot.queue;
  const music = props.use === "music";
  // The callbacks are the latest render's, so a file that finishes after the panel re-rendered calls the current ones.
  useEffect(() => {
    queue.setDeps(liveDeps(roomId, actions, store, props));
  });
  const rows = useStore(queue.store, (s) => s.rows);
  const input = useRef<HTMLInputElement>(null);
  const [capped, setCapped] = useState(false);
  const mine = rows.filter((row) => row.use === props.use);

  return (
    <div data-add-sounds={props.use} style={{ display: "flex", flexDirection: "column", gap: theme.space(2), minWidth: 0 }}>
      {/* Music's alone is a result of the room search: the others stand in sections it finds. */}
      <Button size="sm" icon="plus" search={music ? "sound.library.add" : undefined} onClick={() => input.current?.click()} style={{ alignSelf: "flex-start" }}>
        {ADD_LABEL[props.use]}
      </Button>
      <input
        ref={input}
        type="file"
        accept="audio/*"
        multiple
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          // Cleared, so the same file can be picked again after a refusal.
          e.currentTarget.value = "";
          if (files.length > 0) setCapped(queue.add(files, props.use) > 0);
        }}
      />
      {capped ? (
        <p role="status" style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.textMuted }}>
          {PICK_CAPPED}
        </p>
      ) : null}
      {mine.length > 0 ? (
        <ul aria-label={filesLabel(props.use)} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: theme.space(1) }}>
          {mine.map((row) => (
            <FileRow key={row.id} row={row} queue={queue} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const ROW = { display: "flex", alignItems: "center", gap: theme.space(2), minHeight: 44, minWidth: 0 } as const;
const WORDS = { minWidth: 0, flex: "1 1 auto", overflowWrap: "anywhere", fontSize: theme.font.body14, lineHeight: theme.leading.body } as const;
/** A row's button never gives up width to long words beside it, so every row's button is the same size. */
const ROW_BUTTON = { flex: "none" } as const;

/**
 * Every row keeps the spinner's place, shown or not, so the words of all
 * rows start in one line and do not shift when a spinner shows.
 */
function SpinnerSlot(props: { shown: boolean }) {
  return (
    <span aria-hidden style={{ flex: "none", display: "flex", width: theme.icon.sm, visibility: props.shown ? "visible" : "hidden", color: theme.color.textMuted }}>
      <Spinner size={theme.icon.sm} />
    </span>
  );
}

function FileRow(props: { row: Row; queue: SoundQueue }) {
  const { row, queue } = props;
  const working = row.step.t !== "waiting" && row.step.t !== "added" && row.step.t !== "refused";
  // The shared indicator's delay: a step that ends at once never flashes a spinner.
  const spin = useDelayed(working);
  if (row.step.t === "added") {
    return (
      <li data-sound-row="added" style={ROW}>
        <SpinnerSlot shown={false} />
        <span role="status" style={{ ...WORDS, color: theme.color.textMuted }}>
          {addedWords(row.added ?? row.fileName)}
        </span>
      </li>
    );
  }
  if (row.step.t === "refused") {
    return (
      <li data-sound-row="refused" style={ROW}>
        <SpinnerSlot shown={false} />
        <span role="alert" style={{ ...WORDS, color: theme.color.dangerText }}>
          {row.step.text}
        </span>
        <Button size="sm" style={ROW_BUTTON} onClick={() => queue.dismiss(row.id)} aria-label={dismissLabel(row.fileName)}>
          Dismiss
        </Button>
      </li>
    );
  }
  return (
    <li data-sound-row={row.step.t} aria-busy={working ? true : undefined} style={ROW}>
      <SpinnerSlot shown={spin} />
      {/* Its words change with every percent, too often to read out: Cancel and the row's end say what matters. */}
      <span style={{ ...WORDS, color: row.step.t === "waiting" ? theme.color.textMuted : theme.color.text }}>{stepWords(row.fileName, row.step)}</span>
      <Button size="sm" style={ROW_BUTTON} onClick={() => queue.cancel(row.id)} aria-label={cancelLabel(row.fileName)}>
        Cancel
      </Button>
    </li>
  );
}
