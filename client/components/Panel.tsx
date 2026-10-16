import { useId, type CSSProperties, type ReactNode, type Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon } from "./Icon.tsx";

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
    <Heading id={props.id} style={{ flex: 1, minWidth: 0, margin: 0, ...sectionLabelLook(props.tone) }}>
      {props.children}
    </Heading>
  );
  if (!props.action) return label;
  return (
    // The action wraps under the label where a narrow panel has no room for both, rather than run out of the panel.
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minHeight: theme.touch }}>
      {label}
      {props.action}
    </div>
  );
}

/**
 * A section label's look without its heading element, for a label that
 * must not be a heading: a popover's title and a menu's group labels
 * (components/Popover.tsx, components/Menu.tsx), where a heading would
 * break the menu's roles.
 */
export function sectionLabelLook(tone?: "danger"): CSSProperties {
  return {
    fontSize: theme.font.small,
    fontWeight: theme.weight.bold,
    letterSpacing: theme.caps,
    textTransform: "uppercase",
    lineHeight: theme.leading.tight,
    color: tone === "danger" ? theme.color.dangerText : theme.color.textMuted,
  };
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
  /**
   * Makes the label a disclosure (docs/design-v1-token-panel.md 3.5):
   * folded, the section's content is not drawn. `summary` sits after the
   * disclosure, outside it, on the label's row, such as the owners' names.
   * `foldRef` is the disclosure button, for a caller that moves focus there.
   */
  fold?: { open: boolean; onToggle(): void; summary?: ReactNode; foldRef?: Ref<HTMLButtonElement> };
  children: ReactNode;
  style?: CSSProperties;
}) {
  const id = useId();
  const divider = props.divider !== false;
  if (props.fold) {
    const { fold } = props;
    return (
      <section
        aria-labelledby={props.region ? id : undefined}
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: theme.space(2),
          paddingTop: divider ? theme.space(2) : 0,
          paddingBottom: fold.open ? theme.space(4) : theme.space(2),
          borderTop: divider ? `${theme.line.border}px solid ${theme.color.border}` : undefined,
          ...props.style,
        }}
      >
        <FoldLabel id={id} label={props.label} tone={props.tone} fold={fold} />
        {fold.open ? props.children : null}
      </section>
    );
  }
  return (
    <section
      aria-labelledby={props.region && props.label ? id : undefined}
      style={{
        display: "grid",
        // One column no wider than the panel: an auto column grows to its widest unbreakable child, such as a stat block's ability table, and the whole panel then scrolls sideways.
        gridTemplateColumns: "minmax(0, 1fr)",
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

/**
 * A foldable section's label: a heading holding one full-width 44 px
 * button with a chevron and the label, `aria-expanded`, named by the label
 * alone so its name never changes with its state (Button.tsx). The look
 * is the section label's: 13 px, weight 700, capitals, muted. Whatever a
 * caller adds after it, a summary, stays outside the button.
 */
function FoldLabel(props: { id: string; label: ReactNode; tone?: "danger"; fold: NonNullable<Parameters<typeof Section>[0]["fold"]> }) {
  const { fold } = props;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2) }}>
      <h3 id={props.id} style={{ flex: "1 1 auto", minWidth: 0, margin: 0, display: "flex" }}>
        <button
          ref={fold.foldRef}
          type="button"
          aria-expanded={fold.open}
          onClick={(e) => {
            // Focus first, so a field being typed in blurs and commits before the fold unmounts it, even when the press moved no focus (an assistive technology's click, or Safari, whose buttons take no focus on a click).
            e.currentTarget.focus();
            fold.onToggle();
          }}
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: theme.space(1),
            minHeight: theme.touch,
            padding: 0,
            background: "transparent",
            border: "none",
            color: props.tone === "danger" ? theme.color.dangerText : theme.color.textMuted,
            fontSize: theme.font.small,
            fontWeight: theme.weight.bold,
            letterSpacing: theme.caps,
            textTransform: "uppercase",
            lineHeight: theme.leading.tight,
            fontFamily: theme.font.body,
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <Icon name={fold.open ? "chevronDown" : "chevronRight"} size="sm" />
          {props.label}
        </button>
      </h3>
      {fold.summary}
    </div>
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
