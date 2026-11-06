# Contributing

RaccoonVTT is a self-hosted virtual tabletop for D&D groups playing the 2024
rules, made for phones first. See
[Local development](docs/development.md#local-development) in
docs/development.md to run it locally.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
[GOVERNANCE.md](GOVERNANCE.md) explains how decisions are made and who
does what, and [ROADMAP.md](ROADMAP.md) says where the project is heading.

Before opening a pull request, run:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:int
pnpm test:e2e
```

The integration and browser tests need the development database described in
docs/development.md. Run them separately. Browser tests also need Google Chrome.
For container or backup changes, run `pnpm test:backup` too.

Every new feature and every bug fix must add tests to the automated
suite: at least one that fails without the change, in the unit,
integration or browser (e2e) suite that suits it. A pull request without
them is not merged.

Code follows the [coding standards](docs/development.md#coding-standards)
in docs/development.md. The typecheck, the tests and CodeQL enforce many
of them.

Docs follow [Writing the docs](docs/writing.md). Update FEATURES.md in the
same change that adds, changes or removes a feature, and the
[DM guide](docs/dm-guide.md) too when a change alters a step it describes.

Use Conventional Commits, as in `git log`: one line, lowercase after the
colon, with an optional lowercase scope. For example,
`fix(ui): keep the menu in view`. Every change is reviewed before it merges.
Describe what changed, why, and how you checked it. Include screenshots for
visible changes.

Contributions are licensed under AGPL-3.0-only, like the project's code.
By opening a pull request you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/)
for it: that you wrote the change, or otherwise have the right to submit
it under that license. The pull request template asks you to confirm
this, so commits need no `Signed-off-by` line.

Art must be openly licensed and credited in [CREDITS.md](CREDITS.md).
Do not contribute AI-generated art.
