---
name: pocketjs-review-pr
description: Review a community pull request on this repo to a merge verdict — reproduce the bug on base, verify the PR's claims against dependency source, sweep for architecture drift and code rot, run the local gate, push the fixes onto the contributor's branch, and squash-merge. Use when asked to review a PR, judge whether a PR is fit to merge, check a PR for drift or rot, or fix up and land someone else's PR.
---

# PocketJS PR Review

## Overview

Read the current `.github/workflows/` triggers and the PR's check results.
Path-filtered workflows may leave a documentation-only PR with no reported
checks; that is neither a passed check nor a failed check. Run the local checks
appropriate to the changed files and require applicable remote checks before
merge. For code changes, the curated local suite is the gate. Two habits carry
the review:

1. **Reproduce, don't read.** Run the bug on `main` and the fix on the branch
   over an input matrix wider than the PR's own test. A PR description is a
   hypothesis until its claims are checked against the dependency's source.
2. **Fix forward on the contributor's branch.** Cross-repo PRs here normally
   have `maintainerCanModify: true`, so review findings become a commit you push
   to their branch, not a round-trip. Keep that commit inside the PR's scope;
   pre-existing rot goes in the review comment as a follow-up.

## Workflow

1. **Read the PR and the whole diff.**

```bash
gh pr view <n> --json number,title,body,author,isDraft,baseRefName,headRefName,\
additions,deletions,changedFiles,mergeable,mergeStateStatus,isCrossRepository,maintainerCanModify
gh pr diff <n>
gh pr checks <n>          # compare missing checks with current workflow filters
```

2. **Get the branch locally without touching `main`.** Superset worktrees can't
   `git checkout main` (it is held by `~/code/pocketjs`), and a fork's branch
   name is not on `origin`:

```bash
git fetch origin "pull/<n>/head:pr-<n>" && git checkout pr-<n>
bun install                          # node_modules is per-worktree
bun tools/build.ts hero              # generates framework/src/styles.generated.ts
```

Skip that build and tests fail with `Could not resolve "./styles.generated.ts"`
— an environment failure that reads as the PR's fault.

3. **Reproduce the bug on base.** Materialize the base version of the changed
   module beside the new one and run both through the same matrix:

```bash
git show main:framework/compiler/vue-sfc-compile.ts > framework/compiler/vue-sfc-compile.base.ts
bun <scratchpad>/probe.ts            # imports BOTH, prints one line per case
rm framework/compiler/vue-sfc-compile.base.ts
```

Scratch scripts live outside the repo, so they must import repo modules by
**absolute** path — a relative specifier won't resolve `node_modules`. Widen the
matrix past the PR's test: for a template/compiler change that meant root,
nested-in-element, `v-if`/`v-else` separator, `v-for` body, slot content,
only-child, and empty-template shapes — seven of eight reproduced, and the
nested one revealed a case the fix did not cover.

4. **Check every load-bearing claim against the dependency source.** "This
   option arrives too late", "the dist hardcodes X", "this is only a backstop"
   are all verifiable in `node_modules/`:

```bash
grep -n "templateParseOptions" node_modules/@vue/compiler-sfc/dist/compiler-sfc.cjs.js
```

Read the call site, not the type. That is how the `comments: false` "backstop"
in #189 turned out to be load-bearing for a second reason (`isMultiRoot()`
derives `preserveComments` from it, so the two settings must agree).

5. **Blast radius.** Answer these with `grep`, and say so in the review:
   - Other entry points to the changed behavior (`grep -rn "@vue/compiler-sfc"`
     → one call site; `site/playground/compiler-entry.ts` mirrors the pass-1
     collector *by design*, because the browser build can't use Bun APIs).
   - Golden/tape churn: grep app and test sources for the pattern the PR
     changes (no `.vue` in the tree had a template comment → no churn).
   - Parallel implementations that need the same fix, or that are dead.

6. **Drift and rot pass.** The questions that actually find things:
   - **Does the fix add a hand-maintained list where the repo's governed-surface
     idiom applies?** A literal list that must be edited whenever a module is
     added rots exactly like the bug it patches — derive the set instead
     (`Bun.Transpiler.scanImports` walks a module's real imports), or pin it
     with a test the way #174 pinned the npm `files` map.
   - **Does a cache key still omit something the output depends on?** The
     `.cache/transforms/` key covers dependency versions and inputs, so the
     compiler's own sources are the gap that bites — a warm cache serving the
     previous implementation looks like a broken fix, not a stale cache.
   - **Does the new code claim more than the surrounding code can deliver?**
     `parseTemplateHtml` is a single-element parser; a comment fix billed as
     "DOM-correct from any path" can only be correct at the top level. State
     the limit in the comment rather than implying generality.
   - **Is the module still reachable?** `grep -rn <module>` for an importer, and
     grep the docs for its name. `solid-plugin.ts` sat unimported from #27 until
     it was retired, collecting mechanical updates in #122 and #149 the whole
     time, while `docs/DESIGN.md` and `site/content/docs/architecture.md` still
     called it the pass-1 transform. Report it; don't fold it into a bugfix PR.
   - **Duplication introduced by the PR's own tests** — repeated stub-host
     setup, an inline type that wants to be a helper.

7. **Run the gate and prove any mechanism empirically.**

For code changes:

```bash
rm -f dist/*.js dist/*.pak        # dist bundles are target-flavored
bun run test                     # the curated gate; report pass/fail counts
bunx tsc --noEmit
```

Bare `bun test` is NOT the gate — it pulls in emulator and hardware harnesses
that fail without devices, which is why "failure set identical to base" claims
need re-running, not repeating. For a cache-key or build-key change, prove it:
`rm -rf .cache/transforms`, build, count entries, mutate a source the key should
cover, rebuild, confirm every entry re-keyed, revert, confirm the original keys
come back.

For documentation and instruction changes, check links, referenced commands,
symlink targets, whitespace, and the final file list. Confirm that code and
test fixtures are unchanged; do not rerun device deployments or broad runtime
tests merely to validate prose.

Keep per-run screenshots, logs, traces, benchmark dumps, and receipts in
ignored `.pocket-build/validation/<task>/<run>/` output or an artifact store.
The PR should contain a concise validation summary and selected attachments.
Before committing, inspect `git diff --cached --name-status`: a new image or
recording needs an identified test consumer or maintained product/documentation
purpose. A local capture is not a fixture merely because it records a test.
Remove stale links when moving temporary artifacts out of the tracked tree.
The repository's `AGENTS.md`/`CLAUDE.md` rules govern artifact retention;
historical session behavior does not create a new requirement to commit files.

8. **Push the fixes onto the contributor's branch.**

```bash
git commit -F -                  # Conventional Commits + Co-Authored-By trailer
git push https://github.com/<headRepositoryOwner>/pocketjs.git HEAD:<headRefName>
```

9. **Post the review, then merge.** The comment is the durable record: verdict
   first, then what you verified *with the evidence* (counts, emitted code,
   test numbers), what you pushed and why each finding was a finding, and what
   you deliberately left alone with its reason.

```bash
gh pr comment <n> --body "$(cat <<'EOF'
<the review, as markdown>
EOF
)"
gh pr merge <n> --squash --subject "type(scope): summary (#<n>)" --body "what and why, one paragraph"
```

Never `--delete-branch`: the head branch belongs to a fork, and `main` is
checked out at `~/code/pocketjs` so the local prune fails anyway.

10. **Restore the worktree** — `git checkout <original-branch>` and
    `git branch -D pr-<n>`, so the next session starts where this one did.

## Gotchas

- `--conditions=browser` is required for the DOM, renderer, sim, and devtools
  test files; `package.json`'s `test` script is the authority on which.
- Extending a stub `HostOps` in tests: an element path needs `insertBefore`,
  not just `createNode`/`setText`, or `insertNode` throws mid-parse.
- `parse()` in `@vue/compiler-sfc` caches by `genCacheKey(source, options)`, so
  changing parse options changes the cache key — never assume a warm cache
  invalidated itself.
- A comment-only fix can still allocate native nodes: `createCommentNode` goes
  through `createTextNode`, and orphans are reclaimed by `runSweep()` per frame,
  so node-count deltas in a tree dump are the thing to check, not the source.
- Verdict language: report what was run and what it returned. "Full suite
  passes" without numbers is not a verdict, and a claim you inherited from the
  PR body is not evidence.
