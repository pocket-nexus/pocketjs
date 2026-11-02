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

**An exact version sets the npm packages and Cargo workspace to that version.** Pre-release
versions such as `0.16.0-beta.1` and `0.16.0-rc.1` are supported. Use
`--cargo-version` to keep Cargo on a different version sequence:

```sh
bun run release 0.16.0-beta.1
bun run release 0.16.0-rc.1 --cargo-version 0.2.0-rc.1
bun run release 0.16.0 --cargo-version 0.2.0
```

Every selected version must be greater than its current version in SemVer
order. An optional `v` prefix is accepted; build metadata (`+...`) is rejected.
An exact version permits promoting the same source from beta to rc or stable
without new commits. `auto` requires new commits. When the current version is
a pre-release, `auto` increments its last numeric identifier or appends `.1`:
`0.16.0-beta.1` becomes `0.16.0-beta.2`. Use an exact version to change channel
or promote to stable; `patch`, `minor` and `major` require a stable current
version. `--cargo-version` overrides Cargo for any selection mode.

**Pre-releases keep the stable npm and GitHub latest releases in place.** npm
uses the `alpha`, `beta` or `rc` tag for those identifiers, and `next` for other
pre-release identifiers. GitHub Releases use `--prerelease --latest=false`.
Stable releases use `latest`. Cargo uses the selected SemVer in its manifests
and internal dependencies. Publication channels are derived from the version.

The command updates the npm package versions, the Cargo workspace
version and internal dependency requirements, crate README install snippets,
and Cargo lockfiles including isolated fixtures. It checks the Bun lockfile
without upgrading dependencies, generates a changelog section from commit
subjects, and opens `chore(release): vX.Y.Z`. An existing open release PR is
returned instead of creating another one.

```sh
bun run release --dry-run
bun run release 0.16.0-beta.1 --cargo-version 0.2.0-beta.1 --dry-run
```

The preview uses the current committed `HEAD` and leaves its generated files
under `.pocket-build/validation/release-prepare/`. It does not push or open a PR.

**A version increase in `package.json` on `main` starts publication.** The
existing `release.yml` compares that version with the commit before the push.
Changes to dependencies or scripts with the same version skip the build and
publish jobs. Release versions come from the package manifests; prior versions
come from Git history. No release state file is generated.

For a version increase, the workflow checks package version consistency,
Cargo version advancement, and changelog. It creates the version tag
on the merged commit, then continues through builds, validation, Rust
publication, npm publication and the GitHub Release. No second command or tag
push is needed.

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
