import { createContext, useContext, useId, type CSSProperties, type ReactNode, type Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon, type IconName } from "./Icon.tsx";

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
export function SectionLabel(props: {
  children: ReactNode;
  id?: string;
  tone?: "danger";
  action?: ReactNode;
  level?: 2 | 3 | 4;
  /** -1 for a label that takes focus when what had it went away, as a re-sync's sections do (docs/design-v1-resync.md 3.6). */
  tabIndex?: number;
}) {
  const Heading = props.level === 2 ? "h2" : props.level === 4 ? "h4" : "h3";
  const label = (
    // Its own width first ("1 1 auto", as FoldLabel's), so in the wrapping row below an action that does not fit beside it wraps under it. With a basis of 0 the action always took the line, and narrow fonts squeezed the label to a few pixels, its words running into the buttons.
    <Heading id={props.id} tabIndex={props.tabIndex} style={{ flex: "1 1 auto", minWidth: 0, margin: 0, ...sectionLabelLook(props.tone) }}>
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
   * With `keep`, folded content stays mounted and hidden instead, in one
   * column of its own, so work under way in it lasts through a fold: an
   * upload a fold would otherwise abort, or counts typed and not applied
   * (the scene settings' groups, docs/design-v1-map-discovery.md 8.4).
   */
  fold?: { open: boolean; onToggle(): void; summary?: ReactNode; foldRef?: Ref<HTMLButtonElement>; keep?: boolean };
  children: ReactNode;
  style?: CSSProperties;
}) {
  const id = useId();
  // Inside a Group the sections part by space alone: the group's own line already heads them (docs/design-v1-dice-ui.md 3.2). The group's body
  // spaces them by space(4), so none adds its own bottom padding, and their labels are a level under the group's heading.
  const inGroup = useContext(InGroup);
  const divider = props.divider ?? !inGroup;
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
          paddingBottom: inGroup ? 0 : fold.open ? theme.space(4) : theme.space(2),
          borderTop: divider ? `${theme.line.border}px solid ${theme.color.border}` : undefined,
          ...props.style,
        }}
      >
        <FoldLabel id={id} label={props.label} tone={props.tone} fold={fold} level={inGroup ? 4 : 3} />
        {fold.keep ? (
          <div hidden={!fold.open} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
            {props.children}
          </div>
        ) : fold.open ? (
          props.children
        ) : null}
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
        paddingBottom: inGroup ? 0 : theme.space(4),
        borderTop: divider ? `${theme.line.border}px solid ${theme.color.border}` : undefined,
        ...props.style,
      }}
    >
      {props.label ? (
        <SectionLabel id={id} tone={props.tone} action={props.action} level={inGroup ? 4 : 3}>
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
function FoldLabel(props: { id: string; label: ReactNode; tone?: "danger"; fold: NonNullable<Parameters<typeof Section>[0]["fold"]>; level: 3 | 4 }) {
  const { fold } = props;
  const Heading = props.level === 4 ? "h4" : "h3";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2) }}>
      <Heading id={props.id} style={{ flex: "1 1 auto", minWidth: 0, margin: 0, display: "flex" }}>
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
      </Heading>
      {fold.summary}
    </div>
  );
}

const InGroup = createContext(false);

/**
 * A group's box and its fold, for code inside a group that hands focus to
 * its heading once the pressed control goes, as Make a companion's does
 * (lib/handFocus.ts). A group is no `section`, so these are how to find it.
 */
export const GROUP_BOX = "[data-panel-group]";
export const GROUP_FOLD = "[data-group-fold]";

/**
 * A fold of a panel's sections that belong together by use (the Token
 * panel's Combat, Notes and Position, docs/design-v1-dice-ui.md 5): a 48 px
 * row with a chevron, the group's name at 16 px weight 700, and when folded
 * a one-line summary of what it holds ("HP 18/24 · 2 conditions"). Groups
 * part by a 1 px line, and the sections inside part by `space(4)`, keeping
 * their capitals labels as h4 under the group's h3, so the two levels never
 * look alike. A group of fields rather than sections spaces them as a
 * Section does. A group is no landmark: its heading is enough to move by, and
 * the Token panel held up to eight regions when each was one (Section).
 */
export function Group(props: {
  label: string;
  /** Its icon, after the chevron and before its name (docs/design-v1-icons-2.md 5), in the chevron's muted color. */
  icon?: IconName;
  /** Absent for a group that never folds, such as a stat block whose character is not in view: the same row, with no chevron. */
  open?: boolean;
  onToggle?(): void;
  summary?: ReactNode;
  /** On the header's row after the name, outside the disclosure: "Take a shape", "Attach a stat block". */
  action?: ReactNode;
  foldRef?: Ref<HTMLButtonElement>;
  /** `sections` for a group of Sections, parted by `space(4)`. A group of fields and lines, the default, keeps a Section's own `space(2)`. */
  holds?: "sections" | "rows";
  children?: ReactNode;
}) {
  const id = useId();
  const summaryId = `${id}-summary`;
  const folds = props.open !== undefined && props.onToggle !== undefined;
  const open = props.open ?? true;
  const name = (
    <span id={id} style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, flex: "none" }}>
      {props.label}
    </span>
  );
  const lead = props.icon ? (
    <span aria-hidden data-group-icon="" style={{ color: theme.color.textMuted, display: "flex" }}>
      <Icon name={props.icon} size="sm" />
    </span>
  ) : null;
  /*
   * With an icon, the summary has no more width of its own than a few
   * words, so the name, the icon and the action keep their line while the
   * summary still says something, cut sooner rather than the action
   * wrapping: the one cut the icon pass allows (docs/design-v1-icons-2.md
   * 3.3). Without one, it gives way to nothing as before, since a floor
   * there ran a long name such as the trap editor's "Finding and
   * disarming" past a narrow phone's row (review IC2BUILD-ASTRA-01).
   */
  const summaryRoom: CSSProperties = props.icon ? { flex: 1, width: 0, minWidth: "4em" } : { flex: 1, minWidth: 0 };
  const summary =
    !open && props.summary ? (
      <span id={summaryId} style={{ ...summaryRoom, textAlign: "right", fontSize: theme.font.small, fontWeight: theme.weight.regular, color: theme.color.textMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {props.summary}
      </span>
    ) : null;
  return (
    <div data-panel-group="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
      {/* The action wraps under the name where both do not fit, as Add a stat block and Take a shape do in a narrow card, rather than run over it. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minHeight: 48 }}>
        <h3 style={{ margin: 0, display: "flex", flex: "1 1 auto", minWidth: 0 }}>
          {folds ? (
            <button
              ref={props.foldRef}
              type="button"
              data-group-fold=""
              // Named by the group's name alone, so the name never changes as it folds. The summary describes it.
              aria-labelledby={id}
              aria-describedby={summary ? summaryId : undefined}
              aria-expanded={open}
              onClick={(e) => {
                // As FoldLabel: focus first, so a field being typed in commits before the fold unmounts it.
                e.currentTarget.focus();
                props.onToggle?.();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: theme.space(2),
                minHeight: 48,
                padding: 0,
                background: "transparent",
                border: "none",
                color: theme.color.text,
                fontFamily: theme.font.body,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <span style={{ color: theme.color.textMuted, display: "flex" }}>
                <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />
              </span>
              {lead}
              {name}
              {summary}
            </button>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0, flex: 1 }}>
              {lead}
              {name}
              {summary}
            </span>
          )}
        </h3>
        {props.action}
      </div>
      {open && props.children ? (
        <InGroup.Provider value={true}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(props.holds === "sections" ? 4 : 2), paddingTop: theme.space(1), paddingBottom: theme.space(4) }}>{props.children}</div>
        </InGroup.Provider>
      ) : null}
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
