# Monorepo Dissolution — Backend Runbook (2026-05-05)

## What this is

On 2026-05-05 the pnpm workspace was dissolved. `frontend/` and `backend/` are
now independent codebases that happen to share a single git repo. Each folder
has its own lockfile, its own dependency tree, and its own toolchain.

In Finder you'll only see `backend/` and `frontend/` at the repo root. The
hidden files at the root (`.git/`, `.github/`, `.gitignore`, `.gitleaks.toml`,
`.editorconfig`, `.prettierrc`, `.prettierignore`) stay where they are — they're
shared infra, not code.

There is no longer a root `package.json`, no `pnpm-workspace.yaml`, no
`packages/` directory. Anything you used to run from the repo root now runs
from `frontend/` or `backend/` directly.

## Where shared code lives now

| Old location                | New location                                            |
| --------------------------- | ------------------------------------------------------- |
| `packages/contracts`        | `backend/functions/src/shared/contracts/` (+ frontend)  |
| `packages/data-catalog`     | `backend/functions/src/shared/catalog/` (+ frontend)    |
| `packages/config-eslint`    | deleted (was unused)                                    |
| `packages/config-prettier`  | deleted (was unused)                                    |
| `packages/config-tsconfig`  | deleted (was unused)                                    |

Contracts and catalog are duplicated across `backend/functions/src/shared/`
and `frontend/src/shared/`. **When you change a schema, copy the change to the
other folder.** There is no build step that does this for you.

## Install / build / test / deploy

Run from `backend/functions/`:

```bash
cd backend/functions
npm install --legacy-peer-deps   # firebase ERESOLVE; legacy-peer-deps is required
npm run build                    # tsc → lib/
npm test                         # vitest
npm run test:emulator            # firebase emulators:exec → emulator-gated tests
```

Production deploy (script handles cwd):

```bash
bash backend/scripts/deploy-functions.sh                # full deploy
bash backend/scripts/deploy-functions.sh --rules-only   # firestore rules + indexes only
bash backend/scripts/deploy-functions.sh --functions-only
```

`deploy-functions.sh` was rewritten 2026-05-05 to no longer pack
`packages/*` tarballs into the staging dir — contracts and catalog are now
inlined under `src/shared/`, so the staging step is a straight copy of
`backend/functions/`.

## Firebase configs at backend/ root

These stay at `backend/` and are picked up by `firebase deploy` when run from
that directory:

- `firebase.json`
- `.firebaserc`
- `firestore.rules`
- `firestore.indexes.json`
- `storage.rules`
- `storage-lifecycle.json`

Don't move them. The deploy script `cd`s into `backend/` before invoking the
Firebase CLI.

## Terraform

Infrastructure lives at `backend/infra/terraform/`. State is GCS-backed,
defined in `backend.tf`. Drift is checked daily by
`.github/workflows/terraform-drift.yml`.

Bootstrap a fresh project:

```bash
bash backend/infra/terraform/scripts/bootstrap.sh \
  --project=glamornate-758c6 \
  --github-repo=<owner>/<repo>
```

## CI workflows

Workflow files stay at the repo root in `.github/workflows/`. Each backend job
sets:

```yaml
defaults:
  run:
    working-directory: backend/functions   # or backend/infra/terraform
```

Backend-touching workflows: `backend-emulator-test.yml`, `deploy.yml`,
`terraform-drift.yml`.

---

## Git / iCloud caveat — ghost-file workaround

### Background

The `Glamornate/` repo lives under `~/Desktop/`, which is iCloud Drive
(Desktop & Documents) sync managed. During heavy parallel git activity
(concurrent staging, multi-agent commits, recovery operations), iCloud's
`bird`/`cloudd` daemons race against git and produce numbered ghost copies
of git internals — e.g. `index 2`, `index 3`, `AUTO_MERGE 4`, `HEAD 2`,
`MERGE_MSG 2`, `packed-refs 2`. These ghost files corrupt the git index and
break commits, fetches, and rebases (related symptoms: `fatal: bad index file
sha1 signature`, refusal to advance HEAD, lock-file confusion).

This is the same root cause documented in `icloud_evicts_next_build_dir.md`
and `icloud_capsync_assets_public_ghosts.md` memory entries — iCloud creating
duplicate-numbered files in directories it should not be touching.

### Workaround applied (2026-05-05)

Two layers of defense were applied to
`/Users/nitishbhardwaj/Desktop/Glamornate/.git`:

1. **iCloud-exclude extended attribute** (primary):
   ```bash
   xattr -w com.apple.metadata:com_apple_backup_excludeItem 'bplist00_\x10\x10com.apple.backupd' /Users/nitishbhardwaj/Desktop/Glamornate/.git
   ```
   Verify with:
   ```bash
   xattr /Users/nitishbhardwaj/Desktop/Glamornate/.git
   # → com.apple.metadata:com_apple_backup_excludeItem
   ```

2. **`nodump` BSD flag** (defense-in-depth):
   ```bash
   chflags nodump /Users/nitishbhardwaj/Desktop/Glamornate/.git
   ```
   Verify with:
   ```bash
   ls -lOd /Users/nitishbhardwaj/Desktop/Glamornate/.git
   # → drwxr-xr-x@ ... nodump,hidden ... .git
   ```

### Verification procedure

After any heavy git activity (multi-agent commit, rebase, recovery), re-check
ghost count:
```bash
find /Users/nitishbhardwaj/Desktop/Glamornate/.git -name "* [0-9]*" | wc -l
```
Expected: `0`. If non-zero, the exclude is being ignored by iCloud — fall
back to the kill-bird/cloudd workaround:

```bash
# Pause iCloud daemons during git ops
sudo killall -STOP bird cloudd

# ... do git work ...

# Resume iCloud after git ops complete and ghosts are swept
sudo killall -CONT bird cloudd
```

### Why this matters

Without the exclude, contributors will hit intermittent `fatal: bad index file
sha1 signature` errors during ordinary work, especially when running multiple
Claude Code sessions or git operations in parallel. The fix is local-only —
does not affect tracked files, does not appear in any commit. Each contributor
on macOS with iCloud-synced `~/Desktop` must apply the same workaround on
their clone.

### Related memory

- `icloud_sync_duplicates.md` — `* 2.tsx` ghost files breaking Next.js static export
- `icloud_evicts_next_build_dir.md` — iCloud evicting `.next/` build artifacts
- `icloud_capsync_assets_public_ghosts.md` — same mechanism corrupting `npx cap sync` output
- `icloud_ghosts_in_android_res.md` — same mechanism corrupting `android/res` and `.gradle`
