import type { ReactNode } from "react";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { Section, TextField } from "./ui.tsx";

/**
 * A token's two notes (features section 5): one for everyone who can see
 * the token, such as "wears the stolen guard's tabard", and one for the DM
 * alone, such as "the real duke is in the cellar". The first is the token's
 * own `notes`, which the DM and the token's owners write. The second is its
 * actor's `dmNotes`, which no player projection carries (design 7.3), so it
 * shows only on a DM's device.
 *
 * Players who cannot write the note read it as text, and see no section at
 * all while it is empty.
 */
export function TokenNotes(props: {
  notes: string | undefined;
  canEdit: boolean;
  onNotes(notes: string | null): void;
  /** The DM's note, shown and written only when the viewer is a DM. */
  dm: { notes: string; onNotes(notes: string): void } | null;
}) {
  const { notes, canEdit, dm } = props;
  if (!canEdit && !notes && !dm) return null;
  return (
    <Section title="Notes">
      <Labeled label="For everyone" hint={canEdit ? "Every player who can see this token reads it." : undefined}>
        {canEdit ? (
          <TextField
            label="Note for everyone"
            multiline
            value={notes ?? ""}
            maxLength={4000}
            placeholder="What anyone at the table may know"
            onCommit={(v) => props.onNotes(v.trim() ? v : null)}
          />
        ) : (
          <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{notes || "None."}</p>
        )}
      </Labeled>
      {dm ? (
        <Labeled label="For DMs only" hint="Never sent to players, the token's owners included.">
          <TextField label="Note for DMs only" multiline value={dm.notes} maxLength={4000} placeholder="Only DMs see this" onCommit={dm.onNotes} />
        </Labeled>
      ) : null}
    </Section>
  );
}

/** A note's audience above it, since a text box needs the panel's full width. */
function Labeled(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "grid", gap: theme.space(0.5) }}>
        <div style={{ fontSize: theme.font.body14 }}>{props.label}</div>
        {props.hint ? <Help>{props.hint}</Help> : null}
      </div>
      {props.children}
    </div>
  );
}
