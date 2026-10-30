# Contributing

RaccoonVTT is a self-hosted virtual tabletop for D&D groups playing the 2024
rules, made for phones first. See the README's
[Local development](README.md#local-development) section to run it locally.

Before opening a pull request, run:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:int
pnpm test:e2e
```

The integration and browser tests need the development database described in
the README. Run them separately. Browser tests also need Google Chrome.
For container or backup changes, run `pnpm test:backup` too.

Use Conventional Commits, as in `git log`: one line, lowercase after the
colon, with an optional lowercase scope. For example,
`fix(ui): keep the menu in view`. Every change is reviewed before it merges.
Describe what changed, why, and how you checked it. Include screenshots for
visible changes.

Contributions are licensed under AGPL-3.0-only, like the project's code.
Art must be openly licensed and credited in [CREDITS.md](CREDITS.md).
Do not contribute AI-generated art.
