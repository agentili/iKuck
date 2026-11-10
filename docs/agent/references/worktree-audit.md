# Worktree audit and cleanup workflow

Use when the user asks to inspect, analyze, or remove local git worktrees for iKuck.

## Procedure

1. **List all worktrees**
   ```bash
   cd /home/hermes/iKuck && git worktree list
   ```

2. **For each worktree, inspect**:
   - Current branch and commit (`git status`, `git log --oneline -5`)
   - Divergence from `origin/main` (`git branch -a --contains <commit>`)
   - Uncommitted changes (`git status --short`)
   - Untracked files that may be artifacts

3. **Report a comparison table** with:
   - Worktree path
   - Branch name
   - Commit SHA
   - Status vs `origin/main` (ahead/behind/divergent/clean)
   - Uncommitted/untracked files
   - Purpose (from branch name or recent commits)

4. **Before removing any worktree**:
   - Confirm with the user which to remove
   - Use `git worktree remove <path>` for clean worktrees
   - Use `git worktree remove --force <path>` only when user explicitly authorizes discarding uncommitted/untracked content

5. **Stash analysis (when main worktree has uncommitted changes)**:
   - `git stash push -m "pre-pull-analysis-<timestamp>"`
   - `git stash show -p` to display full diff
   - Summarize by file area (backend routes, frontend components, stores, tests, E2E)
   - Identify the feature/theme (e.g., "pantry merge fallback resilience")
   - Note test additions/modifications as evidence of intended behavior

## Pitfalls

- **Never remove a worktree without explicit user confirmation** — uncommitted work or untracked design assets may be intentional.
- **Stash before analyzing** — `git diff` on a dirty worktree mixes staged/unstaged; stash gives a clean, atomic diff.
- **Compare against `origin/main` not local `main`** — local main branch may be stale (as seen when local main was at PR #9 while origin/main was at PR #12/v1.7.0).
- **Worktrees on detached HEAD or old tags** (like the main worktree at `2092b3a` on `fix/house-pantry-merge-fallback`) are not "behind" in a merge sense — they are feature branches. Report them as divergent feature work, not as outdated main.

## Example output format

| Worktree | Path | Branch | Commit | Status vs origin/main | Notes |
|---|---|---|---|---|---|
| Main | /home/hermes/iKuck | fix/house-pantry-merge-fallback | 2092b3a | Behind ~12 commits (v1.7.0) | 8 files modified: sync routes, pantry merge notice, App.tsx |
| Bring Integration | /home/hermes/iKuck-bring-integration | feat/bring-integration | ef043a2 | Divergent: 25 ahead, 2 behind | 5 modified + 2 untracked — Bring! shopping list integration |

## When to skip removal

- Worktree has untracked design/docs (`STATUS.md`, `design/`) that may be reference material
- Worktree has uncommitted test fixes that aren't in `origin/main` yet
- Branch represents an active experiment the user may want to resume

Only remove when the user explicitly says "proceed with removal" or "clean up".

## Identify a complete dirty candidate snapshot

Before final gates or an independent review of a dirty worktree:

If a task names a snapshot helper, verify the path exists and inspect the script before running it. If it is absent, create a scratch-only implementation of the schema below and use that same serializer for all comparisons; do not substitute a different aggregate-hash format.

1. Confirm there is no other writer; serialize implementation, verification and review with explicit Kanban dependencies rather than relying on an empty worker list alone.
2. Record `git status --short --branch`, `git rev-parse HEAD`, and `git diff --check`.
3. Inventory tracked/staged/renamed/deleted changes and non-ignored untracked files with `git status --porcelain=v1 -z --untracked-files=all`. For each path, record the full two-character porcelain status, path, type (`file`, `symlink`, or `deleted`) and content SHA-256; hash symlink-target bytes rather than following links, and represent deletions with an explicit type and null digest. For renames, include both old and new paths. Sort records by path then status/type, serialize them as UTF-8 compact JSON with sorted object keys and no insignificant whitespace, then SHA-256 those bytes. Use the same schema and encoder before/after gates and in review; two different valid serializations produce incomparable digests.
4. Exclude `.env`, credentials, private keys and secret stores without opening or hashing them; report only the count excluded, not their paths. Ignored generated build/test output is not source identity.
5. Record branch/HEAD, tracked and untracked counts, exclusions count and aggregate fingerprint in the Kanban handoff. Recompute after the final source edit and again after gates; if the tested snapshot differs, rerun affected gates before review.

Do not identify a dirty candidate by HEAD or one hotspot-file hash: neither captures the full uncommitted and untracked implementation.

## Rebase strategy for feature branches onto `origin/main`

When a local feature branch/worktree is behind `origin/main` (production):

1. **Fetch first**: `git fetch origin` to get latest `origin/main`
2. **Stash uncommitted changes** on the feature branch before rebasing
3. **Rebase onto `origin/main`**: `git rebase origin/main`
4. **Conflict resolution philosophy**: **Keep HEAD (`origin/main`) as authoritative** when:
   - The feature branch's approach is outdated (e.g., client-side `syncScope` vs server-side resolution in v1.7.0)
   - `origin/main` has newer architecture (scope matrix, error handling, test patterns)
   - Production `/version.json` confirms `origin/main` is the deployed version
5. **Apply stashed changes after rebase**: `git stash pop` and resolve conflicts again, keeping v1.7.0 patterns
6. **Run full test suites** (frontend + backend) after rebase completes

### Specific v1.7.0 patterns to preserve during conflict resolution

| Area | v1.7.0 pattern (HEAD) | Outdated branch pattern |
|---|---|---|
| Sync scope | Server resolves via membership; `syncScope` stripped client-side | Client sends `syncScope`, validated at route |
| Diet profile | Shared house entity (`HOUSE_SYNC_ENTITY_TYPES`) | Personal/account-scoped |
| Error classes | `SyncMembershipRequiredError` (403), no `SyncScopeRequiredError` | `SyncScopeRequiredError` (400), `SyncScopeInvalidError` |
| Test assertions | Expect 200 with server-resolved scope | Expect 400/403 for missing/invalid client scope |
| Pantry merge | Resilient fallback: guest data preserved, alert shown | Not present in branch |

When the branch introduces a **different architecture** (e.g., `bring-integration` dinner consumption coordination), expect many conflicts. Keep v1.7.0 as base for core sync/storage/auth; apply only genuinely new files (new stores, components, tests) that don't conflict with v1.7.0 contracts.

## Post-rebase verification

- `git log --oneline -5` — verify HEAD is `origin/main` commit
- `git status` — clean working tree
- `npm test -- --run` in both frontend/ and backend/ — all pass
- Compare `/version.json` from production if deploying