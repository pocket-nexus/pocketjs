# Rust crate releases

**The Rust release publishes 14 crates from an explicit list** in
`tools/release/publish-crates.ts`. `pocket-runtime-cabi` is excluded.
The workspace version and all 14 package versions must match the requested
release version. Update the workspace dependency versions with each version bump.

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

## Trusted Publishing setup

After the first publication, add this GitHub Trusted Publisher in each crate's
crates.io **Settings → Trusted Publishing**:

| Field | Value |
| --- | --- |
| Repository owner | `pocket-nexus` |
| Repository name | `pocketjs` |
| Workflow filename | `publish-crates.yml` |
| Environment | Leave empty |

The workflow exchanges its GitHub OIDC identity for a short-lived crates.io
token through `rust-lang/crates-io-auth-action`. No Cargo token is stored in
GitHub secrets. See the [crates.io Trusted Publishing documentation](https://crates.io/docs/trusted-publishing).

## Subsequent releases

Merge the version changes and release workflow into `main`, then tag the source
revision with the Cargo workspace version:

```sh
git tag crates-v0.1.1 <commit-on-main>
git push origin crates-v0.1.1
```

**Pushing a `crates-v*` tag publishes the selected crate versions.** The workflow
checks that the tag points to a commit in `main` and that all selected versions
match the tag. This tag prefix is separate from the npm release's `v*` prefix.
To resume a release, rerun the workflow or dispatch **Publish Rust crates** with
the same existing tag. Publication runs are serialized and do not cancel a run
that is uploading packages.

The workflow runs Cargo's package verification as part of publication. It adds
no pull-request checks or test jobs.
