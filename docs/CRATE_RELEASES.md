# Repository releases

## Prepare a release PR

```sh
bun run release
```

**One command prepares and opens the release PR.** It fetches `origin/main`,
creates an isolated worktree, and reads commits after the current `v*` release
tag. The caller's branch and uncommitted files stay in place. GitHub CLI (`gh`)
must be installed and authenticated for `pocket-nexus/pocketjs`.

The default bump follows Conventional Commits: `BREAKING CHANGE` or `!` selects
major, `feat` selects minor, and other changes select patch. For a `0.x` version,
an inferred breaking change selects minor; entering `1.0.0` requires an explicit
`major`. Override the level with `bun run release patch`, `minor`, or `major`.
npm and Cargo advance from their own current versions.

The command updates the framework, CLI and Hero versions, the Cargo workspace
version and internal dependency requirements, crate README install snippets,
and Cargo lockfiles including isolated fixtures. It checks the Bun lockfile
without upgrading dependencies, generates a changelog section from commit
subjects, and opens `chore(release): vX.Y.Z`. An existing open release PR is
returned instead of creating another one.

```sh
bun run release --dry-run
```

The preview uses the current committed `HEAD` and leaves its generated files
under `.pocket-build/validation/release-prepare/`. It does not push or open a PR.

**Merging the release PR into `main` starts publication.** The generated
`.github/release.json` records the versions and base commit. The existing
`release.yml` validates that record and the changelog, creates the version tag
on the merge commit, then continues through builds, validation, Rust publication,
npm publication and the GitHub Release. No second command or tag push is needed.

**The repository release publishes 14 Rust crates** listed in
`tools/release/publish-crates.ts`. The script reads each version from its Cargo
manifest. The npm and Rust version numbers can differ.

## First publication

Initial publication requires a crates.io API token with publish permissions for
the selected names. Configure the token with `cargo login`. Run from a clean
checkout of the source revision to publish:

```sh
bun tools/release/publish-crates.ts plan 0.1.0
bun tools/release/publish-crates.ts dry-run 0.1.0
bun tools/release/publish-crates.ts publish 0.1.0
```

The script uses the repository-pinned Rust toolchain. Cargo builds the packaged
sources, uploads packages in dependency order, and waits for index availability.
Registry lookup errors stop the release. A repeat invocation skips versions
present on crates.io; a yanked version requires a version bump.
The optional version argument requires all selected packages to match that
version. Omitting it uses the package versions in the tagged source tree.

crates.io permits an initial burst of five new crates per account, then one new
crate every ten minutes. Resume at the time reported by the registry when this
limit is reached. See [publishing rate limits](https://crates.io/docs/rate-limits).

## Trusted Publishing setup

After the first publication, add this GitHub Trusted Publisher in each crate's
crates.io **Settings → Trusted Publishing**:

| Field | Value |
| --- | --- |
| Repository owner | `pocket-nexus` |
| Repository name | `pocketjs` |
| Workflow filename | `release.yml` |
| Environment | Leave empty |

The workflow exchanges its GitHub OIDC identity for a short-lived crates.io
token through `rust-lang/crates-io-auth-action`. No Cargo token is stored in
GitHub secrets. See the [crates.io Trusted Publishing documentation](https://crates.io/docs/trusted-publishing).

## Retry a release

**Rust publication is a stage in `.github/workflows/release.yml`.** The existing
`v*` tag trigger and manual release dispatch also run the release identity check, SDK
and runtime builds, and release validation. The publish job then publishes Rust
crates before npm packages and the GitHub Release.

The Rust stage uses the Cargo versions from that release revision and skips
versions present on crates.io. To resume a release, rerun the failed workflow
in GitHub Actions. A manual dispatch must select the release tag as its ref:

```sh
gh workflow run release.yml --ref vX.Y.Z -f version=X.Y.Z
```

Package publication jobs are serialized and do not cancel a run that is
uploading packages.

Cargo verifies packaged sources during publication. The Rust stage adds no
test jobs or separate workflow.
