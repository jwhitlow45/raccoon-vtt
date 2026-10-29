import type { ReactNode } from "react";
import type { ImageRef } from "#shared/model.ts";
import type { IconName } from "../../components/Icon.tsx";
import { Tag } from "../../components/Tag.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { ImagePreview } from "../images/IconDisk.tsx";
import type { KindLine } from "./creatureKind.ts";

/**
 * A tag with the icon its state wears elsewhere, such as the tracker's
 * Hidden (docs/design-v1-icons-2.md 5). Where its words are shorter than
 * its meaning, `title` is the whole as its tooltip, and `spoken` the rest
 * of it, read after the words by a screen reader, which may not read a
 * title (D-261024-46).
 */
export type HeaderTag = { text: string; icon: IconName; title?: string; spoken?: string };

/** A character's page's name, found by the focus that lands there. */
export const CREATURE_HEADING = "[data-creature-heading]";

/** The header's picture across. A footprint taller than it is wide draws it taller (ImagePreview). */
const PICTURE_PX = 48;

/** A creature's picture as its header draws it: the image or initials, in its shape, ringed in its disposition's color. */
export type CreaturePicture = {
  image: ImageRef | null | undefined;
  shape: "circle" | "square";
  aspect: number;
  ring: string;
  initials: string;
};

/**
 * The top of a creature's details (docs/design-v1-look-pass.md 2.11): its
 * picture at 48 px beside its name, whole and wrapping, then the kind line,
 * which says what it is and its size (creatureKind.ts), its tags, a
 * control that belongs with them (`afterTags`, a rider's Controlled or
 * Independent), and the quick numbers as `children`. The token panel opens with it, so a token's
 * details and a character's read alike.
 *
 * What the DM or a player can do from the header (panelOrder.ts
 * headerActions: Place a token, View as Pat) takes one row under it all,
 * from the picture's edge, which is the panel's, so the numbers keep their
 * place under the kind line and both pages put their actions in one place
 * (docs/design-v1-design-pass.md 4.3). No actions, no row and no gap.
 *
 * A companion's picture carries its character's portrait (`badge`) as a
 * 20 px disk at its lower right, so the tie reads before the words (3.3).
 * The pictures are decoration: the name and the kind line say who it is,
 * and changing the picture is the Image group's.
 *
 * The name's first line stands at the picture's middle, as a row set at
 * its start meets its parts' first lines, so the name reads beside the
 * picture rather than along its top edge, and the lines under it follow.
 */
export function CreatureHeader(props: {
  picture: CreaturePicture;
  badge?: Omit<CreaturePicture, "shape" | "aspect" | "ring"> | null;
  name: string;
  line: KindLine;
  /** Opens the companion's character's page, for a viewer who may open it. Without it "Companion of Thorn" is text. */
  onCompanionOf?: (() => void) | null;
  /** The name takes focus from script, as a character's page's heading does after a delete it refused (CREATURE_HEADING). */
  focusable?: boolean;
  tags: readonly (string | HeaderTag)[];
  afterTags?: ReactNode;
  children?: ReactNode;
  /** The actions row's controls, each keyed. Pass only what draws, so an empty list draws no row (headerActions). */
  actions?: readonly ReactNode[];
}) {
  const { picture, badge, line } = props;
  const actions = props.actions ?? [];
  return (
    // The picture beside the name, then one column no wider than the panel, so a tag too long for it is cut rather than widening the column.
    <div data-creature-header="" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: theme.space(3), rowGap: theme.space(3), alignItems: "start", paddingTop: theme.space(2), paddingBottom: theme.space(4) }}>
      <span aria-hidden style={{ position: "relative", display: "flex" }}>
        <ImagePreview image={picture.image} shape={picture.shape} aspect={picture.aspect} width={PICTURE_PX} ring={picture.ring} initials={picture.initials} />
        {badge ? (
          // Within the picture's box, so nothing runs past the panel's edge. A ring of the panel's own surface parts the badge from the picture under it.
          <span style={{ position: "absolute", right: 0, bottom: 0, display: "flex", borderRadius: theme.radius.round, outline: `${theme.line.strong}px solid ${theme.color.surface}` }}>
            <ImagePreview image={badge.image} shape="circle" aspect={1} width={20} initials={badge.initials} />
          </span>
        ) : null}
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1), paddingTop: Math.max(0, (PICTURE_PX / picture.aspect - theme.font.heading * theme.leading.tight) / 2) }}>
        <h3
          {...(props.focusable ? { tabIndex: -1, "data-creature-heading": "" } : {})}
          style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}
        >
          {props.name}
        </h3>
        {/* A companion's character's name may be one unbroken word as long as a name may be, so the line breaks anywhere. */}
        <p data-kind-line="" style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
          {/* "Companion of Thorn" is always its own element with exactly those words, which the tracker's row repeats. */}
          {line.companionOf === undefined ? line.kind : props.onCompanionOf ? <CompanionOfLink onClick={props.onCompanionOf}>{line.kind}</CompanionOfLink> : <span>{line.kind}</span>}
          {" · "}
          <Unbroken>{line.size}</Unbroken>
        </p>
        {props.tags.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
            {props.tags.map((tag) =>
              typeof tag === "string" ? (
                <Tag key={tag} cut="100%">
                  {tag}
                </Tag>
              ) : (
                <Tag key={tag.text} cut="100%" icon={tag.icon} {...(tag.title ? { title: tag.title } : null)}>
                  {/* Words alone stay a string, which the tag takes as its tooltip where it cuts them. */}
                  {tag.spoken ? (
                    <>
                      {tag.text}
                      <span style={VISUALLY_HIDDEN}> {tag.spoken}</span>
                    </>
                  ) : (
                    tag.text
                  )}
                </Tag>
              ),
            )}
          </div>
        ) : null}
        {props.afterTags}
        {props.children}
      </div>
      {actions.length > 0 ? (
        // Across both columns, wrapping where a phone cannot hold them side by side.
        <div data-header-actions="" style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Words kept on one line, such as the size at the kind line's end,
 * "Medium (5 ft)", so a wrapped line never leaves "ft)" or "(5 ft)" alone
 * on its last line (FU32-FT-ALONE). Only for words far shorter than the
 * narrowest line.
 */
export function Unbroken(props: { children: ReactNode }) {
  return <span style={{ whiteSpace: "nowrap" }}>{props.children}</span>;
}

/**
 * "Companion of Thorn" where it opens Thorn's page: a quiet link, in the
 * line's own size and the text color with a line under it. Its press
 * reaches the touch size above and below the line without making the line
 * taller.
 */
function CompanionOfLink(props: { onClick(): void; children: ReactNode }) {
  const reach = (theme.touch - 20) / 2;
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        display: "inline",
        margin: `${-reach}px 0`,
        padding: `${reach}px 0`,
        background: "transparent",
        border: "none",
        color: theme.color.text,
        font: "inherit",
        textAlign: "left",
        textDecoration: "underline",
        textUnderlineOffset: 2,
        overflowWrap: "anywhere",
        cursor: "pointer",
      }}
    >
      {props.children}
    </button>
  );
}
