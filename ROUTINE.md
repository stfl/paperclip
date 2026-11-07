# Daily carry routine for stfl/paperclip

You keep `stfl-next` = the newest upstream release + a `--no-ff` merge of every
open carry branch of `stfl/paperclip`. Each open issue of `stfl/paperclip` is
one carried change; its body names its branch, its upstream PR, the branch it
is stacked on and its `REMOVE WHEN`. The design is ADR 0002 in Stefan's
dotfiles (`docs/paperclip/adr/0002-paperclip-carry-fork.md`).

`routine.sh` next to this file does every deterministic step. You run it,
read what it prints, and do the one thing it cannot: port a branch whose merge
conflicts. Run it as `../meta/routine.sh <command>` from anywhere in the
`stfl/paperclip` clone.

## Never

- push a tag, push `stfl`, delete a branch, or force-push anything but a
  ported carry branch and `stfl-next` (the script does both with a lease);
- push, comment, open a PR or write anything to `paperclipai/paperclip`;
- close an issue yourself: the script closes one only when its upstream PR's
  merge commit is an ancestor of `master`;
- use `gh issue` or `gh pr`: GraphQL is blocked here, the script uses
  `gh api` REST calls only.

## Environment

1. Install pnpm when `pnpm --version` fails: `corepack enable`, or
   `npm i -g pnpm@<version>` with the version of `packageManager` in the
   clone's `package.json`.
2. The script finds the `paperclipai/paperclip` clone by its `origin` URL
   among the directories next to the `stfl/paperclip` clone. If it says it
   cannot, or the fetch from it fails (a shallow clone), set
   `UPSTREAM=<path of that clone>` or `UPSTREAM=https://github.com/paperclipai/paperclip.git`
   for every call.

## Steps

1. `routine.sh setup`. It restores the rerere cache from `rr-cache/`, fetches
   both repositories, resolves the latest upstream release and reads the open
   issues. Exit 4 means stop: the release is not on upstream master ("release
   from a side branch, ask Stefan") or master diverged from it. Report that
   line and stop, opening nothing. An error naming an issue without a
   `## Branch` section: report it and stop.
2. `routine.sh plan`, and keep its output for the summary.
3. `routine.sh sync`: fast-forwards `master` to the release, closes each
   issue whose PR landed (with the evidence as a comment) and labels
   `check-successor` on a PR closed unmerged.
4. `routine.sh build-next`.
   - Exit 10: nothing to do. Go to step 7.
   - Exit 0: built. Go to step 6.
   - Exit 3: a branch conflicts. It prints `branch=`, `issue=`, `old_base=`,
     `old_tip=` and `new_base=`. Port it (step 5), then run `build-next`
     again; it starts over from `master` and uses the ported tip.
5. Port the conflicting branch:
   1. `routine.sh port-begin <branch>` rebases it onto its new base in the
      build worktree (`../stfl-next-build` beside `../meta`, or `NEXT_DIR`).
      A branch stacked on another (its issue's `Depends on`) goes onto that
      branch's tip; when that branch is in the same conflict, port it first.
   2. On a stop, read both sides of every conflict: what the branch changes
      and why (its issue says), and what upstream changed in the same place
      (`git log -p <old_base>..master -- <file>`). Resolve so the branch keeps
      its intent on upstream's new code, `git add`, then
      `git rebase --continue`; repeat until the rebase ends. Resolve only what
      you understand with confidence.
   3. `routine.sh port-finish <branch>` runs the vitest files the branch
      touches (installing with `pnpm install --frozen-lockfile` once), pushes
      the branch with `--force-with-lease`, comments its `git range-diff` on
      the issue and removes `needs-rebase`.
   4. A conflict you cannot resolve with confidence, or vitest failing (exit
      5) after a fix you are sure of: `routine.sh port-fail <branch> "<why>"`.
      It labels the issue `needs-rebase`, comments why, and blocks
      `push-next`. Go to step 7: `stfl-next` and `stfl` stay where they are.
   A push refused by the proxy prints `PUSH REFUSED` with git's output; put
   that line in the summary and go to step 7.
6. `routine.sh push-next`, then `routine.sh dispatch`. A refused dispatch is
   not an error: `stfl/paperclip-ci` builds `stfl-next` on its daily schedule
   at 06:30 UTC anyway.
7. `routine.sh save-rerere` commits new conflict resolutions to `stfl-meta`.
8. End with a summary: `routine.sh summary` lists the release, the master
   move, the issues closed or labelled, the branches ported, the `stfl-next`
   SHA and the dispatch result. Add every failure and anything you were
   unsure of.

## Testing the script

`routine.sh --dry-run <command>` (or `DRY_RUN=1`) prints every push, issue
write and dispatch instead of doing it. `CURRENT_NEXT=refs/remotes/origin/master`
makes `build-next` rebuild as if `stfl-next` were bare `master`.
`routine.sh cleanup` removes the build worktree and the run state.
