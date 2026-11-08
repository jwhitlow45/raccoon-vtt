# Releasing

How a maintainer cuts a release: the version bump, the changelog, the tag,
the Image workflow that builds, signs and publishes the image, the signed
assets on the GitHub Release, and the Docker Hub overview.

## Releasing

For maintainers. The image is built and pushed to Docker Hub only by GitHub
Actions, in [`.github/workflows/image.yml`](../.github/workflows/image.yml),
never from a laptop.

The Node image is pinned in `Dockerfile`'s `ARG NODE_IMAGE` and is updated by hand.

Once, before the first tag, create the repository `raccoon-vtt` on Docker
Hub under the namespace the image uses, and make it public. A repository
that a push creates takes the account's default visibility, which can be
private, and hosts could not pull it. The workflow also counts a version
as absent only when Docker Hub answers "not found", which needs the
repository to exist.

1. On main, bump `version` in `package.json` to the new `X.Y.Z` and run
   `pnpm selfhost`, which writes the new `X.Y` into `selfhost/`, and
   `pnpm readme-button`, which draws the new version into the Docker Hub
   button at the top of the README (it needs Chrome). Then, in the
   [update notes](self-hosting.md#update-notes), add the release's row to
   the top of the table, with `SNAPSHOT_VERSION` and `OP_VERSION` from
   `shared/migrate.ts`, rename the **Since** group, named for the release
   before, to **vX.Y.Z**, and open a new **Since vX.Y.Z** group above it.
2. Regenerate the changelog before tagging. Replace `X.Y.Z` with the new
   version:

   ```sh
   docker run --rm -v "$PWD:/app" -w /app ghcr.io/orhun/git-cliff/git-cliff:2.14.2 --config cliff.toml --tag vX.Y.Z -o CHANGELOG.md
   ```

   Leave out Docker's `--user` flag. The image's entrypoint already writes
   the file as the owner of the mounted folder, and `--user` makes it fail
   with a `setpriv` error on a Mac.

   Commit the version bump and all generated files, including CHANGELOG.md.
   Unit tests fail while the generated files or newest released changelog
   heading are out of date.
3. Wait for CI to pass on that commit.
4. Tag the commit with a signed tag, `git tag -s vX.Y.Z -m vX.Y.Z`, and
   push the tag. GitHub then shows the tag as Verified.

The tag starts the Image workflow. It checks that the tag matches
`package.json`, that the commit is on main and that CI passed on that exact
commit, and builds the arm64 image on an arm64 runner. Then the publish
job waits for a reviewer to approve the `dockerhub` environment on the
run's page, once. After the approval it builds the amd64 image and runs
the smoke test (`selfhost/smoke-test.sh`): the image comes up healthy with
`selfhost/compose.yml`, and the files its services mount match `docker/`
byte for byte. It then pushes amd64 and arm64 from the same build, checks
that the amd64 image pushed is the one it tested, and signs the
multi-architecture digest with Cosign, retrying up to three times, before
tagging `X.Y.Z` or moving `X.Y` and `latest`. After publication succeeds,
a read-only job generates the release notes, and a separate job creates the
GitHub Release.
An existing GitHub Release is left unchanged on a rerun. Last, the
[Release assets](#release-assets) workflow signs the source archive and
the SBOM and attaches them to the release with their provenance.

Tags only move forward, by what Docker Hub holds. A release always tags
`X.Y.Z`. It moves `X.Y` and `latest` only when that tag does not exist yet
or holds this release or an older one, and otherwise leaves it with a
warning naming the version it keeps. So a patch to an older minor, an
older release that finishes last, or a re-run of an older one never moves a
host back, and a tag whose release failed holds nothing back.

A version already on Docker Hub is never rebuilt or replaced: to change
one, release the next patch. The one exception is a run that pushed
`X.Y.Z` and then stopped before `X.Y` or `latest`. Run it again: it finds
`X.Y.Z` from the same commit, signs that digest and adds the floating tags.
If signing exhausts retries before `X.Y.Z` exists, no tag moves and a rerun rebuilds.
A run that finds `X.Y.Z` from another commit refuses.

Releases run one at a time, so push one tag at a time and let its run
finish before you push the next. GitHub keeps only one run waiting for the
slot, and a release waiting behind another is cancelled when a third
arrives.

The `dockerhub` environment, in the repository's settings, holds the
secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub personal
access token, with the permission that
[The Docker Hub overview](#the-docker-hub-overview) names), admits only
`v*` tags and has a required reviewer. A `DOCKERHUB_NAMESPACE` variable
there publishes under another namespace than the username. A push to a
`ci/` branch that changes the image or `selfhost/`, and a run of Image
started by hand from the Actions tab, build and smoke-test without pushing.

### Release assets

Every GitHub Release carries its source and an SBOM, each signed, and their
build provenance, from
[`.github/workflows/release-assets.yml`](../.github/workflows/release-assets.yml):

| Asset | What it is |
| --- | --- |
| `raccoon-vtt-X.Y.Z.tar.gz` | The tag's files, from `git archive`, in a folder `raccoon-vtt-X.Y.Z/` |
| `raccoon-vtt-X.Y.Z.cdx.json` | A CycloneDX SBOM of every package in the tag's `pnpm-lock.yaml`, from `pnpm sbom`. It includes devDependencies, since the client bundle ships some of them |
| `raccoon-vtt-X.Y.Z.tar.gz.sigstore.json` | The archive's keyless Cosign signature, as a Sigstore bundle |
| `raccoon-vtt-X.Y.Z.cdx.json.sigstore.json` | The SBOM's keyless Cosign signature, as a Sigstore bundle |
| `raccoon-vtt-X.Y.Z.intoto.jsonl` | SLSA build provenance for the archive and the SBOM: an in-toto statement signed by GitHub's artifact attestations, as a Sigstore bundle |

The Image workflow runs Release assets once it has created the release, so
the assets never hold up Docker Hub. For a release that lacks them, such as
one made before the workflow existed or one whose run failed to sign, run it
by hand:

1. In the Actions tab, open Release assets and choose Run workflow.
2. Leave "Use workflow from" on `main`, enter the release's tag (`vX.Y.Z`)
   and run it.

It needs no approval, has no Docker Hub secrets and never touches Docker
Hub. It only adds to a release: one that has all five assets is left as it
is, and one that has only some of them is refused, so an asset is never
replaced. To redo a release's assets, delete them on the release's page
first.

The assets are uploaded after the release is published, because the Image
workflow creates the release already published (never as a draft) and
Release assets reads it by its tag, which GitHub shows for a published
release only. If GitHub's immutable releases setting is turned on later, a
published release takes no new assets, so the upload would fail. Releasing
would then need a change to both workflows, not only a manual step: Image
would create the release as a draft, Release assets would find it among the
draft releases (which its read-only check job may not be allowed to list)
and Image would publish it after. Until then, do not turn that setting on.

Release assets runs in separate jobs, each with only what it needs. One
holds the checkout and makes the archive, using only GitHub's own actions.
A second, with no token, makes the SBOM from the lockfile inside that
archive, so the package manager never runs beside the checkout or the
signing and upload permissions. The signing and upload jobs download each
job's artifact into a folder of its own and take each asset by name from
the job that made it: the archive from the first, the SBOM from the
second, the signatures and provenance from the signing job. An artifact
that holds anything else, a symlink or too few files is refused, so the
SBOM job cannot put an archive of its own in place of the signed one. A job
with no token can still replace a whole artifact, so the archive must also
match the SHA-256 digest the first job gave as a job output, and the upload
job checks the SBOM against the digest of the one the signing job signed.

The provenance comes from GitHub's artifact attestations
(`actions/attest-build-provenance`) rather than the SLSA project's
`slsa-github-generator`, since that generator works only when a workflow
refers to it by tag, and OpenSSF Scorecard counts such a reference as an
unpinned dependency. So `slsa-verifier`, which checks the generator's
format, cannot check it. Use the GitHub CLI.

The provenance's SLSA predicate is the one GitHub writes for a workflow
run, with one addition. GitHub's lists the run's own ref and commit as the
build's source, and for assets added by hand that is `main`, not the tag
whose files the archive holds. So where the tag's commit is not the run's,
the predicate lists it too, as a second source in `resolvedDependencies`.

#### Verify a release's assets

With [Cosign v3 or later](https://docs.sigstore.dev/cosign/verifying/verify/),
check each file against its signature and the workflow that signed it.
Replace `X.Y.Z` with the release version:

```sh
cosign verify-blob raccoon-vtt-X.Y.Z.tar.gz \
  --bundle raccoon-vtt-X.Y.Z.tar.gz.sigstore.json \
  --certificate-identity 'https://github.com/jwhitlow45/raccoon-vtt/.github/workflows/release-assets.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-blob raccoon-vtt-X.Y.Z.cdx.json \
  --bundle raccoon-vtt-X.Y.Z.cdx.json.sigstore.json \
  --certificate-identity 'https://github.com/jwhitlow45/raccoon-vtt/.github/workflows/release-assets.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

A hand run signs from `main`, so for the assets it adds the identity ends
in `@refs/heads/main` instead. A hand run for v0.1.0 or v0.2.0, released
before this workflow existed, gives them assets signed this way. The
provenance of a hand run names `main` as the workflow that ran and as the
builder, and lists the tag's own commit as a second source (see below).

With the [GitHub CLI](https://cli.github.com/manual/gh_attestation_verify),
check the provenance of each file against the workflow that signed it, at
the tag. It reads the attestation from the release's `.intoto.jsonl`, or
from GitHub when `--bundle` is left out:

```sh
gh attestation verify raccoon-vtt-X.Y.Z.tar.gz \
  --bundle raccoon-vtt-X.Y.Z.intoto.jsonl \
  --repo jwhitlow45/raccoon-vtt \
  --cert-identity 'https://github.com/jwhitlow45/raccoon-vtt/.github/workflows/release-assets.yml@refs/tags/vX.Y.Z'
gh attestation verify raccoon-vtt-X.Y.Z.cdx.json \
  --bundle raccoon-vtt-X.Y.Z.intoto.jsonl \
  --repo jwhitlow45/raccoon-vtt \
  --cert-identity 'https://github.com/jwhitlow45/raccoon-vtt/.github/workflows/release-assets.yml@refs/tags/vX.Y.Z'
```

As with Cosign, for assets added by hand the identity ends in
`@refs/heads/main` instead.

To see which commit the archive and the SBOM were made from, print the
sources the provenance lists and compare the last one's `gitCommit` with
the tag's commit:

```sh
gh attestation verify raccoon-vtt-X.Y.Z.tar.gz \
  --bundle raccoon-vtt-X.Y.Z.intoto.jsonl \
  --repo "${repo#github.com/}" \
  --cert-identity "https://$repo/.github/workflows/release-assets.yml@refs/tags/vX.Y.Z" \
  --format json \
  --jq '.[].verificationResult.statement.predicate.buildDefinition.resolvedDependencies'
git rev-parse 'vX.Y.Z^{commit}'
```

A release's own run lists one source, the tag. Assets added by hand list
two: `main`, whose workflow ran, then the tag. The signing certificate, and
`gh`'s `--cert-identity`, `--source-ref` and `--source-digest` checks,
which read it, name the run's ref and commit, so for those assets they
name `main`. The predicate is written by the signing workflow itself, and
the certificate ties it to that workflow, so it can be trusted as far as
that workflow can.

### The Docker Hub overview

The Docker Hub repository's overview comes from
[`selfhost/DOCKERHUB.md`](../selfhost/DOCKERHUB.md), and its short description
from `selfhost/DOCKERHUB-short.txt`, which says the same as the
Dockerfile's description label (a unit test checks that). A release does
not send them. Send them by hand whenever either file changes:

1. Release the change as usual, so a `vX.Y.Z` tag carries it.
2. In the Actions tab, open Docker Hub description
   ([`.github/workflows/dockerhub-description.yml`](../.github/workflows/dockerhub-description.yml)),
   choose Run workflow, and pick that tag under "Use workflow from".
3. Approve the `dockerhub` environment on the run's page, once.

It sends the two files as they are at that tag, with this repository's
address filled into the overview's links. The environment refuses a run on
a branch, so a fix to the overview reaches Docker Hub only once a release
tag carries it.

It signs in with the same `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as a
release, so that token needs the Repo Read, Write, Delete permission.
Pushing images needs only Read & Write, but changing a repository's
description takes Read, Write, Delete. With less, Docker Hub may refuse the
change, and the run's error names the permission.
