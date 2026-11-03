import type { ReactElement } from "react";
import type { SoundId, SoundUse } from "#shared/sound.ts";

/**
 * An Add button of the Sound panel and its queue of files
 * (docs/design/design-v1-sound.md 4.2): "Add music…", "Add background
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

/** Lane SN-E builds it. Until then it shows nothing, so the panel's lane can place it. */
export function AddSounds(props: AddSoundsProps): ReactElement | null {
  return null;
}
