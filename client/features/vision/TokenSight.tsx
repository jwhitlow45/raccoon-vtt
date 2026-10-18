import { useMemo } from "react";
import type { Actor, RoomState, Token } from "#shared/model.ts";
import type { TokenPatch } from "#shared/protocol.ts";
import { Help, Section } from "../../components/Panel.tsx";
import { Switch } from "../../components/Switch.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import type { TokenAccess } from "../tokens/access.ts";
import { LightChoices } from "./LightChip.tsx";
import { lightText } from "./presets.ts";
import { parseSenses, sensesLines } from "./senses.ts";
import { visionOn } from "./sightMode.ts";
import { noSightText } from "./sources.ts";
import { usePartyReport } from "./usePartyReport.ts";
import { playerOwned } from "#shared/project.ts";

/**
 * What a creature sees, in its token panel (docs/design-v1-maps-vision.md
 * section 4.3.1): its senses line in words ("Sees in the dark to 60 ft")
 * and the light it carries, for the DM and its owners, who set both. The
 * DM also sees whether it lends the party sight and why not, and can mark a
 * creature the DM runs to share its sight with the party.
 *
 * It shows on a scene with party vision, and anywhere while the token
 * carries a light or shares sight, so either can be taken off. Sharing
 * sight takes effect at once, so it is a Switch (docs/design-v1-visual.md
 * 3.7).
 */
export function TokenSight(props: { token: Token; actor: Partial<Actor> | undefined; access: TokenAccess; update(patch: TokenPatch): void }) {
  const { token, access, update } = props;
  const vision = useRoomView((s) => {
    const scene = s.view?.scenes[token.sceneId];
    return scene !== undefined && visionOn(scene);
  });
  // The DM's view holds every creature on the scene, which the source cap's order reads.
  const report = usePartyReport(token.sceneId, access.dm && vision);
  const row = useMemo(() => report.rows.find((r) => r.token.id === token.id), [report, token.id]);
  const characters = useRoomView((s) => (access.dm ? s.view?.characters : undefined));
  // A creature players own is in the party already, so only the DM's own creatures need the mark.
  const owned = useMemo(() => (characters ? playerOwned({ characters } as RoomState, token) : true), [characters, token]);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const canLight = access.canEditToken("light");
  const lit = token.light !== undefined && (token.light.bright > 0 || token.light.dim > 0);
  if (!access.dm && !canLight) return null;
  if (!vision && !lit && token.partyVision !== true) return null;

  const senses = typeof props.actor?.senses === "string" ? sensesLines(parseSenses(props.actor.senses), feetPerCell) : null;
  return (
    <Section label="Sight">
      {senses ? (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: theme.space(0.5), fontSize: theme.font.body14 }}>
          {senses.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {access.dm && row ? (
        <Help style={row.lends ? undefined : { color: theme.color.warning }}>
          {noSightText(row)}
          {row.lends && row.blinded ? ". Blinded, it sees only by Blindsight." : ""}
        </Help>
      ) : null}
      {canLight ? (
        <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0` }}>
          <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>Light it carries</span>
          <LightChoices light={token.light} onChoose={(light) => update({ light })} />
        </div>
      ) : (
        <Help>{lit ? `Carries a light: ${lightText(token.light, feetPerCell)}` : "Carries no light"}</Help>
      )}
      {access.dm && (!owned || token.partyVision === true) ? (
        <Switch
          checked={token.partyVision === true}
          onChange={(partyVision) => update({ partyVision })}
          label="Shares sight with the party"
          help="For an ally you run: the party sees what it sees, and players always see it."
        />
      ) : null}
    </Section>
  );
}
