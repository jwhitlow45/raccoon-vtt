import { useState, type FormEvent } from "react";
import { generatePassphrase } from "#shared/passphrase.ts";
import { Button } from "../../components/Button.tsx";
import { Card, ErrorText, Field } from "../../components/Field.tsx";
import { useTurnstile } from "../../components/Turnstile.tsx";
import { api } from "../../lib/api.ts";
import { rememberedName, rememberName } from "../../lib/device.ts";
import { rememberRoom } from "../../lib/knownRooms.ts";
import { theme } from "../../lib/theme.ts";
import { FileButton } from "../dm/controls.tsx";
import { passwordProblem } from "../dm/invite.ts";
import { formatBytes, importErrorText, importFileProblem } from "./backup.ts";

/**
 * Import a room from a backup zip on the Home page (design 16.4). It makes a
 * new room with new IDs and a new DM link, so it counts as creating a room
 * and the creator becomes its DM, the same as the create form.
 */
export function ImportRoomCard(props: { onImported(created: { roomId: string; dmLink: string; password: string }): void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [dmName, setDmName] = useState(rememberedName);
  const [password, setPassword] = useState(() => generatePassphrase());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const turnstile = useTurnstile();
  const fileProblem = file ? importFileProblem(file) : null;
  const pwProblem = password.length > 0 ? passwordProblem(password) : null;

  if (!open) {
    return (
      <Card title="Import a room">
        <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14 }}>Restore a room from a backup file that a DM downloaded.</p>
        {/* Full width, as every Home card's one action is. */}
        <Button block onClick={() => setOpen(true)}>
          Import from a backup
        </Button>
      </Card>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The busy Import button ignores taps, but Enter in a field still submits the form.
    if (busy) return;
    setError(null);
    if (!file) return setError("Pick the backup file first.");
    const problem = importFileProblem(file) ?? passwordProblem(password);
    if (problem) return setError(problem);
    if (!dmName.trim()) return setError("Enter your name. You will be the DM.");
    if (turnstile.required && !turnstile.token) return setError("Wait a moment for the human check to finish.");
    setBusy(true);
    try {
      const res = await api.importRoom(
        file,
        {
          ...(name.trim() ? { name: name.trim() } : {}),
          playerPassword: password,
          dmName: dmName.trim(),
          ...(turnstile.token ? { turnstileToken: turnstile.token } : {}),
        },
        { onWaiting: setWaiting },
      );
      rememberName(dmName.trim());
      // As for a created room (Home.tsx): the DM link that follows is shown
      // once, so the room is remembered before it. A blank name is the
      // backup's, which Home reads from the server.
      rememberRoom({ roomId: res.roomId, name: name.trim(), me: { role: "dm", member: { name: dmName.trim() } } });
      props.onImported({ roomId: res.roomId, dmLink: res.dmLink, password });
    } catch (err) {
      setError(importErrorText(err));
    } finally {
      setBusy(false);
      turnstile.reset();
    }
  }

  return (
    <Card title="Import a room">
      <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
        <div style={{ display: "grid", gap: theme.space(1) }}>
          <span style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>Backup file</span>
          <FileButton
            label={file ? "Pick another file" : "Pick the backup file"}
            accept=".zip,application/zip"
            disabled={busy}
            onFile={(picked) => {
              setFile(picked);
              setError(null);
            }}
          />
          {file ? (
            <span style={{ fontSize: theme.font.small, color: fileProblem ? theme.color.dangerText : theme.color.textMuted }}>
              {fileProblem ?? `${file.name}, ${formatBytes(file.size)}`}
            </span>
          ) : null}
        </div>
        <Field
          label="New room name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          hint="Leave it empty to keep the name in the backup."
        />
        <Field
          label="Your name"
          value={dmName}
          onChange={(e) => setDmName(e.target.value)}
          maxLength={80}
          autoComplete="nickname"
          hint="You will be the DM of the new room."
        />
        <Field
          label="Player password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          maxLength={128}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          hint="Players type this to join the new room. At least 8 characters."
          error={pwProblem}
          trailing={
            <Button onClick={() => setPassword(generatePassphrase())} aria-label="Suggest another password">
              New
            </Button>
          }
        />
        {turnstile.widget}
        <ErrorText>{error}</ErrorText>
        {busy ? (
          <p role="status" style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
            {waiting ? "Waiting for the server…" : "Uploading and checking every image. A big backup takes a few minutes."}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button type="submit" variant="primary" busy={busy} disabled={turnstile.pending || !file || fileProblem !== null}>
            {busy ? "Importing…" : "Import room"}
          </Button>
          <Button onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
