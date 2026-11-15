# stfl-meta

This branch of `stfl/paperclip` holds no Paperclip code. It holds the daily
carry routine that keeps the fork's `stfl-next` on the newest upstream release
with every carry branch merged in. `scripts/carry.sh` in `stfl/paperclip-ci`
runs it on kondor's self-hosted runner, before the build of `stfl-next`:

- `routine.sh`: the deterministic steps, with `--dry-run` for testing.
  `carry.sh` runs them in order.
- `ROUTINE.md`: the brief of the one step that needs judgement, porting a
  branch whose merge conflicts. `carry.sh` hands it to Claude.
- `rr-cache/`: git rerere's recorded conflict resolutions, restored at the
  start of each run and saved back at the end, because each run starts from a
  fresh clone.

The carried changes are the open issues of this repository, one per branch.
The design is ADR 0002 in Stefan's dotfiles,
`docs/paperclip/adr/0002-paperclip-carry-fork.md`.

To check it locally from a full clone of the fork with an `upstream` remote
for `paperclipai/paperclip` (or `UPSTREAM` set to one):

```sh
git worktree add --detach ../meta origin/stfl-meta
../meta/routine.sh --dry-run setup
../meta/routine.sh --dry-run plan
CURRENT_NEXT=refs/remotes/origin/master ../meta/routine.sh --dry-run build-next
../meta/routine.sh cleanup
```

`--dry-run` (or `DRY_RUN=1`) prints every push and issue write instead of
doing it. `CURRENT_NEXT=refs/remotes/origin/master` makes `build-next` rebuild
as if `stfl-next` were bare `master`.
