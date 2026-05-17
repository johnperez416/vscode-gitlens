import { uncommitted } from '@gitlens/git/models/revision.js';
import { createSecondaryWipSha } from '../../../../plus/graph/protocol.js';
import type { OverviewBranch, OverviewBranchWip } from '../../../../shared/overviewBranches.js';

/** Returns the graph-row SHA to select when the user picks a branch from a webview-side panel
 *  (overview cards, agents sidebar, etc.). Cascade matches the rules everywhere graph navigation
 *  for a branch fires:
 *    1. Secondary worktree (path differs from `branch.repoPath`) → that worktree's WIP row.
 *    2. Currently-opened branch with working changes → primary WIP (`uncommitted`).
 *    3. Otherwise → the branch's tip commit.
 *  Returns `undefined` only when the branch has no resolvable tip (e.g. the cheap reference is
 *  missing a sha) — callers treat that as a no-op navigation. */
export function getOverviewBranchSelectionSha(
	branch: OverviewBranch,
	wip: OverviewBranchWip | undefined,
): string | undefined {
	if (branch.worktree != null && branch.worktree.path !== branch.repoPath) {
		return createSecondaryWipSha(branch.worktree.path);
	}

	if (branch.opened) {
		const state = wip?.workingTreeState;
		const hasWip = state != null && state.added + state.changed + state.deleted > 0;
		if (hasWip) return uncommitted;
	}

	return branch.reference.sha;
}
