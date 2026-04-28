import type { GraphRow } from '@gitkraken/gitkraken-components';

/**
 * Returns the committer-date for a graph row. The webview's `GraphRow` type from the components lib
 * doesn't surface `commitDate`, but the GitGraphRow source (`packages/git-cli/src/providers/graph.ts`)
 * always populates it with the committer date — `row.date` itself follows the user's commit-ordering
 * setting (committer or author). The minimap (and any timeline-anchored visual) should pin to
 * committer date so a rebased commit doesn't teleport backward to its original author date.
 */
export function getCommitDateFromRow(row: GraphRow): number {
	return (row as GraphRow & { commitDate?: number }).commitDate ?? row.date;
}
