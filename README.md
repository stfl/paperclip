# stfl-meta

This branch of `stfl/paperclip` holds no Paperclip code. It holds the daily
cloud routine that keeps the fork's `stfl-next` on the newest upstream release
with every carry branch merged in:

- `ROUTINE.md`: what the routine does each day; its prompt tells it to follow
  this file.
- `routine.sh`: the deterministic steps, with `--dry-run` for testing.
- `rr-cache/`: git rerere's recorded conflict resolutions, restored at the
  start of each run and saved back at the end, because the cloud clone starts
  empty every day.

The carried changes are the open issues of this repository, one per branch.
The design is ADR 0002 in Stefan's dotfiles,
`docs/paperclip/adr/0002-paperclip-carry-fork.md`.

To check it locally from a clone with an `upstream` remote:

```sh
git worktree add ../meta origin/stfl-meta
../meta/routine.sh --dry-run setup
../meta/routine.sh --dry-run plan
../meta/routine.sh cleanup
```
