import type { ReactNode } from "react";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { Section, TextField } from "./ui.tsx";

/**
 * A token's notes in one section (features section 5,
 * docs/design-v1-token-panel.md 3.8): one for everyone who can see the
 * token, such as "wears the stolen guard's tabard", the card's notes,
 * which the DM and the card's owners read, and one for the DM alone, such
 * as "the real duke is in the cellar". The first is the token's own
 * `notes`, which the DM and the token's owners write. The card's are its
 * actor's `notes`. The last is its actor's `dmNotes`, which no player
 * projection carries (design 7.3), so it shows only on a DM's device.
 * Each starts two rows tall and still resizes.
 *
 * Players who cannot write the note read it as text, and see no section at
 * all while there is nothing for them.
 */
export function TokenNotes(props: {
  notes: string | undefined;
  canEdit: boolean;
  onNotes(notes: string | null): void;
  /** The card's notes, for the DM and the card's owners whose copy holds them, as a field or as text. */
  card?: ReactNode;
  /** The DM's note, shown and written only when the viewer is a DM. */
  dm: { notes: string; onNotes(notes: string): void } | null;
}) {
  const { notes, canEdit, dm } = props;
  if (!canEdit && !notes && !dm && !props.card) return null;
  return (
    <Section title="Notes">
      <Labeled label="For everyone" hint={canEdit ? "Every player who can see this token reads it." : undefined}>
        {canEdit ? (
          <TextField
            label="Note for everyone"
            multiline
            rows={2}
            value={notes ?? ""}
            maxLength={4000}
            placeholder="What anyone at the table may know"
            onCommit={(v) => props.onNotes(v.trim() ? v : null)}
          />
        ) : (
          <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{notes || "None."}</p>
        )}
      </Labeled>
      {props.card ? (
        <Labeled label="On the card" hint="The DM and whoever owns this card read it.">
          {props.card}
        </Labeled>
      ) : null}
      {dm ? (
        <Labeled label="For DMs only" hint="Never sent to players, the token's owners included.">
          <TextField label="Note for DMs only" multiline rows={2} value={dm.notes} maxLength={4000} placeholder="Only DMs see this" onCommit={dm.onNotes} />
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
