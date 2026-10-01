---
name: pocketjs-release
description: Ship a PocketJS release — version bumps, changelog, npm publish via the tag-triggered trusted-publishing workflow, site deploy, and post-release verification. Use when asked to release, publish to npm, cut a version, or when a merged feature set needs to reach users.
---

# PocketJS Release

## Overview

A release is one tag push. `.github/workflows/release.yml` publishes
`@pocketjs/framework` (repo root) and `@pocketjs/cli` (`tools/cli/`) to npm via
**trusted publishing (OIDC)** — no tokens, provenance attached — skipping any
version already on the registry (safe to re-run). The site deploys separately
on every `main` push (`deploy.yml`).

## Standard workflow

1. **Version bumps (in the feature PR, before merge).** Set the same version
   in `package.json`, `tools/cli/package.json`, AND `pocket.json` — the release
   gate (`tools/release-check.ts`) verifies all three authorities agree
   with the tag. Semver within 0.x: breaking changes (e.g. a bin rename)
   and feature sets bump the minor; docs-only fixes ride the next release
   rather than getting their own.
2. **Changelog (same PR).** Add the `## X.Y.Z — <Month D, YYYY>` entry at the
   top of `site/content/changelog.md`: one bold thesis line, then bullets
   grouped by capability, linking the blog deep-dive when one exists. Mark
   breaking changes explicitly (`**Breaking:** …`). This renders at
   `/changelog/` on deploy — never list an unreleased version.
3. **Validate before merge** (all must pass):

```bash
bun run test && bun tests/golden.ts && bun run tape:check
cargo test --manifest-path engine/core/Cargo.toml
bunx tsc --noEmit
bun tests/e2e/ppsspp.ts        # when hosts/psp/ or engine/core/ changed
bun tools/psp.ts hero        # cross-compile check when hosts/psp/ changed
```

4. **Merge.** Draft PR → `gh pr ready <n>` → `gh pr merge <n> --squash`
   (Conventional Commits title; the squash commit becomes the release
   commit). Do NOT pass `--delete-branch`: `main` is checked out at
   `~/code/pocketjs`, so the local delete fails — GitHub prunes the remote
   branch itself after squash merges (verify with
   `git ls-remote origin <branch>`).
5. **Tag = publish.** The workflow publishes both npm packages and then
   creates the **GitHub Release** itself (`tools/release-notes.ts` turns
   the version's changelog entry into the notes; the bold thesis becomes
   the title). No entry in `site/content/changelog.md` → the release step
   fails, so step 2 is load-bearing.

```bash
git fetch origin main
git tag vX.Y.Z <merge-sha> && git push origin vX.Y.Z
gh run list --limit 3          # expect: Release to npm (tag) + Deploy (main)
gh run watch <release-run-id> --exit-status
```

6. **Verify the artifacts, not the workflow:**

```bash
npm view @pocketjs/framework version && npm view @pocketjs/cli version
npm view @pocketjs/cli dist.attestations.url        # provenance present
cd "$(mktemp -d)" && npm i -g @pocketjs/cli && pocket --help   # bin smoke
curl -s https://pocketjs.dev/changelog/ | grep -o "X\.Y\.Z" | head -1
gh release list --limit 2      # GitHub Release exists and is marked Latest
```

## Gotchas

- **Trusted publishing needs npm ≥ 11.5.1** — the workflow runs
  `npm install -g npm@latest` (Node 22 bundles 10.x). Never add
  `registry-url` to setup-node (its .npmrc token placeholder breaks
  tokenless publishes). `permissions: id-token: write` is required.
- Each package's npm **Trusted Publisher** config names org `pocket-nexus`,
  repo `pocketjs`, workflow `release.yml`, no environment. A NEW package
  can't use it for its first publish — bootstrap locally with
  `npm publish --access public --otp=…` (account 2FA is auth-and-writes),
  then configure the trusted publisher.
- The publish steps guard with `npm view "$name@$version"` — pushing a tag
  where one package's version already exists publishes only the other.
- The framework tarball ships gitignored build output (`hosts/web/
  pocketjs.wasm`) because the `files` whitelist wins over .gitignore; CI
  builds it (`bun tools/wasm.ts`) before publishing. Check tarball
  contents with `npm pack --dry-run` if `files` changed.
- Blog posts register in `site/nav.ts` `BLOG_POSTS` (the .md alone doesn't
  render); landing nav lives in `site/home.html`, docs nav in
  `site/templates.ts` — three separate places.
- Version history: bootstrap 0.2.0 was published locally; 0.2.1 was the
  first tokenless CI release; 0.3.0 renamed the CLI bin to `pocket`.
