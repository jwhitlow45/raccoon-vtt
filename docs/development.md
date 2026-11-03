# Development

How to run RaccoonVTT from a copy of the repository, the checks a change
must pass, the coding standards, and how continuous integration runs them.
To run it on a server instead, see [self-hosting.md](self-hosting.md).

## Local development

You need Node 24.7 or later, Docker, and pnpm through corepack
(`corepack enable` once). `package.json` pins the pnpm version.

```bash
pnpm install
pnpm db:up                  # postgres in docker, on 127.0.0.1:5434
cp .env.example .env.local
pnpm dev                    # http://localhost:5173
```

`pnpm dev` runs the API server with `--watch` and Vite in one terminal. Vite
proxies `/api` and `/ws` to the server, so the browser sees one origin, as it
does in production. The schema applies itself on the first connection, so
there is no migration step.

Postgres listens on 5434, not the usual 5432, so it can run beside a
postgres already on your machine. `RACCOON_DB_PORT` overrides it. The API
server listens on 3000, and `PORT` in `.env.local` moves it. Vite's proxy
follows `PORT`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | API server and Vite, with reload |
| `pnpm dev:db` | `pnpm db:up`, then `pnpm dev` |
| `pnpm typecheck` | `tsc --noEmit` for the server and the client |
| `pnpm test` | unit tests (`*.test.ts`) |
| `pnpm test:int` | integration tests against the dev postgres (`*.itest.ts`). Run `pnpm db:up` first |
| `pnpm test:e2e` | builds the client, then runs the browser tests (`e2e/*.e2e.ts`) against a server on port 3100 (`E2E_PORT`) and the dev postgres, one file at a time as a single shard of [continuous integration](#continuous-integration): the join limits' counts are cleared before each file, and a failing file runs once more. Needs Google Chrome installed. Screenshots go to `test-results/e2e-screenshots` (gitignored), or to the folder in `E2E_SCREENSHOT_DIR`, and `E2E_SCREENSHOT_DIR=0` takes none. Run it alone, not beside `pnpm test:int`, since both use the same database |
| `pnpm test:e2e:shard <index> <count>` | one shard of the browser tests, as [continuous integration](#continuous-integration) runs them. Run `pnpm build` first |
| `pnpm coverage` | line coverage of the unit and integration tests, with no new dependency. See [Coverage](#coverage). Needs `DATABASE_URL` set to a database the integration tests may use |
| `pnpm build` | the client into `dist/` |
| `pnpm db:psql` | a psql shell in the dev postgres |
| `pnpm db:down` | stop the dev postgres, keeping its data |
| `pnpm db:reset` | drop the dev database volume and start fresh |
| `pnpm admin <command>` | the [admin commands](operations.md#admin-commands), against the dev database |
| `pnpm test:backup` | the backup check (`scripts/backup-check.ts`): `docker/backup.sh` through its compose services, in a compose project and postgres of its own (port 5235). Needs Docker, takes about 5 minutes. Run it before a release that touches backups |

`docker compose up --build raccoon` builds the production image from this
checkout and runs it against the dev postgres, on http://127.0.0.1:9180, as
the [Quick start](../README.md#quick-start) runs the published one. It is how to try a
build before it goes to a server.

### Coverage

`pnpm coverage` runs the unit tests, then the integration tests, with Node's built-in coverage (`--experimental-test-coverage`) and prints the share of lines run for `server`, `shared`, `client` and `scripts`, and one figure for the shipped code. Shipped code is `server`, `shared` and `client`, which is what runs in the image or the browser. `scripts` is build and release tooling that does not ship, so it is reported on its own and left out of that figure. The browser tests are not measured.

Node's report lists only the files a test loaded, so a shipped file that no test imports would add nothing and hide its gap. The script therefore lists the tracked `.ts` and `.tsx` files in `server`, `shared` and `client` with `git ls-files` and adds each one the report left out, with all its lines at zero. Node counts every physical line of a loaded file, blank lines and comments included, so an unloaded file is counted the same way. A line that Node never reported for a loaded file stays uncounted.

Test files (`*.test.ts`, `*.itest.ts`) and test infrastructure are left out whether a test loaded them or not. Test infrastructure is found by name in `scripts/coverage.ts`: a file ending in `Testing`, `Testutil` or `Testkit` (as in `shared/testutil.ts`, `shared/perPlayerTestutil.ts`, `server/rooms/undoTesting.ts`, `client/features/dice/abilityMenu.testing.ts`), and anything under `client/components/testing/`. A new helper named that way is left out with no further step. A few helpers have other names and are listed by hand (`server/assets/testApp.ts`, `server/assets/testImages.ts`, `shared/rules/testWorld.ts`, `shared/differential.ts`), as are the development-only room in `client/dev/` and its fixture, which the production bundle drops. Name a new helper to match, or add it to that list, or it counts as shipped code. A listed file that no longer exists fails the script's own test.

### Property tests

Some unit tests are property tests, written with
[fast-check](https://fast-check.dev/) in files named `*.prop.test.ts`. Each
states a rule that must hold for every input, such as "the dice parser never
throws, and every formula it accepts is within the grammar's bounds", and
checks it against thousands of generated inputs: any text in the Dice field
and in a journal page, Universal VTT files and D&D Beyond characters with
edits a broken exporter or a hostile sender could make, protocol messages
past every bound, and random wall geometry. When a case breaks the rule,
fast-check shrinks it to a small counterexample and prints it with the seed
that found it.

`pnpm test` runs them on a fixed seed, so every run tries the same cases and
a failure in continuous integration fails the same way on your machine. Two
environment variables widen the search when you work on one of these areas:

| Variable | What it does |
| --- | --- |
| `FC_SEED` | another seed, for cases the default run never tries |
| `FC_RUNS` | how many cases each property tries, in place of its own count |

```bash
FC_SEED=7 FC_RUNS=20000 node --test shared/dice/dice.prop.test.ts
```

To replay a failure, run its file again with the seed fast-check printed.
The `*.random.test.ts` files are seeded random tests of the same idea, with
generators of their own.

## Coding standards

The code is TypeScript throughout: the server, the shared rules, the
scripts and the React client. Contributions are expected to follow these
standards, and most of them are checked for you.

These are checked on every change, by `pnpm typecheck`, by the tests and
by CodeQL, so a change that breaks one fails CI:

- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess` and
  `noFallthroughCasesInSwitch` are on in
  [`tsconfig.base.json`](../tsconfig.base.json), and any type error fails
  the build.
- **Erasable syntax only.** Node runs the server's `.ts` files directly by
  stripping their types, so the code uses no enums, no namespaces that hold
  code, no parameter properties and no decorators. `erasableSyntaxOnly`
  turns each of these into a type error.
- **Explicit imports.** A relative import names its file with its
  extension, or uses the `#shared/` and `#server/` paths from
  `package.json`. The server's typecheck refuses one without, for every
  file outside `client/`, and the client follows the same rule. A type-only
  import is written `import type` (`verbatimModuleSyntax`).
- **Parameterized SQL.** Queries take their values as parameters (`$1`,
  `$2`), never as text pasted into the SQL. CodeQL's injection queries look
  for the second kind.
- **Straight apostrophes** in the client's words, checked by
  `client/lib/straightApostrophes.test.ts`.
- **Layout** follows [`.editorconfig`](../.editorconfig): UTF-8, LF line
  endings, a final newline, space indents and no trailing spaces outside
  Markdown, checked for every file in the repository by
  `scripts/editorconfig.test.ts`. Editors that read `.editorconfig` apply it
  as you type.

These are conventions that review looks for:

- **Validate at the edge.** Anything that comes from outside the server is
  checked by a zod schema with explicit bounds, in
  [`shared/protocol.ts`](../shared/protocol.ts) for messages and ops,
  before it is used.
- **Comments say why.** Name things so the code says what it does, and
  keep comments for the reasons, the limits and the surprises.
- **Client styling** is inline, from the tokens in
  [`client/lib/theme.ts`](../client/lib/theme.ts).
- **Words** in comments, docs and the app are plain American English, with
  no em dashes and as few semicolons as you can manage.

## Continuous integration

GitHub Actions runs [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
on every push to `main` or to a branch under `ci/`, on pull requests to
`main`, and by hand from the Actions tab. It needs no secrets and deploys
nothing.

A pull request from one of this repository's own `ci/` branches skips
every job, since the push run on the same commit already runs them all. A
pull request from anywhere else, such as Dependabot's, runs everything.

The **CI passed** job is the one status check `main`'s ruleset requires.
It runs after every other job, however they ended, and fails unless each
one passed or was skipped by the workflow's own design: **e2e-macos**
while its list is empty or on a docs-only push, and every job in a pull
request from one of this repository's `ci/` branches. In that pull request
it is named **Tested by the push run** instead, so the only **CI passed**
on the commit is the push run's, which ran the jobs. GitHub counts a skipped job as passed for a
required check, and two checks with one name on a commit leave the result
ambiguous.

[CodeQL](../.github/workflows/codeql.yml) scans code on main and pull requests.
[OpenSSF Scorecard](../.github/workflows/scorecard.yml) checks repository security
on main. Both also run weekly. [Dependabot](../.github/dependabot.yml) proposes
weekly grouped updates after a 14-day cooldown. The Image workflow's Release
step publishes a GitHub Release only after its signed image and tags have
been published successfully, and
[Release assets](../.github/workflows/release-assets.yml) then attaches the
signed source archive, SBOM and build provenance
([docs/releasing.md](releasing.md#release-assets)).

These jobs run on Ubuntu:

- **build**: `pnpm build` once, kept for the e2e shards.
- **typecheck-int**: `pnpm typecheck` and `pnpm test:int`, the second
  against a postgres service container like the one in `docker-compose.yml`.
- **unit**: `pnpm test`, which needs no database.
- **e2e**, 14 shards at once: each shard installs, downloads the build,
  gets a postgres service container of its own and runs its share of
  `e2e/*.e2e.ts`, one file at a time, in Google Chrome.
- **CI passed**: every other job's result, as one check (above).

A push to a `ci/` branch whose merge base is `main`'s tip, and that
changes only docs against it, runs just the typecheck, the unit tests, the
build and `e2e/guide.e2e.ts`, which draws the DM guide from `docs/`, and
still ends green, so the deploy gate takes it. The docs are the Markdown
files, pictures and Excalidraw sources under `docs/`, and the Markdown
files at the repository's root (`scripts/ci-scope.ts`). Anything else may
reach the app, its image or its tests. Any other push, a branch behind
`main` among them, and every push to `main`, runs everything.

The app draws its text in Inter, which it serves itself from
`public/fonts/`, so a page lays out the same on the Linux shards as on a
phone or a Mac. Each shard still installs Roboto, Ubuntu's package taken
from its archive by its checksum, and makes it the system font with
`e2e/fonts.conf`, as the fallback font. It draws only before
Inter loads and for the few characters Inter's subset lacks, as on an
Android phone. A file that still fails on Linux from font metrics alone,
and cannot be made tolerant without losing what it guards, goes in
`e2e/macos-only.json` with the reason. The Linux shards leave those files
out, and an **e2e-macos** job runs them on a Mac. The list is empty, and
the macOS job runs only when it is not.

A newer push to a `ci/` branch cancels that branch's run in progress. Every
push to `main` runs to the end, so each commit there is tested. A failing
e2e file runs once more, and its shard fails only if the rerun fails too. A
file that passed only on its rerun shows as a warning on the run. A shard
that failed, was cancelled or reran keeps its logs and screenshots as an
artifact for two weeks.

Each shard has a deadline 5 minutes inside its job's time limit
(`--deadline`). A run's limit leaves time for a rerun and for the files
after it, a rerun that would not fit is skipped, and the shard reports
what ran either way. So a file that hangs every time still fails with its
logs kept, rather than the job being cut off.

`scripts/e2e-shard.ts` decides which files each shard runs, by the times in
`e2e/durations.json`: the longest file first, each onto the shard with the
least time so far. A file missing there counts as `defaultSeconds`. Each
shard prints the time every file took. After a file grows or a new one
lands, rewrite the list from a few green runs with
`node scripts/e2e-durations.ts <run id> ...`, which reads those times
through `gh`. The list holds CI seconds, the largest of the runs given, and
the shard count is chosen so the longest shard plans about 8 minutes. A run
is 18 jobs and peaks at 16 at once, of the account's 20 Linux jobs, so a
second run that overlaps it queues part of its shards.

A file that takes much over 5 minutes in CI holds its shard up, so a long
one is split into files that each build their own room from a module they
share, as `e2e/alignmentRoom.ts` does for the alignment sweep's five files,
`e2e/barrestRoom.ts` for the resting bar's four and `e2e/tokenpanelRoom.ts`
for the token panel's four. The new alignment and token-panel splits have
initial planning estimates in `e2e/durations.json`, pending measured CI
times. Keep every test when splitting and check each resulting file stays
under five minutes.

A shard runs on a laptop too, against the dev postgres. Build first, then
give the shard's number and the shard count. `--list` prints what every
shard would run, without running it. On a Mac a shard includes the files
of `e2e/macos-only.json`, and `--macos-only` shards only those.

```bash
pnpm build
pnpm test:e2e:shard 1 3
pnpm test:e2e:shard 1 3 --list
```

It reads `E2E_PORT`, `DATABASE_URL` and `E2E_SCREENSHOT_DIR` as
`pnpm test:e2e` does. Each file's output also goes to
`test-results/e2e-logs`, and its screenshots to a folder of its own. Shards
can run side by side on one machine when each has its own database and its
own `E2E_PORT`, at least 30 apart: a file uses ports up to `E2E_PORT` plus
29, and the join limits count every run from one address in the database.
On macOS, reserve port 7000 for AirPlay Receiver. Choose a whole 30-port
range that excludes it, such as 7010 to 7039 with `E2E_PORT=7010`, then
7040 to 7069 with `E2E_PORT=7040`. Bases from 6971 through 7000 include
port 7000 and must be skipped. Lane briefs should reserve those whole
ranges too.

## Rebuilding with a changed MP3 encoder

The browser encodes a DM's sound files with `@breezystack/lamejs`, which is
under the GNU Lesser General Public License v3.0. The build keeps it in a
chunk of its own and puts its license texts beside that chunk
(`client/features/sound/upload/licenses/`), so anyone who gets the app can
swap in a changed copy of the library. To do so, point the dependency at
your copy in `package.json` (a `file:` path or your own published version),
run `pnpm install`, then `pnpm build`. The build writes the library as
`assets/lamejs-<hash>.js`, and the encode worker loads that file, so the
new build uses your copy. The encoder runs only in the DM's browser, when a
file is not already a suitable MP3, and `pnpm test` checks that its output
still passes the server's frame check.

## Building for another architecture

The server builds its own image, for its own CPU architecture. This is
only for trying another architecture's image on your own machine, for
example linux/amd64 on an Apple Silicon Mac:

```bash
docker buildx build --platform linux/amd64 -t raccoon-vtt:amd64 --load .
```

The client build runs natively and only the production dependency install
runs under emulation. pnpm installs the native packages that match the
target, so the image gets `@img/sharp-linux-x64` and
`@node-rs/argon2-linux-x64-gnu`.
