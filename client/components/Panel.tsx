import { useId, type CSSProperties, type ReactNode } from "react";
import { theme } from "../lib/theme.ts";

/**
 * The parts every panel lays itself out with (docs/design-v1-visual.md
 * 2.3): sections split by a line, each opened by a capitals label, and the
 * muted help and warning notes under a control. They replace the five
 * Groups, four Sections, five Notes, the Help, two Hints and Muted that
 * panels each drew their own way.
 *
 * A panel body has padding `space(4)`, which the sheet and the side panel
 * already give it. A panel never repeats its own title as its first label:
 * the sheet's header and the side panel's tab already say it.
 */

/**
 * A section's label: 13 px, weight 700, capitals, muted. The danger tone
 * is for a section about something that cannot be undone (the DM link,
 * deleting the room), in `dangerText`, 5.9:1 on a surface. `action` sits
 * at the right, such as "Reorder" beside "All scenes".
 */
export function SectionLabel(props: { children: ReactNode; id?: string; tone?: "danger"; action?: ReactNode; level?: 2 | 3 | 4 }) {
  const Heading = props.level === 2 ? "h2" : props.level === 4 ? "h4" : "h3";
  const label = (
    <Heading
      id={props.id}
      style={{
        flex: 1,
        minWidth: 0,
        margin: 0,
        fontSize: theme.font.small,
        fontWeight: theme.weight.bold,
        letterSpacing: theme.caps,
        textTransform: "uppercase",
        lineHeight: theme.leading.tight,
        color: props.tone === "danger" ? theme.color.dangerText : theme.color.textMuted,
      }}
    >
      {props.children}
    </Heading>
  );
  if (!props.action) return label;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minHeight: theme.touch }}>
      {label}
      {props.action}
    </div>
  );
}

/**
 * A part of a panel under its label. Sections stack with a 1 px line
 * between them and `space(4)` above and below it. The first section of a
 * panel passes `divider={false}`, since nothing sits above it.
 *
 * A screen reader moves between sections by their labels, which are
 * headings. A section is a named region (a landmark) only with `region`:
 * a sheet that is itself a region, holding five more for the DM tab's
 * sections, made a landmark list too long to use.
 */
export function Section(props: {
  label?: ReactNode;
  tone?: "danger";
  action?: ReactNode;
  divider?: boolean;
  /** Makes the section a region named by its label. Rare: for a part a reader would jump to from the landmark list. */
  region?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const id = useId();
  const divider = props.divider !== false;
  return (
    <section
      aria-labelledby={props.region && props.label ? id : undefined}
      style={{
        display: "grid",
        gap: theme.space(2),
        paddingTop: divider ? theme.space(4) : 0,
        paddingBottom: theme.space(4),
        borderTop: divider ? `${theme.line.border}px solid ${theme.color.border}` : undefined,
        ...props.style,
      }}
    >
      {props.label ? (
        <SectionLabel id={id} tone={props.tone} action={props.action}>
          {props.label}
        </SectionLabel>
      ) : null}
      {props.children}
    </section>
  );
}

const HELP: CSSProperties = { margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted };

/** A line that explains, under a control or a section's label. Give it an `id` and point the control's `aria-describedby` at it. */
export function Help(props: { children: ReactNode; id?: string; style?: CSSProperties }) {
  return (
    <p id={props.id} style={{ ...HELP, ...props.style }}>
      {props.children}
    </p>
  );
}

/** Help in the warning tone: what a setting or an action will cost ("Players lose what they explored"). */
export function Note(props: { children: ReactNode; id?: string; style?: CSSProperties }) {
  return (
    <p id={props.id} style={{ ...HELP, color: theme.color.warning, ...props.style }}>
      {props.children}
    </p>
  );
}
