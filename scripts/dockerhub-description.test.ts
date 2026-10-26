import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The Docker Hub description workflow (.github/workflows/dockerhub-description.yml)
 * and the files it sends, selfhost/DOCKERHUB.md and selfhost/DOCKERHUB-short.txt.
 * Its step runs as the workflow runs it, with a stand-in for curl that
 * records every call and answers as Docker Hub would: the files' text goes
 * out as the full and the short description, with the repository's address
 * in place of {{REPOSITORY_URL}}, the personal access token only in the
 * sign-in's body on stdin, the bearer token only in the update's
 * Authorization header and the log's mask, neither on a command line, in a
 * URL or anywhere else in the log,
 * and any answer but a 2xx fails the step with one escaped error line. A try
 * that gets no answer, or a 408, 429 or 5xx, is tried again on its own, up to
 * three times (review DH-ASTRA-001).
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const WORKFLOW = ".github/workflows/dockerhub-description.yml";
const STEP = "Set the description";
const FULL = "selfhost/DOCKERHUB.md";
const SHORT = "selfhost/DOCKERHUB-short.txt";
/** How the overview names the repository's address, which the step fills in. */
const TOKEN = "{{REPOSITORY_URL}}";
/** The address the step fills in here, as GitHub gives it from github.server_url and github.repository. */
const REPOSITORY_URL = "https://github.com/example/raccoon-vtt";

// Plain stand-ins that match no real token's format, so no secret scanner takes them for one.
const PAT = "test-docker-hub-token";
const BEARER = "test-bearer-value";
const AUTH_URL = "https://hub.docker.com/v2/auth/token";
const PATCH_URL = "https://hub.docker.com/v2/repositories/example/raccoon-vtt";

/** The step's script: the lines of its `run: |` block, as GitHub hands them to bash. */
function stepScript(): string {
  const lines = read(WORKFLOW).split("\n");
  const name = lines.findIndex((l) => l.trim() === `- name: ${STEP}`);
  assert.ok(name >= 0, `no step named "${STEP}"`);
  const run = lines.findIndex((l, i) => i > name && l.trim() === "run: |");
  const indent = lines[run + 1]!.length - lines[run + 1]!.trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** How the stand-in answers one try of one of the two calls: an HTTP status and body, or curl failing outright. */
type Answer = { status: number; body: string } | { curlExit: number };

/** One call to curl, as the stand-in saw it. */
type Call = { args: string[]; url: string; method: string; headers: string[]; body: string };

const SIGNED_IN: Answer = { status: 200, body: JSON.stringify({ access_token: BEARER }) };
const UPDATED = (full: string, short: string): Answer => ({ status: 200, body: JSON.stringify({ name: "raccoon-vtt", description: short, full_description: full }) });
const UNAVAILABLE: Answer = { status: 503, body: "<html><body>503 Service Unavailable</body></html>" };

/** The overview as the step should send it: every {{REPOSITORY_URL}} replaced with the address, nothing else changed. */
const filled = (text: string) => text.split(TOKEN).join(REPOSITORY_URL);

/**
 * curl, standing in: it records its arguments, the headers and the body it
 * would send, read from stdin or a file as curl reads them, then answers
 * with the next of the fixture's answers for the URL, as
 * `--write-out '\n%{http_code}'` makes curl print it. With --retry it tries
 * again on a transient answer, as curl does, and like curl writing to
 * stdout it prints every try's body, one after the other.
 */
const STAND_IN = `#!/bin/bash
set -eu
n=$(( $(cat "$LOG/count" 2> /dev/null || echo 0) + 1 ))
echo "$n" > "$LOG/count"
d="$LOG/$n"
mkdir -p "$d"
: > "$d/headers"; : > "$d/body"; : > "$d/method"; : > "$d/url"
printf '%s\\0' "$@" > "$d/args"
from() { if [ "$1" = @- ]; then cat; elif [ "\${1:0:1}" = @ ]; then cat "\${1:1}"; else printf '%s' "$1"; fi; }
retries=0
while [ $# -gt 0 ]; do
  case $1 in
    -H | --header) shift; from "$1" >> "$d/headers"; echo >> "$d/headers" ;;
    -d | --data | --data-binary) shift; from "$1" > "$d/body" ;;
    -X | --request) shift; printf '%s' "$1" > "$d/method" ;;
    --retry) shift; retries=$1 ;;
    -w | --write-out | --max-time | --proto) shift ;;
    https://*) printf '%s' "$1" > "$d/url" ;;
  esac
  shift
done
case $(cat "$d/url") in
  */v2/auth/token) which=auth ;;
  *) which=patch ;;
esac
while :; do
  try=$(( $(cat "$LOG/$which.tries" 2> /dev/null || echo 0) + 1 ))
  echo "$try" > "$LOG/$which.tries"
  # The last answer repeats once the list runs out.
  last=$(cat "$FIX/$which.count")
  a=$(( try < last ? try : last ))
  if [ -f "$FIX/$which.$a.exit" ]; then
    if [ "$retries" -gt 0 ]; then retries=$((retries - 1)); continue; fi
    echo "curl: (6) Could not resolve host: hub.docker.com" >&2
    exit "$(cat "$FIX/$which.$a.exit")"
  fi
  cat "$FIX/$which.$a.body"
  status=$(cat "$FIX/$which.$a.status")
  case $status in
    408 | 429 | 500 | 502 | 503 | 504) if [ "$retries" -gt 0 ]; then retries=$((retries - 1)); continue; fi ;;
  esac
  break
done
printf '\\n%s' "$status"
`;

/** sleep, standing in: it records how long the step would wait, and returns at once. */
const SLEEP = `#!/bin/bash
echo "$1" >> "$LOG/sleeps"
`;

/** What a run of the step did. */
type Run = { status: number | null; out: string; calls: Call[]; tries: { auth: number; patch: number }; sleeps: string[] };

/**
 * The step, run in a folder holding `files` (the real overview and short
 * description unless given), against a Docker Hub that answers the sign-in's
 * tries with `auth` and the update's with `patch`, one answer a try: its
 * exit, what it printed, every call curl got, how many tries each request
 * took and the waits between them.
 */
function run(opts: { auth?: Answer | Answer[]; patch?: Answer | Answer[]; files?: Record<string, string>; repositoryUrl?: string } = {}): Run {
  const dir = mkdtempSync(path.join(tmpdir(), "raccoon-dockerhub-step-"));
  try {
    const [bin, log, fix, work] = ["bin", "log", "fix", "work"].map((d) => path.join(dir, d));
    for (const d of [bin!, log!, fix!, path.join(work!, "selfhost")]) mkdirSync(d, { recursive: true });
    for (const [name, script] of [["curl", STAND_IN], ["sleep", SLEEP]] as const) {
      writeFileSync(path.join(bin!, name), script);
      chmodSync(path.join(bin!, name), 0o755);
    }
    const files = opts.files ?? { [FULL]: read(FULL), [SHORT]: read(SHORT) };
    for (const [file, text] of Object.entries(files)) writeFileSync(path.join(work!, file), text);
    const full = files[FULL] ?? "";
    const short = (files[SHORT] ?? "").replace(/\n$/, "");
    for (const [which, given] of [["auth", opts.auth ?? SIGNED_IN], ["patch", opts.patch ?? UPDATED(filled(full), short)]] as const) {
      const answers = Array.isArray(given) ? given : [given];
      writeFileSync(path.join(fix!, `${which}.count`), String(answers.length));
      answers.forEach((answer, i) => {
        const at = (f: string) => path.join(fix!, `${which}.${i + 1}.${f}`);
        if ("curlExit" in answer) writeFileSync(at("exit"), String(answer.curlExit));
        else {
          writeFileSync(at("status"), String(answer.status));
          writeFileSync(at("body"), answer.body);
        }
      });
    }
    writeFileSync(path.join(dir, "step.sh"), stepScript());
    // As GitHub runs a step with no shell named: bash -e.
    const r = spawnSync("bash", ["-e", path.join(dir, "step.sh")], {
      cwd: work,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, LOG: log, FIX: fix, REPOSITORY: "example/raccoon-vtt", REPOSITORY_URL: opts.repositoryUrl ?? REPOSITORY_URL, DOCKERHUB_USERNAME: "example", DOCKERHUB_TOKEN: PAT },
    });
    const calls = readdirSync(log!)
      .filter((f) => /^\d+$/.test(f))
      .sort((a, b) => Number(a) - Number(b))
      .map((n): Call => {
        const at = (f: string) => readFileSync(path.join(log!, n, f), "utf8");
        return { args: at("args").split("\0").slice(0, -1), url: at("url"), method: at("method"), headers: at("headers").split("\n").filter(Boolean), body: at("body") };
      });
    const count = (f: string) => (existsSync(path.join(log!, f)) ? readFileSync(path.join(log!, f), "utf8") : "");
    const tries = { auth: Number(count("auth.tries") || 0), patch: Number(count("patch.tries") || 0) };
    return { status: r.status, out: r.stdout + r.stderr, calls, tries, sleeps: count("sleeps").split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A value as a workflow command carries it: %, CR and LF escaped. */
const escaped = (v: string) => v.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
/** The mask the step asks for once it holds the bearer token, a line the runner hides rather than prints. */
const MASK = `::add-mask::${BEARER}`;
/** The workflow commands a run printed, lines starting "::", apart from that mask. */
const commands = (out: string) => out.split("\n").filter((l) => l.startsWith("::") && l !== MASK);

/** Neither token in what the step printed, but in the mask, or on any command line or URL it used. */
function assertNoTokenLeaks(r: Run): void {
  for (const secret of [PAT, BEARER]) {
    const shown = r.out.split("\n").filter((l) => l !== MASK).join("\n");
    assert.ok(!shown.includes(secret), `the log holds ${secret === PAT ? "the access token" : "the bearer token"}:\n${r.out}`);
    for (const c of r.calls) {
      assert.ok(!c.args.some((a) => a.includes(secret)), `a command line holds a token: ${c.args.join(" ")}`);
      assert.ok(!c.url.includes(secret), `a URL holds a token: ${c.url}`);
    }
  }
}

const jq = spawnSync("jq", ["--version"]).status === 0;

describe("the Docker Hub description step", { skip: jq ? false : "jq is not installed" }, () => {
  test("signs in with the token in the body, then sends the files as the descriptions with the bearer token in the header alone", () => {
    const r = run();
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(commands(r.out), [], r.out);
    assert.equal(r.calls.length, 2, r.out);
    const [signIn, update] = r.calls as [Call, Call];

    assert.equal(signIn.url, AUTH_URL);
    assert.deepEqual(JSON.parse(signIn.body), { identifier: "example", secret: PAT });
    assert.ok(!signIn.headers.some((h) => /^authorization:/i.test(h)), "the sign-in sends no Authorization header");

    assert.equal(update.url, PATCH_URL);
    assert.equal(update.method, "PATCH");
    assert.deepEqual(JSON.parse(update.body), { full_description: filled(read(FULL)), description: read(SHORT).replace(/\n$/, "") });
    assert.deepEqual(update.headers.filter((h) => /^authorization:/i.test(h)), [`Authorization: Bearer ${BEARER}`]);
    // The bearer token in that header and nowhere else, and the access token nowhere in the update.
    assert.ok(!update.body.includes(BEARER) && !update.body.includes(PAT));
    assert.ok(!update.headers.some((h) => h.includes(PAT)));
    assert.ok(!signIn.headers.some((h) => h.includes(BEARER)));
    // Both only over HTTPS, as curl's --proto keeps them.
    for (const c of r.calls) assert.ok(c.args.includes("--proto") && c.args[c.args.indexOf("--proto") + 1] === "=https", c.args.join(" "));
    assertNoTokenLeaks(r);
    // The bearer token masked before anything could print it (review F2).
    assert.deepEqual(r.out.split("\n").filter((l) => l.startsWith("::add-mask::")), [MASK]);
    assert.match(r.out, /Set the description of example\/raccoon-vtt: \d+ bytes from selfhost\/DOCKERHUB\.md/);
    // One try each, with no wait, and no curl --retry, which would join the tries' bodies.
    assert.deepEqual([r.tries, r.sleeps], [{ auth: 1, patch: 1 }, []]);
    for (const c of r.calls) assert.ok(!c.args.includes("--retry"), c.args.join(" "));
  });

  test("puts the repository's address in place of every {{REPOSITORY_URL}}, and changes nothing else", () => {
    const text = `[a](${TOKEN})\n${TOKEN}/raw/$tag/x ${TOKEN}${TOKEN}\n$1 \\& }} {OTHER}\n`;
    const r = run({ files: { [FULL]: text, [SHORT]: "Short\n" } });
    assert.equal(r.status, 0, r.out);
    const sent = JSON.parse(r.calls[1]!.body) as { full_description: string };
    assert.equal(sent.full_description, `[a](${REPOSITORY_URL})\n${REPOSITORY_URL}/raw/$tag/x ${REPOSITORY_URL}${REPOSITORY_URL}\n$1 \\& }} {OTHER}\n`);
    // Read the other way: the address back to the token gives the file, byte for byte.
    assert.equal(sent.full_description.split(REPOSITORY_URL).join(TOKEN), text);
    // The real overview: every token filled, and nothing else.
    const real = JSON.parse(run().calls[1]!.body) as { full_description: string };
    assert.ok(read(FULL).includes(TOKEN) && !real.full_description.includes(TOKEN));
    assert.equal(real.full_description.split(REPOSITORY_URL).join(TOKEN), read(FULL));
  });

  test("refuses to send the overview without the repository's https address", () => {
    for (const repositoryUrl of ["", "/example/raccoon-vtt", "http://github.com/example/raccoon-vtt", "https://github.com", "https://github.com/example /raccoon-vtt"]) {
      const r = run({ repositoryUrl });
      assert.equal(r.status, 1, repositoryUrl);
      assert.equal(r.calls.length, 0, repositoryUrl);
      assert.deepEqual(commands(r.out), [`::error::REPOSITORY_URL is '${repositoryUrl}', not the repository's https address, which the overview's links need.`]);
    }
  });

  test("refuses an overview with a placeholder it does not know, which would reach Docker Hub as it is", () => {
    for (const text of ["[a]({{REPOSITORY_URl}})\n", "{{ REPOSITORY_URL }}\n", `${TOKEN} {{`]) {
      const r = run({ files: { [FULL]: text, [SHORT]: "Short\n" } });
      assert.equal(r.status, 1, text);
      assert.equal(r.calls.length, 0, text);
      assert.deepEqual(commands(r.out), ["::error::selfhost/DOCKERHUB.md holds a placeholder other than {{REPOSITORY_URL}}, which would reach Docker Hub as it is."], text);
    }
  });

  test("tries a sign-in again after an HTML 503, each try's answer read on its own", () => {
    const r = run({ auth: [UNAVAILABLE, SIGNED_IN] });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(commands(r.out), [], r.out);
    assert.deepEqual([r.tries, r.sleeps], [{ auth: 2, patch: 1 }, ["2"]]);
    assert.deepEqual(r.calls[2]!.headers.filter((h) => /^authorization:/i.test(h)), [`Authorization: Bearer ${BEARER}`]);
    assertNoTokenLeaks(r);
  });

  test("tries an update again after no answer, a 429 or a 5xx, and sends the same body each time", () => {
    const r = run({ patch: [{ curlExit: 28 }, { status: 429, body: "slow down" }, UPDATED(filled(read(FULL)), read(SHORT).trimEnd())] });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual([r.tries, r.sleeps], [{ auth: 1, patch: 3 }, ["2", "4"]]);
    const updates = r.calls.filter((c) => c.url === PATCH_URL);
    assert.equal(updates.length, 3);
    for (const c of updates) assert.deepEqual([c.body, c.headers], [updates[0]!.body, updates[0]!.headers]);
    assert.ok(updates[0]!.body.length > 0);
  });

  test("fails with a clear error after three 503s, and after three tries with no answer", () => {
    const busy = run({ patch: UNAVAILABLE });
    assert.equal(busy.status, 1, busy.out);
    assert.deepEqual([busy.tries.patch, busy.sleeps], [3, ["2", "4"]]);
    assert.deepEqual(commands(busy.out), ["::error::Docker Hub did not set the description of example/raccoon-vtt (HTTP 503): <html><body>503 Service Unavailable</body></html>"]);
    const signIn = run({ auth: UNAVAILABLE });
    assert.equal(signIn.status, 1, signIn.out);
    assert.deepEqual([signIn.tries, signIn.calls.length], [{ auth: 3, patch: 0 }, 3]);
    assert.match(commands(signIn.out)[0] ?? "", /^::error::Docker Hub refused to sign in .*\(HTTP 503\)/);
    const gone = run({ auth: { curlExit: 6 } });
    assert.equal(gone.status, 1, gone.out);
    assert.deepEqual([gone.tries.auth, commands(gone.out)], [3, ["::error::Could not reach Docker Hub to sign in."]]);
  });

  for (const status of [400, 401, 403, 404, 422, 429, 500, 301]) {
    test(`fails on an update answered ${status}, with one error line and no token in it`, () => {
      const detail = `refused: ${PAT} and ${BEARER} echoed back`;
      const r = run({ patch: { status, body: JSON.stringify({ detail }) } });
      assert.equal(r.status, 1, r.out);
      const lines = commands(r.out);
      assert.equal(lines.length, 1, r.out);
      assert.ok(lines[0]!.startsWith("::error::") && lines[0]!.includes(`(HTTP ${status})`), lines[0]);
      assert.ok(lines[0]!.includes("refused: *** and *** echoed back"), lines[0]);
      if (status === 401 || status === 403) assert.ok(lines[0]!.includes("Repo Read, Write, Delete"), lines[0]);
      // An answer that will not change is not tried again. 429 and 5xx are, three times in all.
      assert.equal(r.tries.patch, status === 429 || status >= 500 ? 3 : 1);
      assertNoTokenLeaks(r);
    });
  }

  for (const status of [401, 500]) {
    test(`stops at a sign-in answered ${status}, before any update`, () => {
      const r = run({ auth: { status, body: JSON.stringify({ detail: "Incorrect authentication credentials" }) } });
      assert.equal(r.status, 1, r.out);
      // A 401 is final, and a 500 is tried three times. Either way no update follows.
      assert.deepEqual(r.tries, { auth: status === 401 ? 1 : 3, patch: 0 });
      assert.deepEqual(commands(r.out), [`::error::Docker Hub refused to sign in with DOCKERHUB_USERNAME and DOCKERHUB_TOKEN (HTTP ${status}): Incorrect authentication credentials`]);
      assertNoTokenLeaks(r);
    });
  }

  test("stops when the sign-in's answer holds no access token", () => {
    for (const body of ["{}", "not json", JSON.stringify({ access_token: "" })]) {
      const r = run({ auth: { status: 200, body } });
      assert.equal(r.status, 1, r.out);
      assert.equal(r.calls.length, 1, body);
      assert.deepEqual(commands(r.out), ["::error::Docker Hub's answer to signing in held no access token."], body);
    }
  });

  test("names what failed when curl cannot reach Docker Hub", () => {
    const signIn = run({ auth: { curlExit: 6 } });
    assert.equal(signIn.status, 1, signIn.out);
    assert.deepEqual(commands(signIn.out), ["::error::Could not reach Docker Hub to sign in."]);
    const update = run({ patch: { curlExit: 28 } });
    assert.equal(update.status, 1, update.out);
    assert.deepEqual(commands(update.out), ["::error::Could not reach Docker Hub to set the description of example/raccoon-vtt."]);
    assertNoTokenLeaks(update);
  });

  test("escapes what Docker Hub says, so it starts no workflow command of its own", () => {
    const detail = "bad at 100%\r\n::warning::injected annotation\n::add-mask::x";
    const r = run({ patch: { status: 422, body: JSON.stringify({ message: detail }) } });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(commands(r.out), [`::error::Docker Hub did not set the description of example/raccoon-vtt (HTTP 422): ${escaped(detail)}`]);
    // An answer that is not JSON reaches the error line as text, cut short and escaped.
    const html = run({ patch: { status: 502, body: `<html>\n::warning::x${"y".repeat(400)}` } });
    const line = commands(html.out);
    assert.equal(line.length, 1, html.out);
    assert.ok(line[0]!.startsWith("::error::") && line[0]!.length < 450, line[0]);
  });

  test("warns, and still passes, when Docker Hub's answer does not show the text sent", () => {
    const r = run({ patch: { status: 200, body: JSON.stringify({ description: "something else", full_description: "" }) } });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(commands(r.out).map((l) => l.split("::")[1]), ["warning"], r.out);
  });

  test("refuses a short description Docker Hub would not take, before signing in", () => {
    for (const short of ["", "\n", `${"x".repeat(101)}\n`, "one\ntwo\n"]) {
      const r = run({ files: { [FULL]: "# Overview\n", [SHORT]: short } });
      assert.equal(r.status, 1, JSON.stringify(short));
      assert.equal(r.calls.length, 0, JSON.stringify(short));
      assert.match(commands(r.out)[0] ?? "", /DOCKERHUB-short\.txt must be one line of 1 to 100 characters/);
    }
    assert.equal(run({ files: { [FULL]: "# Overview\n", [SHORT]: `${"x".repeat(100)}\n` } }).status, 0);
  });

  test("refuses an overview longer than Docker Hub takes, before signing in", () => {
    const r = run({ files: { [FULL]: "x".repeat(25001), [SHORT]: "Short\n" } });
    assert.equal(r.status, 1, r.out);
    assert.equal(r.calls.length, 0);
    assert.deepEqual(commands(r.out), ["::error::selfhost/DOCKERHUB.md is 25001 bytes with the repository's address in its links, and Docker Hub takes at most 25000 for a full description."]);
    assert.equal(run({ files: { [FULL]: "x".repeat(25000), [SHORT]: "Short\n" } }).status, 0);
    // Counted with the address filled in, which is longer than the token.
    const grows = `${"x".repeat(25000 - TOKEN.length)}${TOKEN}`;
    const over = run({ files: { [FULL]: grows, [SHORT]: "Short\n" } });
    assert.equal(over.status, 1, over.out);
    assert.match(commands(over.out)[0] ?? "", new RegExp(`is ${25000 - TOKEN.length + REPOSITORY_URL.length} bytes`));
  });
});

describe("the Docker Hub overview", () => {
  const full = read(FULL);
  const short = read(SHORT);

  test("fits Docker Hub's limits, and its short description is the image's own", () => {
    assert.ok(Buffer.byteLength(full) <= 25000, `${FULL} is ${Buffer.byteLength(full)} bytes`);
    assert.match(short, /^[^\n]{1,100}\n$/, `${SHORT} must be one line of at most 100 characters`);
    const label = /org\.opencontainers\.image\.description="([^"]*)"/.exec(read("Dockerfile"))?.[1];
    assert.equal(short.trimEnd(), label, "the short description and the Dockerfile's description label say the same");
  });

  test("is plain markdown, as Docker Hub renders it, with no em dashes", () => {
    assert.ok(!/<[a-z!/]/i.test(full.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")), "HTML outside code");
    assert.ok(!full.includes("\u2014"), "an em dash");
  });

  test("links only to the repository, through {{REPOSITORY_URL}}, at files and headings that exist on its default branch", () => {
    const links = [...full.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
    assert.ok(links.length > 0);
    // No address of its own: the step fills in the repository's, so no committed file names its account.
    assert.ok(!/https?:\/\/(www\.)?github\.com/i.test(full), "a GitHub address written out");
    for (const link of links) {
      assert.ok(link === TOKEN || link.startsWith(`${TOKEN}/`), `a link off the repository: ${link}`);
      const file = /^\{\{REPOSITORY_URL\}\}\/blob\/main\/([^#]+)(?:#(.+))?$/.exec(link);
      if (!file) continue;
      assert.ok(existsSync(path.join(ROOT, file[1]!)), `the link to ${file[1]} names no file`);
      if (file[2]) {
        const slugs = read(file[1]!)
          .split("\n")
          .filter((l) => /^#{1,6} /.test(l))
          .map((l) => l.replace(/^#+ /, "").toLowerCase().replace(/[^\w\- ]/g, "").replaceAll(" ", "-"));
        assert.ok(slugs.includes(file[2]), `${file[1]} has no heading #${file[2]}`);
      }
    }
    for (const page of ["FEATURES.md", "docs/dm-guide.md", "LICENSE", "README.md#self-hosting-with-the-published-image"]) {
      assert.ok(links.includes(`${TOKEN}/blob/main/${page}`), `no link to ${page}`);
    }
    assert.ok(links.includes(`${TOKEN}/issues`), "no link to the issue tracker");
  });

  test("downloads the release's files with README.md's commands, the address aside", () => {
    const curls = (text: string) => text.split("\n").filter((l) => l.startsWith("curl -fsSLo "));
    assert.equal(curls(full).length, 2);
    // README.md leaves the address to the reader, and the overview gets it filled in.
    assert.deepEqual(curls(full).map((l) => l.replaceAll(TOKEN, "<this repository's URL>")), curls(read("README.md")));
    for (const line of curls(full)) assert.ok(line.includes(`"${TOKEN}/raw/$tag/selfhost/`), line);
  });
});

describe("the Docker Hub description workflow", () => {
  const workflow = read(WORKFLOW);
  const image = read(".github/workflows/image.yml");

  test("uses no action but actions/checkout, pinned as image.yml pins it", () => {
    const uses = (text: string) => [...text.matchAll(/^\s*-?\s*uses: (\S+)/gm)].map((m) => m[1]!);
    const checkout = uses(image).find((u) => u.startsWith("actions/checkout@"));
    assert.match(checkout ?? "", /^actions\/checkout@[0-9a-f]{40}$/);
    assert.deepEqual([...new Set(uses(workflow))], [checkout]);
  });

  test("runs by hand only, in the dockerhub environment, and no release runs it", () => {
    assert.match(workflow, /^ {4}environment: dockerhub$/m);
    assert.match(workflow, /^on:\n {2}workflow_dispatch:\n\n/m);
    assert.ok(!/^\s*uses: .*dockerhub-description/m.test(image), "image.yml runs the description workflow");
  });

  test("starts no Image build for a change to the overview's files alone", () => {
    // GitHub applies the paths in order, so each exclusion must follow selfhost/**.
    const paths = /^ {4}paths:\n((?: {6}.*\n)+)/m.exec(image)?.[1]?.split("\n").map((l) => l.trim()) ?? [];
    const include = paths.indexOf("- selfhost/**");
    assert.ok(include >= 0, "image.yml's paths no longer list selfhost/**");
    for (const file of [FULL, SHORT]) assert.ok(paths.indexOf(`- "!${file}"`) > include, `image.yml's paths do not exclude ${file}`);
  });

  test("signs in with the dockerhub environment's username and token, and no other secret", () => {
    const secrets = [...new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]!))].sort();
    assert.deepEqual(secrets, ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"]);
    assert.match(workflow, /missing="\$missing DOCKERHUB_TOKEN"/);
  });

  test("fills in the address of the run's own repository", () => {
    assert.match(workflow, /^ {10}REPOSITORY_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}$/m);
  });

  test("sets bash's strict mode and never turns on tracing", () => {
    const script = stepScript();
    assert.equal(script.split("\n")[0], "set -euo pipefail");
    assert.ok(!/set -[a-z]*x|set -o xtrace/.test(script));
  });

  test("reads the token only from jq's environment, and expands it in the shell only to scrub it from an error", () => {
    const lines = stepScript().split("\n");
    // jq is not stood in for, so this is how a token on jq's command line would show.
    assert.deepEqual(lines.filter((l) => l.includes("env.DOCKERHUB_TOKEN")).length, 1);
    assert.deepEqual(
      lines.filter((l) => /\$\{?DOCKERHUB_TOKEN/.test(l)).map((l) => l.trim()),
      ['[ -z "${DOCKERHUB_TOKEN:-}" ] || s=${s//"$DOCKERHUB_TOKEN"/***}'],
    );
  });
});
