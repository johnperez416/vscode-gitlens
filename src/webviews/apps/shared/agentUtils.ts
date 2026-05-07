import type { AgentSessionState } from '../../home/protocol.js';

/** Identifies a branch+worktree the matcher should resolve sessions for. `repoPath` must be the
 *  path that `session.workspacePath` is normalized to on the host — i.e. the **main repo's path**
 *  for any branch in any of its worktrees. `worktreeName` (the worktree directory's basename) is
 *  set when the branch is checked out in a non-default worktree; it disambiguates same-named
 *  branches across sibling worktrees. */
export interface AgentSessionBranchTarget {
	name: string;
	repoPath: string;
	worktreeName?: string;
}

export type AgentSessionBranchIndex = Map<string, AgentSessionState[]>;

/** Trailing-slash–safe basename for both filesystem paths and `file://` URIs. Returns `''` only
 *  when the input has no segment (root or empty), matching the prior `.split('/').pop() ?? ''`
 *  behavior closely enough that no caller needs to special-case it. */
export function getWorktreeBasename(pathOrUri: string): string {
	const trimmed = pathOrUri.replace(/[/\\]+$/, '');
	const slash = trimmed.lastIndexOf('/');
	const back = trimmed.lastIndexOf('\\');
	const idx = Math.max(slash, back);
	return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Builds a lookup index for batch matching across many branches in one render (overview cards).
 *  Single-shot consumers can call {@link matchAgentSessionsForBranch} directly with the array. */
export function indexAgentSessionsByRepoAndBranch(
	sessions: readonly AgentSessionState[] | undefined,
): AgentSessionBranchIndex | undefined {
	if (sessions == null || sessions.length === 0) return undefined;

	const index: AgentSessionBranchIndex = new Map();
	for (const session of sessions) {
		if (session.branch == null || session.workspacePath == null) continue;
		const key = `${session.workspacePath}\0${session.branch}`;
		const existing = index.get(key);
		if (existing != null) {
			existing.push(session);
		} else {
			index.set(key, [session]);
		}
	}
	return index;
}

/** Returns the agent sessions that match a given branch target. Accepts either the full
 *  `AgentSessionState[]` (single-shot, O(n)) or a prebuilt {@link AgentSessionBranchIndex} (batch,
 *  O(1) lookup). Filters by `branch` + `workspacePath`, with worktree-name disambiguation when
 *  both sides have it (same rule across overview, home, and graph details — keep them aligned). */
export function matchAgentSessionsForBranch(
	source: readonly AgentSessionState[] | AgentSessionBranchIndex | undefined,
	target: AgentSessionBranchTarget,
): AgentSessionState[] | undefined {
	if (source == null) return undefined;

	let candidates: readonly AgentSessionState[];
	if (source instanceof Map) {
		const found = source.get(`${target.repoPath}\0${target.name}`);
		if (found == null) return undefined;
		candidates = found;
	} else {
		if (source.length === 0) return undefined;
		candidates = source;
	}

	const matches = candidates.filter(session => {
		if (session.branch !== target.name) return false;
		if (session.workspacePath !== target.repoPath) return false;
		// When both sides know the worktree, names must match — guards against same-named
		// branches in sibling worktrees colliding. When only one side has worktree info, fall
		// through and accept (preserves the overview's prior behavior).
		if (session.worktreeName != null && target.worktreeName != null) {
			return session.worktreeName === target.worktreeName;
		}
		return true;
	});

	return matches.length > 0 ? matches : undefined;
}
