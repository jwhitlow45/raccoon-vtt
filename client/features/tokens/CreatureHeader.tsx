import type { ReactNode } from "react";
import type { ImageRef } from "#shared/model.ts";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { ImagePreview } from "../images/IconDisk.tsx";

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
 * picture at 48 px beside its name, whole and wrapping, then a line that
 * says what it is, its tags, and the quick numbers as `children`. The token
 * panel opens with it, so a token's details and a character's read alike.
 * The picture is decoration: the name says who it is, and changing the
 * picture is the Image group's.
 */
export function CreatureHeader(props: { picture: CreaturePicture; name: string; line: ReactNode; tags: readonly string[]; children?: ReactNode }) {
  const { picture } = props;
  return (
    // The picture beside the name, then one column no wider than the panel, so a tag too long for it is cut rather than widening the column.
    <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: theme.space(3), alignItems: "start", paddingTop: theme.space(2), paddingBottom: theme.space(4) }}>
      <span aria-hidden style={{ display: "flex" }}>
        <ImagePreview image={picture.image} shape={picture.shape} aspect={picture.aspect} width={48} ring={picture.ring} initials={picture.initials} />
      </span>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
        <h3 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{props.name}</h3>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
          <span style={{ color: theme.color.textMuted, fontSize: theme.font.small, marginRight: theme.space(1) }}>{props.line}</span>
          {props.tags.map((tag) => (
            // "Companion of" names a character, of any length: no tag runs wider than the row.
            <Tag key={tag} cut="100%">
              {tag}
            </Tag>
          ))}
        </div>
        {props.children}
      </div>
    </div>
  );
}
