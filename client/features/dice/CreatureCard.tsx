import type { ReactNode } from "react";
import { theme } from "../../lib/theme.ts";
import { ImagePreview } from "../images/IconDisk.tsx";
import { Unbroken, type CreaturePicture } from "../tokens/CreatureHeader.tsx";
import type { KindLine } from "../tokens/creatureKind.ts";
import type { CreatureBadge } from "./creatureLook.ts";

/** The card, for the alignment sweep and the e2e suites. */
export const DICE_CARD = "[data-dice-card]";

/** Several selected show this many pictures at most (docs/design-v1-dice-pass.md 5.3). */
export const CARD_PICTURES = 3;

const ONE_PICTURE = 48;
const SEVERAL_PICTURE = 32;
const OVERLAP = 8;

/**
 * Who the Dice panel rolls for, as a card that cannot be mistaken for a
 * roll mode (docs/design-v1-dice-pass.md 5): the page's background inside
 * an outline, with the creature's picture, its name and its kind line, as
 * the token panel's header draws them (CreatureHeader.tsx). Everything
 * comes from props, so the header draws while the options load (5.4).
 *
 * - One creature: its picture at 48 px, a companion's with its badge,
 *   then its name as an h3 and the kind line.
 * - Several selected: up to three 32 px pictures overlapping, "3 selected"
 *   as the name, and their names as the line.
 * - A player's creatures: `tabs` across the top stand in for the picture
 *   and the name, so the card never says the name twice, then the line.
 * - Nothing to roll for: `children` alone, such as the note to select a
 *   token.
 *
 * The pictures are decoration: the name and the line say who it is.
 */
export function CreatureCard(props: {
  pictures?: readonly CreaturePicture[];
  badge?: CreatureBadge | null;
  name?: string;
  /** The kind line, or a plain line of words, such as several selected's names. */
  line?: KindLine | string;
  tabs?: ReactNode;
  children?: ReactNode;
}) {
  const pictures = (props.pictures ?? []).slice(0, CARD_PICTURES);
  const line = props.line !== undefined ? <CardLine line={props.line} /> : null;
  const header =
    pictures.length > 0 || props.name !== undefined ? (
      // The picture beside the name, then one column no wider than the card, so a long name wraps rather than widening it.
      <div style={{ display: "grid", gridTemplateColumns: pictures.length > 0 ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)", columnGap: theme.space(3), alignItems: "center" }}>
        {pictures.length > 0 ? <Pictures pictures={pictures} badge={pictures.length === 1 ? (props.badge ?? null) : null} /> : null}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
          {props.name !== undefined ? <h3 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{props.name}</h3> : null}
          {line}
        </div>
      </div>
    ) : (
      line
    );
  return (
    <div
      data-dice-card=""
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(2),
        padding: theme.space(3),
        background: theme.color.bg,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.md,
      }}
    >
      {props.tabs}
      {header}
      {props.children}
    </div>
  );
}

function CardLine(props: { line: KindLine | string }) {
  const { line } = props;
  return (
    // A companion's character's name may be one unbroken word as long as a name may be, so the line breaks anywhere.
    <p data-kind-line="" style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
      {typeof line === "string" ? (
        line
      ) : (
        <>
          {/* "Companion of Thorn" is its own element with exactly those words, as in the token panel's header. */}
          {line.companionOf === undefined ? line.kind : <span>{line.kind}</span>}
          {" · "}
          <Unbroken>{line.size}</Unbroken>
        </>
      )}
    </p>
  );
}

/**
 * One picture with its badge, or several overlapping. A ring of the
 * card's own fill parts a badge from the picture under it, and each
 * overlapping picture from the one before, as the token panel's surface
 * ring does there.
 */
function Pictures(props: { pictures: readonly CreaturePicture[]; badge: CreatureBadge | null }) {
  const { pictures, badge } = props;
  const parting = `${theme.line.strong}px solid ${theme.color.bg}`;
  if (pictures.length === 1) {
    const picture = pictures[0]!;
    return (
      <span aria-hidden style={{ position: "relative", display: "flex" }}>
        <ImagePreview image={picture.image} shape={picture.shape} aspect={picture.aspect} width={ONE_PICTURE} ring={picture.ring} initials={picture.initials} />
        {badge ? (
          // Within the picture's box, so nothing runs past the card's edge.
          <span style={{ position: "absolute", right: 0, bottom: 0, display: "flex", borderRadius: theme.radius.round, outline: parting }}>
            <ImagePreview image={badge.image} shape="circle" aspect={1} width={20} initials={badge.initials} />
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span aria-hidden style={{ display: "flex", alignItems: "center" }}>
      {pictures.map((picture, i) => (
        <span
          key={i}
          style={{
            display: "flex",
            marginLeft: i === 0 ? 0 : -OVERLAP,
            borderRadius: picture.shape === "circle" ? theme.radius.round : theme.radius.sm,
            outline: i === 0 ? undefined : parting,
          }}
        >
          <ImagePreview image={picture.image} shape={picture.shape} aspect={picture.aspect} width={SEVERAL_PICTURE} ring={picture.ring} initials={picture.initials} />
        </span>
      ))}
    </span>
  );
}
