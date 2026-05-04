import type { GitFileConflictStatus } from '@gitlens/git/models/fileStatus.js';
import { pluralize } from '@gitlens/utils/string.js';
import type { TreeItemDecoration, TreeItemDecorationKind } from './base.js';

export const conflictActions: Record<string, { label: string; kind: TreeItemDecorationKind }> = {
	A: { label: 'Added', kind: 'added' },
	D: { label: 'Deleted', kind: 'deleted' },
	U: { label: 'Modified', kind: 'modified' },
};

export function getConflictStatusInfo(
	status: GitFileConflictStatus,
	branchName?: string,
): { label: string; kind: TreeItemDecorationKind; description: string } | undefined {
	// First char = current (ours in rebase = onto/target), second char = incoming (theirs in rebase = branch)
	const currentAction = conflictActions[status[0]];
	const incomingAction = conflictActions[status[1]];
	if (currentAction == null || incomingAction == null) return undefined;

	const kind = currentAction.kind === conflictActions.U.kind ? incomingAction.kind : currentAction.kind;
	const branch = branchName ? `$(git-branch) ${branchName}` : 'incoming';

	if (status[0] === status[1]) {
		return {
			label: `${currentAction.label} (Both)`,
			kind: kind,
			description: `${currentAction.label} on both ${branch} and the target`,
		};
	}

	return {
		label: `${currentAction.label} (Current), ${incomingAction.label} (Incoming)`,
		kind: kind,
		description: `${incomingAction.label} on ${branch}\n${currentAction.label} on the target`,
	};
}

export function getConflictDecorations(
	conflictStatus: GitFileConflictStatus,
	conflictCount: number | undefined,
	branchName?: string,
): TreeItemDecoration[] | undefined {
	const info = getConflictStatusInfo(conflictStatus, branchName);
	const decorations: TreeItemDecoration[] = [];

	if (info != null) {
		decorations.push({
			type: 'text',
			label: conflictStatus,
			tooltip: info.description,
			kind: info.kind,
			position: 'after',
		});
		decorations.push({
			type: 'text',
			label: info.label,
			tooltip: info.label,
			kind: 'muted',
			position: 'before',
		});
	}

	if (conflictCount != null && conflictCount > 0) {
		decorations.push({
			type: 'conflict',
			label: pluralize('conflict', conflictCount),
			count: conflictCount,
			tooltip: pluralize('conflict', conflictCount),
			kind: info?.kind ?? conflictActions.U.kind,
			position: 'before',
		});
	}

	return decorations.length ? decorations : undefined;
}

export function getConflictTooltip(
	conflictStatus: GitFileConflictStatus,
	conflictCount: number | undefined,
	branchName?: string,
): string {
	const info = getConflictStatusInfo(conflictStatus, branchName);
	const parts: string[] = [];

	if (info != null) {
		parts.push(`**${info.label}** (${conflictStatus})`);
		parts.push(info.description);
	}

	if (conflictCount != null && conflictCount > 0) {
		parts.push(pluralize('conflict', conflictCount));
	}

	return parts.join('\n\n');
}
