# Rust crate releases

**The repository release publishes 14 Rust crates** listed in
`tools/release/publish-crates.ts`. The script reads each version from its Cargo
manifest. Rust crate versions and npm package versions are independent.
Update workspace dependency versions with each Rust version bump.

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

## Subsequent releases

**Rust publication is a stage in `.github/workflows/release.yml`.** The existing
`v*` tag trigger and manual release dispatch run the release identity check, SDK
and runtime builds, and release validation. The publish job then publishes Rust
crates before npm packages and the GitHub Release.

The Rust stage uses the Cargo versions from that release revision and skips
versions present on crates.io. A repository release can keep the current Rust
versions while changing npm versions. To resume a release, rerun the existing
workflow with the same tag or version input. Package publication jobs are
serialized and do not cancel a run that is uploading packages.

Cargo verifies packaged sources during publication. The Rust stage adds no
test jobs or separate workflow.
