# Carry routine for stfl/paperclip: the port

The routine keeps `stfl-next` = the newest upstream release + a `--no-ff`
merge of every open carry branch of `stfl/paperclip`. Each open issue of
`stfl/paperclip` is one carried change; its body names its branch, its
upstream PR, the branch it is stacked on and its `REMOVE WHEN`. The design is
ADR 0002 in Stefan's dotfiles (`docs/paperclip/adr/0002-paperclip-carry-fork.md`).

`scripts/carry.sh` in `stfl/paperclip-ci` runs every step of the routine on
kondor's self-hosted runner, except one: porting a branch whose merge into
`stfl-next` conflicts. That step is yours. Your prompt gives the absolute
paths of the clone, of `routine.sh` and of the build worktree; call
`routine.sh` by its absolute path.

## Never

- push a tag, push `stfl`, delete a branch, or force-push anything but a
  ported carry branch (`port-finish` does it with a lease);
- push, comment, open a PR or write anything to `paperclipai/paperclip`;
- close an issue;
- use `gh issue` or `gh pr`: `routine.sh` makes every GitHub write itself.

## Exit codes

- 3: `build-next` or `port-begin` met a conflict.
- 5: vitest failed in `port-test` or `port-finish`.
- 10: `build-next` has nothing to do.

A push refused by GitHub prints `PUSH REFUSED` with git's output. Put that
line in your report and stop.

## Port the conflicting branch

`build-next` printed `branch=`, `issue=`, `old_base=`, `old_tip=` and
`new_base=`; `old_base` is where the branch leaves upstream `master`.

1. `routine.sh port-begin <branch>` rebases it onto its new base in the build
   worktree. A branch stacked on another (its issue's `Depends on`) goes onto
   that branch's tip; when that branch is in the same conflict, port it first.
2. On a stop, read both sides of every conflict: what the branch changes and
   why (its issue says), and what upstream changed in the same place
   (`git log -p <old_base>..master -- <file>`). Resolve so the branch keeps
   its intent on upstream's new code, `git add`, then `git rebase --continue`;
   repeat until the rebase ends. Resolve only what you understand with
   confidence.
3. `routine.sh port-finish <branch>` runs the vitest files the branch touches
   (installing with `pnpm install --frozen-lockfile` once), pushes the branch
   with `--force-with-lease`, comments its `git range-diff` on the issue and
   removes `needs-rebase`.
4. A conflict you cannot resolve with confidence, or vitest failing (exit 5)
   after a fix you are sure of: `routine.sh port-fail <branch> "<why>"`. It
   labels the issue `needs-rebase`, comments why, and blocks `push-next`, so
   `stfl-next` and `stfl` stay where they are. Stop there.
5. Run `routine.sh build-next` again; it starts over from `master` and uses
   the ported tip. Exit 0 or 10: done. Exit 3: port the branch it names.
