#!/usr/bin/env bash
# The deterministic steps of the stfl/paperclip carry routine. ROUTINE.md says
# when to run each subcommand; `routine.sh help` lists them.
# Backticks in single quotes are Markdown for GitHub comments:
# shellcheck disable=SC2016
set -euo pipefail

readonly FORK=stfl/paperclip
readonly UPSTREAM_SLUG=paperclipai/paperclip
readonly FORK_URL=https://github.com/$FORK
readonly UPSTREAM_URL=https://github.com/$UPSTREAM_SLUG
# A push URL no transport accepts, so nothing can push to upstream.
readonly NO_PUSH=no-push://paperclipai-paperclip-is-read-only
readonly CI_REPO=stfl/paperclip-ci
readonly EXIT_CONFLICT=3
readonly EXIT_STOP=4
readonly EXIT_TESTS=5
readonly EXIT_NOTHING=10
# GitHub refuses comment bodies over 65536 characters.
readonly COMMENT_LIMIT=60000
readonly BOT_NAME="Stefan Lendl"
readonly BOT_EMAIL="git@stfl.dev"

META_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_COMMON=$(git -C "$META_DIR" rev-parse --path-format=absolute --git-common-dir)
REPO_TOP=$(git -C "$META_DIR" worktree list --porcelain | sed -n '1s/^worktree //p')
STATE_DIR=${STATE_DIR:-$GIT_COMMON/stfl-routine}
NEXT_DIR=${NEXT_DIR:-$(dirname "$META_DIR")/stfl-next-build}
CURRENT_NEXT=${CURRENT_NEXT:-refs/remotes/origin/stfl-next}
UPSTREAM=${UPSTREAM:-}
DRY_RUN=${DRY_RUN:-0}
readonly RERERE=(-c rerere.enabled=true -c rerere.autoupdate=true)
# Set by need_state from the run state that setup writes.
RELEASE='' MASTER='' OLD_MASTER='' MASTER_MOVE=''

usage() {
	cat <<'EOF'
usage: routine.sh [--dry-run] <command> [args]

  setup                     fetch, resolve the release, read the open issues
  plan                      print what sync and build-next would do
  sync                      fast-forward master; close or label issues by PR state
  build-next                merge every open branch onto master (exit 3: conflict,
                            exit 10: nothing to do)
  port-begin <branch>       start rebasing a conflicting branch onto its new base
  port-test [<branch>]      run the vitest files the checked-out port touches
  port-finish <branch>      test, push the ported branch, comment its range-diff
  port-fail <branch> <why>  label needs-rebase, comment why, block push-next
  port-report <branch> <old-base> <old-tip> [<new-base> <new-tip>]
  push-next                 push the built stfl-next
  dispatch                  dispatch the build in stfl/paperclip-ci
  save-rerere               commit the rerere cache to stfl-meta and push it
  summary                   print what this run did
  cleanup                   remove the build worktree and the run state

--dry-run (or DRY_RUN=1) prints every push, issue write, dispatch and the
reset of the main clone's master instead.
Environment: UPSTREAM (remote, path or URL of paperclipai/paperclip),
CURRENT_NEXT (ref taken as the current stfl-next), NEXT_DIR, STATE_DIR.
EOF
}

log() { printf '%s\n' "$*" >&2; }
die() {
	log "error: $*"
	exit 1
}
G() { git -C "$META_DIR" "$@"; }
B() { git -C "$NEXT_DIR" "$@"; }
dry() { [[ $DRY_RUN == 1 ]]; }

record() {
	printf '%s\n' "$*" >>"$STATE_DIR/summary"
	log "$*"
}

# Runs a write, or prints it under --dry-run.
act() {
	if dry; then
		printf 'DRY-RUN:' >&2
		printf ' %q' "$@" >&2
		printf '\n' >&2
		return 0
	fi
	"$@"
}

# gh api for reads only: a write must go through act.
gh_get() {
	local a
	for a in "$@"; do
		case $a in
		-X | --method | -f | -F | --field | --raw-field | --input) die "gh_get is read-only: $*" ;;
		esac
	done
	gh api "$@"
}

need_state() {
	[[ -f $STATE_DIR/release ]] || die "no run state in $STATE_DIR: run 'routine.sh setup' first"
	# shellcheck source=/dev/null
	source "$STATE_DIR/release"
}

# ---------------------------------------------------------------- issues

# Prints the lines under "## <heading>" up to the next "## ".
section() {
	awk -v h="## $1" '{ sub(/\r$/, "") } $0 == h { on = 1; next } /^## / { on = 0 } on'
}

# Writes issues.tsv: number, labels, branch, upstream PR, depends-on branches.
load_issues() {
	local out=$STATE_DIR/issues.tsv json n labels body branch pr deps
	: >"$out"
	gh_get --paginate "repos/$FORK/issues?state=open&per_page=100" \
		--jq '.[] | select(.pull_request | not) | {number, labels: [.labels[].name] | join(","), body: (.body // "")} | @base64' \
		>"$STATE_DIR/issues.raw"
	while read -r json; do
		json=$(base64 -d <<<"$json")
		n=$(jq -r .number <<<"$json")
		labels=$(jq -r .labels <<<"$json")
		body=$(jq -r .body <<<"$json")
		branch=$(section Branch <<<"$body" | grep -o '`[^`]*`' | head -n1 | tr -d '`' || true)
		[[ -n $branch ]] || die "issue #$n has no branch in a '## Branch' section"
		pr=$(section Upstream <<<"$body" | grep -m1 '^- PR' | grep -oE "github\.com/$UPSTREAM_SLUG/pull/[0-9]+" | head -n1 | sed 's#.*/##' || true)
		deps=$(section 'Depends on' <<<"$body" | grep -o '`[^`]*`' | tr -d '`' | paste -sd, - || true)
		if [[ ,$labels, =~ ,(own-pr|upstream-pr), && -z $pr ]]; then
			log "warning: issue #$n is labelled $labels but its Upstream section names no PR"
		fi
		printf '%s\t%s\t%s\t%s\t%s\n' "$n" "${labels:--}" "$branch" "${pr:--}" "${deps:--}" >>"$out"
	done <"$STATE_DIR/issues.raw"
	sort -n -o "$out" "$out"
}

# Prints the open issues not closed in this run, in issue-number order.
open_issues() {
	touch "$STATE_DIR/closed"
	awk -F'\t' 'FILENAME == ARGV[1] { closed[$1] = 1; next } !($1 in closed)' "$STATE_DIR/closed" "$STATE_DIR/issues.tsv"
}

issue_field() { # <number> <column>
	awk -F'\t' -v n="$1" -v c="$2" '$1 == n { print $c }' "$STATE_DIR/issues.tsv"
}

has_label() { [[ ,$(issue_field "$1" 2), == *,$2,* ]]; }

issue_of_branch() {
	awk -F'\t' -v b="$1" '$3 == b { print $1 }' "$STATE_DIR/issues.tsv"
}

issue_comment() { # <number> <body file>
	if dry; then
		log "DRY-RUN: comment on $FORK#$1:"
		head -n 40 "$2" | sed 's/^/  | /' >&2
		return 0
	fi
	gh api -X POST "repos/$FORK/issues/$1/comments" -F "body=@$2" --silent
}

issue_label_add() { act gh api -X POST "repos/$FORK/issues/$1/labels" -f "labels[]=$2" --silent; }
issue_label_remove() { act gh api -X DELETE "repos/$FORK/issues/$1/labels/$2" --silent; }
issue_close() { act gh api -X PATCH "repos/$FORK/issues/$1" -f state=closed -f state_reason=completed --silent; }

# ---------------------------------------------------------------- refs

upstream_source() {
	if [[ -n $UPSTREAM ]]; then
		printf '%s\n' "$UPSTREAM"
		return
	fi
	if G remote get-url upstream >/dev/null 2>&1; then
		printf 'upstream\n'
		return
	fi
	local d url
	for d in "$(dirname "$REPO_TOP")"/*/ "$(dirname "$META_DIR")"/*/; do
		url=$(git -C "$d" remote get-url origin 2>/dev/null) || continue
		case $url in
		*"$UPSTREAM_SLUG" | *"$UPSTREAM_SLUG.git" | *"$UPSTREAM_SLUG/")
			printf '%s\n' "${d%/}"
			return
			;;
		esac
	done
	die "no clone of $UPSTREAM_SLUG found next to $REPO_TOP: set UPSTREAM to its path or URL"
}

# A branch's tip: its ported commit when this run ported it, else origin's.
tip_of() {
	local t
	t=$(awk -v b="$1" '$1 == b { t = $2 } END { print t }' "$STATE_DIR/ported" 2>/dev/null || true)
	if [[ -n $t ]]; then
		printf '%s\n' "$t"
	else
		G rev-parse --verify -q "refs/remotes/origin/$1^{commit}" || die "branch $1 is not on origin"
	fi
}

old_tip_of() { # the tip origin had before this run ported it
	local t
	t=$(awk -v b="$1" '$1 == b { print $3; exit }' "$STATE_DIR/ported" 2>/dev/null || true)
	if [[ -n $t ]]; then
		printf '%s\n' "$t"
	else
		G rev-parse "refs/remotes/origin/$1"
	fi
}

is_ancestor() { G merge-base --is-ancestor "$1" "$2" 2>/dev/null; }

# Where a branch leaves upstream master.
real_base_of() { G merge-base "$1" refs/remotes/upstream/master; }

# Prints a branch's real base when the release does not contain it: the
# branch waits for a release, since merging it would bring in every upstream
# commit between the release and that base.
waiting_base() {
	local base
	base=$(real_base_of "$(tip_of "$1")") || return 0
	is_ancestor "$base" "$MASTER" || printf '%s\n' "$base"
}

# push_ref <commit> <branch> <expected old commit, "" for absent, "-" for no lease>
push_ref() {
	local sha=$1 branch=$2 lease=$3 out
	case $branch in
	stfl | refs/* | v*) die "refusing to push $branch: the routine pushes no tags and never stfl" ;;
	esac
	local args=(push --porcelain origin "$sha:refs/heads/$branch")
	[[ $lease == - ]] || args=(push --porcelain "--force-with-lease=refs/heads/$branch:$lease" origin "$sha:refs/heads/$branch")
	if dry; then
		act git -C "$META_DIR" "${args[@]}"
		return 0
	fi
	if ! out=$(G "${args[@]}" 2>&1); then
		record "PUSH REFUSED: $branch <- ${sha:0:12} (lease ${lease:-absent}): $out"
		return 1
	fi
}

# ---------------------------------------------------------------- setup

is_repo_url() { # <url> <owner/name>
	case $1 in
	*[/:]"$2" | *[/:]"$2.git" | *[/:]"$2/") return 0 ;;
	esac
	return 1
}

has_remote() { G remote get-url "$1" >/dev/null 2>&1; }

# A clone of upstream (the cloud attaches both repositories under one name)
# gets origin = the fork and upstream = paperclipai/paperclip, push disabled.
fix_remotes() {
	local url
	url=$(G remote get-url origin 2>/dev/null || true)
	is_repo_url "$url" "$FORK" && return 0
	log "origin is '$url', not $FORK: making it upstream, origin $FORK_URL"
	if [[ -n $url ]] && ! has_remote upstream; then
		G remote rename origin upstream
	else
		has_remote upstream || G remote add upstream "$UPSTREAM_URL"
		if [[ -n $url ]]; then G remote remove origin; fi
	fi
	G remote set-url upstream "$UPSTREAM_URL"
	G remote set-url --push upstream "$NO_PUSH"
	G remote add origin "$FORK_URL"
}

# Ancestry checks need the whole history: deepen from the remote whose refs
# hold the shallow boundary, then fetch the other.
unshallow() {
	[[ $(G rev-parse --is-shallow-repository) == true ]] || return 0
	local boundary r from=''
	boundary=$(head -n1 "$GIT_COMMON/shallow")
	for r in upstream origin; do
		has_remote "$r" || continue
		if [[ -n $(G for-each-ref --count=1 --contains "$boundary" "refs/remotes/$r/") ]]; then
			from=$r
			break
		fi
	done
	if [[ -z $from ]]; then
		from=origin
		if has_remote upstream; then from=upstream; fi
	fi
	log "shallow clone: fetching the full history from $from"
	G fetch --quiet --unshallow --no-tags "$from"
	for r in upstream origin; do
		if [[ $r == "$from" ]] || ! has_remote "$r"; then continue; fi
		G fetch --quiet --no-tags "$r" "+refs/heads/master:refs/remotes/$r/master"
	done
}

# The main clone's master at origin/master, so nothing reads upstream's
# commits as unpushed work of this clone.
reset_local_master() {
	if [[ -n $(git -C "$REPO_TOP" status --porcelain) ]]; then
		log "$REPO_TOP has local changes: its master stays as it is"
		return 0
	fi
	act git -C "$REPO_TOP" checkout --quiet -B master refs/remotes/origin/master ||
		log "could not check out master in $REPO_TOP: it stays as it is"
}

cmd_setup() {
	rm -rf "$STATE_DIR"
	mkdir -p "$STATE_DIR"
	: >"$STATE_DIR/summary"
	: >"$STATE_DIR/closed"
	: >"$STATE_DIR/ported"
	local up release rel cur move
	if [[ -d $META_DIR/rr-cache ]]; then
		mkdir -p "$GIT_COMMON/rr-cache"
		cp -a "$META_DIR/rr-cache/." "$GIT_COMMON/rr-cache/"
	fi
	if ! dry; then
		G config rerere.enabled true
		G config rerere.autoupdate true
		G config user.email >/dev/null || G config user.email "$BOT_EMAIL"
		G config user.name >/dev/null || G config user.name "$BOT_NAME"
	fi

	fix_remotes
	unshallow
	up=$(upstream_source)
	log "fetching origin and upstream ($up)"
	G fetch --quiet --no-tags origin \
		'+refs/heads/master:refs/remotes/origin/master' \
		'+refs/heads/stfl-next:refs/remotes/origin/stfl-next'
	G fetch --quiet --no-tags "$up" '+refs/heads/master:refs/remotes/upstream/master' '+refs/tags/*:refs/tags/*'
	reset_local_master

	release=$(gh_get "repos/$UPSTREAM_SLUG/releases/latest" --jq .tag_name)
	[[ $release == v* ]] || die "latest release of $UPSTREAM_SLUG has tag '$release'"
	G rev-parse --verify -q "refs/tags/$release^{commit}" >/dev/null || die "upstream has no tag $release"
	rel=$(G rev-parse "refs/tags/$release^{commit}")
	if ! is_ancestor "$rel" refs/remotes/upstream/master; then
		record "STOP: release $release (${rel:0:12}) is not on upstream master: release from a side branch, ask Stefan"
		exit "$EXIT_STOP"
	fi
	cur=$(G rev-parse refs/remotes/origin/master)
	if [[ $cur == "$rel" ]]; then
		move=none
	elif is_ancestor "$cur" "$rel"; then
		move=fast-forward
	else
		record "STOP: origin/master ${cur:0:12} is not an ancestor of release $release (${rel:0:12}), ask Stefan"
		exit "$EXIT_STOP"
	fi
	printf 'RELEASE=%q\nMASTER=%q\nOLD_MASTER=%q\nMASTER_MOVE=%q\n' "$release" "$rel" "$cur" "$move" >"$STATE_DIR/release"

	load_issues
	local refspecs=() b
	while IFS=$'\t' read -r _ _ b _ _; do
		refspecs+=("+refs/heads/$b:refs/remotes/origin/$b")
	done <"$STATE_DIR/issues.tsv"
	G fetch --quiet --no-tags origin "${refspecs[@]}"
	while IFS=$'\t' read -r _ _ b _ _; do tip_of "$b" >/dev/null; done <"$STATE_DIR/issues.tsv"
	log "release $release, master: $move, $(wc -l <"$STATE_DIR/issues.tsv") open issues"
}

# ---------------------------------------------------------------- sync

# Prints one decision for an issue: close|successor|keep, then details.
decide_issue() { # <number> <labels> <pr>
	local n=$1 labels=$2 pr=$3 state merged sha at
	if [[ ! ,$labels, =~ ,(own-pr|upstream-pr), ]]; then
		printf 'keep\tno upstream PR label\n'
		return
	fi
	if [[ $pr == - ]]; then
		printf 'keep\tlabelled %s but no PR in its Upstream section\n' "$labels"
		return
	fi
	local pr_json
	pr_json=$(gh_get "repos/$UPSTREAM_SLUG/pulls/$pr" \
		--jq '[.state, (.merged | tostring), (.merge_commit_sha // "-"), (.merged_at // "-")] | @tsv')
	IFS=$'\t' read -r state merged sha at <<<"$pr_json"
	if [[ $merged == true ]]; then
		if G cat-file -e "$sha^{commit}" 2>/dev/null && is_ancestor "$sha" "$MASTER"; then
			printf 'close\t%s\t%s\n' "$sha" "$at"
		else
			printf 'keep\tPR #%s merged as %s on %s, not yet in %s\n' "$pr" "${sha:0:12}" "$at" "$RELEASE"
		fi
	elif [[ $state == closed ]]; then
		if [[ ,$labels, == *,check-successor,* ]]; then
			printf 'keep\tPR #%s closed unmerged, check-successor already set\n' "$pr"
		else
			printf 'successor\tPR #%s closed unmerged\n' "$pr"
		fi
	else
		printf 'keep\tPR #%s %s\n' "$pr" "$state"
	fi
}

cmd_sync() {
	need_state
	if [[ $MASTER_MOVE == fast-forward ]]; then
		push_ref "$MASTER" master - || die "master was not fast-forwarded"
		record "master: fast-forwarded ${OLD_MASTER:0:12} -> ${MASTER:0:12} ($RELEASE)$(dry && printf ' (dry run)')"
	else
		record "master: already at $RELEASE (${MASTER:0:12})"
	fi
	local n labels branch pr deps out decision a b f
	f=$(mktemp)
	while IFS=$'\t' read -r n labels branch pr deps; do
		out=$(decide_issue "$n" "$labels" "$pr")
		IFS=$'\t' read -r decision a b <<<"$out"
		case $decision in
		close)
			cat >"$f" <<EOF
Closing: upstream PR $UPSTREAM_SLUG#$pr was merged on $b as merge commit $a, which is an ancestor of \`master\` at $RELEASE (\`$MASTER\`).

\`$branch\` is left out of \`stfl-next\` from now on.
EOF
			issue_comment "$n" "$f"
			issue_close "$n"
			printf '%s\n' "$n" >>"$STATE_DIR/closed"
			record "#$n closed: PR #$pr merged as ${a:0:12}, in $RELEASE; $branch left out"
			;;
		successor)
			cat >"$f" <<EOF
Upstream PR $UPSTREAM_SLUG#$pr was closed without being merged. Upstream sometimes lands the same fix as a different PR: check for a successor before porting this branch again, and update this issue's Upstream and REMOVE WHEN sections.
EOF
			issue_comment "$n" "$f"
			issue_label_add "$n" check-successor
			record "#$n labelled check-successor: PR #$pr closed unmerged"
			;;
		keep) log "#$n kept: $a" ;;
		*) die "#$n: no decision ($out)" ;;
		esac
	done <"$STATE_DIR/issues.tsv"
	rm -f "$f"
}

# ---------------------------------------------------------------- build

# Branches merged into the current stfl-next on master, in merge order.
next_merged_branches() {
	G log --first-parent --merges --reverse --format=%s "$MASTER..$CURRENT_NEXT" |
		sed -n "s/^Merge branch '\(.*\)' into stfl-next\$/\1/p"
}

# Prints why stfl-next needs a rebuild; prints nothing when it does not.
rebuild_reasons() { # [issue numbers to treat as closed...]
	local skip=" $* " n b want
	if ! G rev-parse --verify -q "$CURRENT_NEXT^{commit}" >/dev/null; then
		printf '%s does not exist\n' "$CURRENT_NEXT"
		return
	fi
	if ! is_ancestor "$MASTER" "$CURRENT_NEXT"; then
		printf 'master moved: %s is not built on %s\n' "$CURRENT_NEXT" "$RELEASE"
		return
	fi
	want=$(open_issues | while IFS=$'\t' read -r n _ b _ _; do
		[[ $skip == *" $n "* || -n $(waiting_base "$b") ]] || printf '%s\n' "$b"
	done)
	while read -r b; do
		[[ -z $b ]] || grep -qxF -- "$b" <<<"$want" ||
			printf '%s is merged in %s but its issue is not open or it waits for a release\n' "$b" "$CURRENT_NEXT"
	done < <(next_merged_branches)
	while read -r b; do
		[[ -n $b ]] || continue
		is_ancestor "$(tip_of "$b")" "$CURRENT_NEXT" || printf '%s moved: its tip is not in %s\n' "$b" "$CURRENT_NEXT"
	done <<<"$want"
}

ensure_build_worktree() {
	if [[ ! -e $NEXT_DIR/.git ]]; then
		G worktree add --quiet --detach "$NEXT_DIR" "$MASTER"
	fi
	if [[ -e $(B rev-parse --git-path rebase-merge) || -e $(B rev-parse --git-path rebase-apply) ]]; then
		die "a rebase is in progress in $NEXT_DIR: finish it with port-finish or abort it with port-fail"
	fi
	B merge --abort 2>/dev/null || true
	B checkout --quiet --detach --force "$MASTER"
	B clean -fdq
}

# The base a branch is rebased onto: master, or the branch it is stacked on.
new_base_of() {
	local n deps
	n=$(issue_of_branch "$1")
	deps=$(issue_field "$n" 5)
	if [[ $deps == - ]]; then
		printf '%s\n' "$MASTER"
	else
		[[ $deps != *,* ]] || log "warning: $1 depends on several branches ($deps): using the first"
		tip_of "${deps%%,*}"
	fi
}

old_base_of() {
	local n deps
	n=$(issue_of_branch "$1")
	deps=$(issue_field "$n" 5)
	if [[ $deps == - ]]; then
		real_base_of "$(old_tip_of "$1")"
	else
		old_tip_of "${deps%%,*}"
	fi
}

conflict() { # <branch> <reason>
	local b=$1 n
	n=$(issue_of_branch "$b")
	printf '%s\n' "$b" >"$STATE_DIR/conflict"
	record "CONFLICT: $b (#$n): $2"
	printf 'branch=%s\nissue=%s\nold_base=%s\nold_tip=%s\nnew_base=%s\n' \
		"$b" "$n" "$(old_base_of "$b")" "$(old_tip_of "$b")" "$(new_base_of "$b")"
	exit "$EXIT_CONFLICT"
}

cmd_build_next() {
	need_state
	[[ ! -f $STATE_DIR/blocked ]] || die "a branch could not be ported this run: stfl-next stays where it is"
	local reasons
	reasons=$(rebuild_reasons)
	if [[ -z $reasons ]]; then
		record "stfl-next: nothing to do, $CURRENT_NEXT already merges every open branch on $RELEASE"
		exit "$EXIT_NOTHING"
	fi
	local shown
	shown=$(head -n 3 <<<"$reasons" | awk 'NR > 1 { printf "; " } { printf "%s", $0 }')
	(($(wc -l <<<"$reasons") <= 3)) || shown+="; and $(($(wc -l <<<"$reasons") - 3)) more"
	record "stfl-next: rebuilding: $shown"
	rm -f "$STATE_DIR/built" "$STATE_DIR/conflict"
	ensure_build_worktree
	local n b deps tip dep base count=0 waiting=0
	while IFS=$'\t' read -r n _ b _ deps; do
		base=$(waiting_base "$b")
		if [[ -n $base ]]; then
			record "WAITING: $b (#$n) is based on upstream ${base:0:12}, which $RELEASE does not contain: left out of stfl-next until a release does"
			waiting=$((waiting + 1))
			continue
		fi
		tip=$(tip_of "$b")
		if [[ $deps != - ]]; then
			for dep in ${deps//,/ }; do
				if grep -q "^$dep " "$STATE_DIR/ported" && ! is_ancestor "$(tip_of "$dep")" "$tip"; then
					conflict "$b" "stacked on $dep, which this run ported"
				fi
			done
		fi
		if ! B "${RERERE[@]}" merge --quiet --no-ff --no-edit -m "Merge branch '$b' into stfl-next" "$tip" >/dev/null 2>&1; then
			if [[ -z $(B diff --name-only --diff-filter=U) ]] && B rev-parse -q --verify MERGE_HEAD >/dev/null; then
				B commit --quiet --no-edit
				record "$b: conflict resolved by rerere"
			else
				B merge --abort
				conflict "$b" "merge into stfl-next conflicts"
			fi
		fi
		count=$((count + 1))
		log "merged #$n $b"
	done < <(open_issues)
	B rev-parse HEAD >"$STATE_DIR/built"
	record "stfl-next: built $(cat "$STATE_DIR/built") from $count branches on $RELEASE, $waiting waiting for a release"
}

# ---------------------------------------------------------------- port

cmd_port_begin() {
	need_state
	local b=${1:?branch}
	[[ -n $(issue_of_branch "$b") ]] || die "$b is not the branch of an open issue"
	[[ -z $(waiting_base "$b") ]] || die "$b waits for a release that contains its base: there is nothing to port"
	local old_base old_tip new_base
	old_base=$(old_base_of "$b")
	old_tip=$(old_tip_of "$b")
	new_base=$(new_base_of "$b")
	printf '%s %s %s %s\n' "$b" "$old_base" "$old_tip" "$new_base" >"$STATE_DIR/port"
	ensure_build_worktree
	B checkout --quiet --detach --force "$(tip_of "$b")"
	log "rebasing $b: $old_base..$(tip_of "$b") onto $new_base in $NEXT_DIR"
	if ! B "${RERERE[@]}" rebase --onto "$new_base" "$old_base"; then
		log "resolve the conflicts in $NEXT_DIR, 'git add' them, run 'git rebase --continue', then 'routine.sh port-finish $b'"
		exit "$EXIT_CONFLICT"
	fi
	log "rebased cleanly: run 'routine.sh port-finish $b'"
}

read_port() { # <branch>: sets PORT_OLD_BASE PORT_OLD_TIP PORT_NEW_BASE
	local b
	[[ -f $STATE_DIR/port ]] || die "no port in progress: run port-begin first"
	read -r b PORT_OLD_BASE PORT_OLD_TIP PORT_NEW_BASE <"$STATE_DIR/port"
	[[ $b == "$1" ]] || die "the port in progress is $b, not $1"
}

cmd_port_test() {
	need_state
	local files f dir pkg rel
	files=$(B diff --name-only --diff-filter=d "$MASTER...HEAD" -- '*.test.ts') || die "cannot diff HEAD in $NEXT_DIR against master"
	if [[ -z $files ]]; then
		record "${1:-HEAD}: touches no vitest files"
		return 0
	fi
	local lock
	lock=$(B rev-parse HEAD:pnpm-lock.yaml) || die "no pnpm-lock.yaml at HEAD in $NEXT_DIR"
	command -v pnpm >/dev/null || die "pnpm is not on PATH: corepack enable, or npm i -g pnpm@<packageManager version>"
	if [[ ! -f $STATE_DIR/pnpm-$lock ]]; then
		(cd "$NEXT_DIR" && pnpm install --frozen-lockfile) || die "pnpm install --frozen-lockfile failed in $NEXT_DIR"
		touch "$STATE_DIR/pnpm-$lock"
	fi
	declare -A by_pkg=()
	while read -r f; do
		dir=$(dirname "$f")
		while [[ $dir != . && ! -f $NEXT_DIR/$dir/package.json ]]; do dir=$(dirname "$dir"); done
		[[ $dir != . ]] || die "$f belongs to no workspace package"
		by_pkg[$dir]+=" ${f#"$dir"/}"
	done <<<"$files"
	for dir in "${!by_pkg[@]}"; do
		pkg=$(jq -r .name "$NEXT_DIR/$dir/package.json") || die "cannot read $dir/package.json"
		read -ra rel <<<"${by_pkg[$dir]}"
		log "vitest in $pkg: ${rel[*]}"
		if ! (cd "$NEXT_DIR" && pnpm --filter "$pkg" exec vitest run "${rel[@]}"); then
			record "${1:-HEAD}: vitest failed in $pkg: ${rel[*]}"
			return "$EXIT_TESTS"
		fi
	done
	record "${1:-HEAD}: vitest passed: $(wc -l <<<"$files") files"
}

cmd_port_finish() {
	need_state
	local b=${1:?branch} new_tip n
	read_port "$b"
	if [[ -e $(B rev-parse --git-path rebase-merge) || -e $(B rev-parse --git-path rebase-apply) ]]; then
		die "the rebase of $b is still in progress in $NEXT_DIR"
	fi
	new_tip=$(B rev-parse HEAD)
	is_ancestor "$PORT_NEW_BASE" "$new_tip" || die "HEAD $new_tip in $NEXT_DIR is not on $PORT_NEW_BASE"
	cmd_port_test "$b" || exit "$EXIT_TESTS"
	push_ref "$new_tip" "$b" "$PORT_OLD_TIP" || die "the ported $b was not pushed"
	printf '%s %s %s\n' "$b" "$new_tip" "$PORT_OLD_TIP" >>"$STATE_DIR/ported"
	cmd_port_report "$b" "$PORT_OLD_BASE" "$PORT_OLD_TIP" "$PORT_NEW_BASE" "$new_tip"
	n=$(issue_of_branch "$b")
	if has_label "$n" needs-rebase; then issue_label_remove "$n" needs-rebase; fi
	rm -f "$STATE_DIR/port" "$STATE_DIR/conflict"
	record "$b (#$n) ported: ${PORT_OLD_TIP:0:12} -> ${new_tip:0:12}$(dry && printf ' (dry run)')"
}

cmd_port_report() {
	need_state
	local b=${1:?branch} old_base=${2:?old base} old_tip=${3:?old tip}
	local new_base=${4:-} new_tip=${5:-} n f diff
	[[ -n $new_tip ]] || new_tip=$(tip_of "$b")
	[[ -n $new_base ]] || new_base=$(new_base_of "$b")
	n=$(issue_of_branch "$b")
	diff=$(G range-diff --no-color "$old_base..$old_tip" "$new_base..$new_tip")
	if ((${#diff} > COMMENT_LIMIT)); then
		diff="${diff:0:COMMENT_LIMIT}"$'\n'"[range-diff truncated at $COMMENT_LIMIT characters]"
	fi
	f=$(mktemp)
	{
		printf 'Ported `%s` onto %s for %s: `%s` -> `%s`.\n\n' "$b" \
			"$([[ $new_base == "$MASTER" ]] && printf '`master`' || printf 'the ported branch it depends on')" \
			"$RELEASE" "${old_tip:0:12}" "${new_tip:0:12}"
		printf '`git range-diff %s..%s %s..%s`\n\n' "${old_base:0:12}" "${old_tip:0:12}" "${new_base:0:12}" "${new_tip:0:12}"
		printf '````text\n%s\n````\n' "$diff"
	} >"$f"
	issue_comment "$n" "$f"
	rm -f "$f"
}

cmd_port_fail() {
	need_state
	local b=${1:?branch} n f
	shift
	local why=${*:?reason}
	n=$(issue_of_branch "$b")
	B rebase --abort 2>/dev/null || true
	B merge --abort 2>/dev/null || true
	f=$(mktemp)
	printf 'The routine could not port `%s` onto %s, so `stfl-next` and `stfl` stay where they are.\n\n%s\n' "$b" "$RELEASE" "$why" >"$f"
	issue_comment "$n" "$f"
	rm -f "$f"
	if ! has_label "$n" needs-rebase; then issue_label_add "$n" needs-rebase; fi
	printf '%s\n' "$b" >"$STATE_DIR/blocked"
	rm -f "$STATE_DIR/port"
	record "$b (#$n) NOT ported, labelled needs-rebase: $why"
}

# ---------------------------------------------------------------- publish

cmd_push_next() {
	need_state
	[[ ! -f $STATE_DIR/blocked ]] || die "$(cat "$STATE_DIR/blocked") could not be ported: stfl-next is not pushed"
	[[ ! -f $STATE_DIR/conflict ]] || die "$(cat "$STATE_DIR/conflict") still conflicts: port it and run build-next again"
	[[ -f $STATE_DIR/built ]] || die "nothing built: run build-next first"
	local sha lease
	sha=$(cat "$STATE_DIR/built")
	lease=$(G rev-parse --verify -q refs/remotes/origin/stfl-next || true)
	push_ref "$sha" stfl-next "$lease" || die "stfl-next was not pushed"
	record "stfl-next: pushed $sha (was ${lease:-absent})$(dry && printf ' (dry run)')"
}

cmd_dispatch() {
	need_state
	if act gh api -X POST "repos/$CI_REPO/actions/workflows/build.yml/dispatches" \
		-f ref=main -f 'inputs[dotfiles_ref]=main' --silent; then
		record "dispatch: $CI_REPO build.yml dispatched$(dry && printf ' (dry run)')"
	else
		record "dispatch: REFUSED; $CI_REPO's daily schedule at 06:30 UTC builds stfl-next anyway"
	fi
}

cmd_save_rerere() {
	need_state
	local src=$GIT_COMMON/rr-cache dst=$META_DIR/rr-cache
	if [[ -d $src ]] && [[ -n $(ls -A "$src") ]]; then
		rm -rf "$dst"
		cp -a "$src" "$dst"
	fi
	[[ -d $dst ]] || {
		record "rr-cache: empty, nothing to save"
		return 0
	}
	G add -A rr-cache
	if G diff --cached --quiet -- rr-cache; then
		record "rr-cache: unchanged"
		return 0
	fi
	if dry; then
		log "DRY-RUN: would commit rr-cache changes:"
		G diff --cached --stat -- rr-cache >&2
		G reset --quiet -- rr-cache
		return 0
	fi
	G commit --quiet -m "rr-cache: save the resolutions of the $RELEASE run" -- rr-cache
	push_ref "$(G rev-parse HEAD)" stfl-meta - || die "stfl-meta was not pushed"
	record "rr-cache: saved to stfl-meta $(G rev-parse --short HEAD)"
}

cmd_plan() {
	need_state
	local n labels branch pr deps out decision a base closing=()
	printf 'release: %s (%s), on upstream master\n' "$RELEASE" "$MASTER"
	printf 'master: %s at %s, %s\n' "$FORK" "${OLD_MASTER:0:12}" "$MASTER_MOVE"
	printf 'issues:\n'
	while IFS=$'\t' read -r n labels branch pr deps; do
		out=$(decide_issue "$n" "$labels" "$pr")
		IFS=$'\t' read -r decision a _ <<<"$out"
		case $decision in
		close)
			closing+=("$n")
			a="close: PR merged as ${a:0:12}"
			;;
		successor) a="add check-successor: $a" ;;
		esac
		base=$(waiting_base "$branch")
		[[ -z $base ]] || a+="; WAITING for a release: based on upstream ${base:0:12}, not in $RELEASE"
		printf '  #%-3s %-60s [%s] %s\n' "$n" "$branch" "$labels" "$a"
	done < <(open_issues)
	local reasons
	reasons=$(rebuild_reasons "${closing[@]}")
	if [[ -z $reasons ]]; then
		printf 'stfl-next: nothing to do (%s merges every open branch on %s)\n' "$CURRENT_NEXT" "$RELEASE"
	else
		printf 'stfl-next: rebuild from %s:\n' "$RELEASE"
		while read -r a; do printf '  - %s\n' "$a"; done <<<"$reasons"
	fi
}

cmd_cleanup() {
	if [[ -e $NEXT_DIR/.git ]]; then G worktree remove --force "$NEXT_DIR"; fi
	rm -rf "$STATE_DIR"
}

main() {
	while [[ $# -gt 0 ]]; do
		case $1 in
		--dry-run)
			DRY_RUN=1
			shift
			;;
		-h | --help | help)
			usage
			return
			;;
		*) break ;;
		esac
	done
	[[ $# -gt 0 ]] || {
		usage >&2
		exit 2
	}
	local cmd=$1
	shift
	dry && log "(dry run: pushes, issue writes and the dispatch are printed, not done)"
	case $cmd in
	setup) cmd_setup ;;
	plan) cmd_plan ;;
	sync) cmd_sync ;;
	build-next) cmd_build_next ;;
	port-begin) cmd_port_begin "$@" ;;
	port-test) cmd_port_test "$@" ;;
	port-finish) cmd_port_finish "$@" ;;
	port-fail) cmd_port_fail "$@" ;;
	port-report) cmd_port_report "$@" ;;
	push-next) cmd_push_next ;;
	dispatch) cmd_dispatch ;;
	save-rerere) cmd_save_rerere ;;
	summary) cat "$STATE_DIR/summary" ;;
	cleanup) cmd_cleanup ;;
	*)
		usage >&2
		exit 2
		;;
	esac
}

main "$@"
