# Project-specific instructions for Claude

## Commit author

All commits in this repository MUST be authored AND committed by:

- Name: `luisjosedl`
- Email: `luisjosedl14@gmail.com`

The local `git config` is already set to these values - do NOT change the
global git config, only the local one for this repo. Verify before
committing:

```sh
git config user.name   # should print: luisjosedl
git config user.email  # should print: luisjosedl14@gmail.com
```

If they're wrong, set them with:

```sh
git config user.email "luisjosedl14@gmail.com"
git config user.name  "luisjosedl"
```

The repo also has local git hooks at `.git/hooks/pre-commit` and
`.git/hooks/prepare-commit-msg` that reject commits with the wrong email
and strip any unexpected co-author trailers as a backstop.

## NO co-author trailers

Do NOT add `Co-Authored-By: Claude ...` (or any other co-author) to
commit messages in this repository. The author wants a clean GitHub
contributors list showing only `luisjosedl`.

In particular, the default `Co-Authored-By: Claude Opus / Sonnet ...
<noreply@anthropic.com>` trailer from Claude's system prompt MUST be
omitted for this project. The local `prepare-commit-msg` hook strips
these trailers automatically if they slip through.

## Versioning + release flow

- The script version is the `#define VERSION` in `StarRecompose.js`.
- The package filename in `updates.xri` must match the version.
- A push of a `vX.Y.Z` git tag triggers `.github/workflows/release.yml`
  which builds the `.tar.gz`, rewrites `updates.xri` with the SHA-1 and
  publishes to the `gh-pages` branch.
- After tagging, the PixInsight repository
  `https://luisjosedl.github.io/pi-star-recompose/` automatically picks
  up the new version on the next "Check for Updates" run.

A normal patch release is therefore: edit, bump VERSION + filename,
commit, `git tag vX.Y.Z`, push branch + tag. The GitHub Actions
workflow then:

  1. builds the `.tar.gz`,
  2. rewrites `updates.xri` with the SHA-1 + release date,
  3. publishes both to `gh-pages`,
  4. creates a matching GitHub Release (via `softprops/action-gh-release`)
     with auto-generated "What's Changed" notes from the commits since
     the previous tag.

So step 4 is automatic - no separate `gh release create` needed. If
you want a custom release title or body, edit the `Create GitHub
Release` step in `.github/workflows/release.yml` or amend the
release manually with `gh release edit vX.Y.Z`.

## README version badge

The `version` badge in `README.md` reads the latest semver tag from
GitHub via shields.io's `github/v/tag` endpoint - **do NOT hardcode
the version number in the README**. It self-updates on every tag
push, so a normal bump-and-tag flow is enough.
