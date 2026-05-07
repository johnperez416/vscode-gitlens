import type { AgentSessionPhase } from '../../../agents/provider.js';
import type { AgentSessionState } from '../../home/protocol.js';
import type { OverviewBranch } from '../../shared/overviewBranches.js';

const phaseRank: Record<AgentSessionPhase, number> = {
	waiting: 0,
	working: 1,
	idle: 2,
};

export type AgentSessionCategory = 'working' | 'needs-input' | 'idle';

export const agentPhaseToCategory: Record<AgentSessionPhase, AgentSessionCategory> = {
	working: 'working',
	waiting: 'needs-input',
	idle: 'idle',
};

export function getAgentCategoryLabel(category: AgentSessionCategory): string {
	switch (category) {
		case 'needs-input':
			return 'Needs input';
		case 'working':
			return 'Working';
		case 'idle':
			return 'Idle';
	}
}

/** "Last active …" granularity helper used by the graph details panel and the graph agents
 *  sidebar panel — short-and-stable formatting (no seconds past 1 minute). The agent-status pill
 *  has its own slightly more granular variant inline. */
export function formatAgentElapsed(timestamp: number | undefined): string | undefined {
	if (timestamp == null) return undefined;
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/** Per-session "what is it doing" line. Mirrors the contract used by the graph details panel:
 *  needs-input → awaiting tool; working tool_use → current tool; otherwise last-active timestamp
 *  or the most-recent prompt. */
export function describeAgentSession(
	session: AgentSessionState,
	category: AgentSessionCategory,
	elapsed: string | undefined,
	options: { awaitingPrefix?: 'long' | 'short'; idleFallback?: 'lastActive' | 'lastPrompt' } = {},
): string | undefined {
	const awaitingPrefix = options.awaitingPrefix ?? 'long';
	const idleFallback = options.idleFallback ?? 'lastActive';
	const detail = session.pendingPermissionDetail;

	if (category === 'needs-input' && detail != null) {
		if (detail.toolName == null) return 'Awaiting permission';
		const prefix = awaitingPrefix === 'long' ? 'Awaiting permission:' : 'Awaiting:';
		return `${prefix} ${detail.toolName}${detail.toolDescription ? ` — ${detail.toolDescription}` : ''}`;
	}
	if (category === 'working' && session.status === 'tool_use' && session.statusDetail) {
		return `Running ${session.statusDetail}`;
	}
	if (idleFallback === 'lastActive' && elapsed != null) return `Last active ${elapsed} ago`;
	return session.lastPrompt || undefined;
}

/** Canonical sort order for agent sessions across every UI surface. Category-actionability first
 *  (needs-input → working → idle), then most-recent activity within a category, then alphabetical
 *  by name. Applied once at each state-entry point so all consumers — banners, pills, cards,
 *  hovers — render the same order. Actionable always wins: a fresh idle session never outranks a
 *  session that's actually waiting on you. */
export function sortAgentSessions(sessions: readonly AgentSessionState[]): AgentSessionState[] {
	return sessions.toSorted((a, b) => {
		const ra = phaseRank[a.phase];
		const rb = phaseRank[b.phase];
		if (ra !== rb) {
			return ra - rb;
		}
		const ta = a.lastActivityTimestamp ?? a.phaseSinceTimestamp ?? 0;
		const tb = b.lastActivityTimestamp ?? b.phaseSinceTimestamp ?? 0;

		if (ta !== tb) {
			return tb - ta;
		}

		return (a.name ?? '').localeCompare(b.name ?? '');
	});
}

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

/** Reverse of {@link matchAgentSessionsForBranch}: given a session, find the matching
 *  `OverviewBranch` in the supplied buckets so the graph agents sidebar can scope-and-select
 *  the same target the overview cards do. Same disambiguation rule (branch name +
 *  workspacePath/repoPath, with worktree-name tie-break when both sides have it). */
export function findOverviewBranchForSession(
	branches: { active: readonly OverviewBranch[]; recent: readonly OverviewBranch[] } | undefined,
	session: AgentSessionState,
): OverviewBranch | undefined {
	if (branches == null || session.branch == null || session.workspacePath == null) return undefined;

	for (const candidate of [...branches.active, ...branches.recent]) {
		if (candidate.name !== session.branch) continue;
		if (candidate.repoPath !== session.workspacePath) continue;
		const candidateWorktree = candidate.worktree != null ? getWorktreeBasename(candidate.worktree.uri) : undefined;
		if (session.worktreeName != null && candidateWorktree != null && session.worktreeName !== candidateWorktree) {
			continue;
		}
		return candidate;
	}

	return undefined;
}
