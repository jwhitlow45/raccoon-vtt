import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../components/Button.tsx";
import { Card, ErrorText, Field, Page } from "../components/Field.tsx";
import { Icon } from "../components/Icon.tsx";
import { Row, RowDot } from "../components/Row.tsx";
import { api, ApiError, type DmClaimChoice, type MemberSummary } from "../lib/api.ts";
import { rememberedName, rememberName } from "../lib/device.ts";
import type { FragmentSecret } from "../lib/links.ts";
import { navigate, replaceUrl } from "../lib/navigation.ts";
import { once } from "../lib/once.ts";
import { roomPath } from "../lib/roomId.ts";
import { theme } from "../lib/theme.ts";
import { claimRefusal } from "./claimRefusal.ts";

type Phase =
  | { kind: "checking" }
  | { kind: "claiming" }
  | { kind: "choose"; dmMembers: MemberSummary[]; notice: string | null }
  | { kind: "error"; message: string; retry: boolean };

function noGrant(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404);
}

/**
 * Opening a DM link (`#dm=`) or a device invite (`#invite=`), design section
 * 10.2. The secret is posted, then removed from the address bar with
 * replaceState, so it does not linger in the URL or the history.
 *
 * A device that already has a member in the room is upgraded without
 * questions. A device that is already a DM device skips the post, so it
 * never spends an invite. Any other device is asked who it is: most often
 * the same DM on a second phone or laptop, who picks their own member
 * ("This is me"), so one person stays one member with one undo history and
 * one set of whispers. A co-DM joins as someone new with a name.
 */
export function Claim(props: { roomId: string; fragment: FragmentSecret; onDone(): void }) {
  const { roomId, fragment, onDone } = props;
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  function finish() {
    replaceUrl(roomPath(roomId));
    onDone();
  }

  async function claim(choice: DmClaimChoice = {}, notice: string | null = null) {
    setPhase({ kind: "claiming" });
    try {
      // Each choice has its own key. Asking (no choice) is answered with a
      // refusal, which `once` forgets, and one pick must never be handed the
      // answer to another.
      const key = `${fragment.kind}:${fragment.secret}:${choice.memberId ?? ""}:${choice.name ?? ""}`;
      await once(key, () =>
        fragment.kind === "dm"
          ? api.claimDm(roomId, { key: fragment.secret, ...choice })
          : api.redeemInvite(roomId, { token: fragment.secret, ...choice }),
      );
      if (choice.name) rememberName(choice.name);
      finish();
    } catch (err) {
      const refusal = claimRefusal(fragment.kind, err, choice.memberId !== undefined);
      if (refusal.dropSecret) replaceUrl(roomPath(roomId));
      if (refusal.phase.kind === "reask") void claim({}, refusal.phase.notice);
      else if (refusal.phase.kind === "choose") setPhase({ ...refusal.phase, notice });
      else setPhase(refusal.phase);
    }
  }

  function start() {
    setPhase({ kind: "checking" });
    once(`me:${roomId}:${fragment.secret}`, () => api.getMe(roomId)).then(
      (me) => (me.role === "dm" ? finish() : void claim()),
      (err: unknown) => {
        // No member here, so the claim goes without a choice, and the
        // answer lists the room's DM members to choose from.
        if (noGrant(err)) void claim();
        else setPhase({ kind: "error", message: err instanceof Error ? err.message : "Something went wrong.", retry: true });
      },
    );
  }

  // Once per link. App gives each link its own Claim (keyed by the secret).
  useEffect(start, []);

  return (
    <Page>
      <h1 style={{ margin: 0, fontSize: theme.font.display, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>
        {fragment.kind === "dm" ? "DM link" : "DM device invite"}
      </h1>
      {phase.kind === "checking" || phase.kind === "claiming" ? (
        <p style={{ color: theme.color.textMuted }}>Signing this device in as a DM…</p>
      ) : null}
      {phase.kind === "choose" ? (
        <ChooseMember
          dmMembers={phase.dmMembers}
          notice={phase.notice}
          onPick={(memberId) => void claim({ memberId })}
          onNew={(name) => void claim({ name })}
        />
      ) : null}
      {phase.kind === "error" ? (
        <Card>
          <ErrorText>{phase.message}</ErrorText>
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
            {phase.retry ? (
              <Button icon="retry" variant="primary" onClick={start}>
                Try again
              </Button>
            ) : (
              <Button variant="primary" onClick={onDone}>
                Continue to the room
              </Button>
            )}
            <Button
              onClick={() => {
                navigate("/");
                onDone();
              }}
            >
              Home
            </Button>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}

function ChooseMember(props: {
  dmMembers: MemberSummary[];
  notice: string | null;
  onPick(memberId: string): void;
  onNew(name: string): void;
}) {
  const [name, setName] = useState(rememberedName);
  const known = props.dmMembers.length > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) props.onNew(trimmed);
  }

  return (
    <>
      {props.notice ? <ErrorText>{props.notice}</ErrorText> : null}
      {known ? (
        <Card title="Is this you?">
          <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>
            Opening the DM link on another phone or computer? Pick yourself to carry on as the same DM, with your whispers
            and undo.
          </p>
          <div style={{ display: "grid", gap: theme.space(2) }}>
            {props.dmMembers.map((m) => (
              <Row
                key={m.id}
                onClick={() => props.onPick(m.id)}
                leading={<RowDot color={m.color} />}
                title={m.name}
                trailing={
                  <span style={{ display: "flex", alignItems: "center", gap: theme.space(1), fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
                    This is me
                    <Icon name="chevronRight" size="sm" />
                  </span>
                }
              />
            ))}
          </div>
        </Card>
      ) : null}
      <Card title={known ? "Someone new" : "What should the table call you?"}>
        <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
          <p style={{ margin: 0, color: known ? theme.color.textMuted : undefined, fontSize: known ? theme.font.body14 : undefined }}>
            {known ? "A co-DM joins as a new DM member with their own name." : "This device is new to the room."}
          </p>
          <Field
            label="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            autoComplete="nickname"
            autoFocus={!known}
          />
          <Button type="submit" variant={known ? "secondary" : "primary"} disabled={name.trim() === ""}>
            {known ? "Join as a new DM" : "Continue as DM"}
          </Button>
        </form>
      </Card>
    </>
  );
}
