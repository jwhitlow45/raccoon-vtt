import type { ReactNode } from "react";
import type { ImageRef } from "#shared/model.ts";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { ImagePreview } from "../images/IconDisk.tsx";
import type { KindLine } from "./creatureKind.ts";

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
 * which says what it is and its size (creatureKind.ts), its tags, and the
 * quick numbers as `children`. The token panel opens with it, so a token's
 * details and a character's read alike.
 *
 * A companion's picture carries its character's portrait (`badge`) as a
 * 20 px disk at its lower right, so the tie reads before the words (3.3).
 * The pictures are decoration: the name and the kind line say who it is,
 * and changing the picture is the Image group's.
 */
export function CreatureHeader(props: { picture: CreaturePicture; badge?: Omit<CreaturePicture, "shape" | "aspect" | "ring"> | null; name: string; line: KindLine; tags: readonly string[]; children?: ReactNode }) {
  const { picture, badge, line } = props;
  return (
    // The picture beside the name, then one column no wider than the panel, so a tag too long for it is cut rather than widening the column.
    <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: theme.space(3), alignItems: "start", paddingTop: theme.space(2), paddingBottom: theme.space(4) }}>
      <span aria-hidden style={{ position: "relative", display: "flex" }}>
        <ImagePreview image={picture.image} shape={picture.shape} aspect={picture.aspect} width={48} ring={picture.ring} initials={picture.initials} />
        {badge ? (
          // Within the picture's box, so nothing runs past the panel's edge. A ring of the panel's own surface parts the badge from the picture under it.
          <span style={{ position: "absolute", right: 0, bottom: 0, display: "flex", borderRadius: theme.radius.round, outline: `${theme.line.strong}px solid ${theme.color.surface}` }}>
            <ImagePreview image={badge.image} shape="circle" aspect={1} width={20} initials={badge.initials} />
          </span>
        ) : null}
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
        <h3 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{props.name}</h3>
        {/* A companion's character's name may be one unbroken word as long as a name may be, so the line breaks anywhere. */}
        <p data-kind-line="" style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
          {/* "Companion of Thorn" is always its own element with exactly those words, which the tracker's row repeats. */}
          {line.companionOf !== undefined ? <span>{line.kind}</span> : line.kind}
          {` · ${line.size}`}
        </p>
        {props.tags.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
            {props.tags.map((tag) => (
              <Tag key={tag} cut="100%">
                {tag}
              </Tag>
            ))}
          </div>
        ) : null}
        {props.children}
      </div>
    </div>
  );
}
