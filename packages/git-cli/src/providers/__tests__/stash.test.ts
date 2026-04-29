import * as assert from 'assert';
import type { GitStashCommit } from '@gitlens/git/models/commit.js';
import { GitCommitIdentity } from '@gitlens/git/models/commit.js';
import { findOldestStashTimestamp } from '../stash.js';

type ParentTimestampInput = { sha: string; authorDate: number; committerDate: number };

suite('findOldestStashTimestamp Test Suite', () => {
	function createMockStashCommit(date: Date, parentShas: string[] = []): Partial<GitStashCommit> {
		return {
			committer: new GitCommitIdentity('Test', 'test@test.com', date),
			parents: parentShas,
		};
	}

	function buildParentTimestamps(
		entries: ParentTimestampInput[],
	): Map<string, { authorDate: number; committerDate: number }> {
		const map = new Map<string, { authorDate: number; committerDate: number }>();
		for (const e of entries) {
			map.set(e.sha, { authorDate: e.authorDate, committerDate: e.committerDate });
		}
		return map;
	}

	test('should return Infinity for empty stashes collection', () => {
		const result = findOldestStashTimestamp([], new Map());
		assert.strictEqual(result, Infinity);
	});

	test('should return stash date when no parent timestamps exist', () => {
		const stashDate = new Date('2022-01-02T12:00:00Z');
		const stashes = [createMockStashCommit(stashDate)] as GitStashCommit[];

		const result = findOldestStashTimestamp(stashes, new Map());
		assert.strictEqual(result, stashDate.getTime());
	});

	test('should return stash date when parents have no entries in the timestamp map', () => {
		const stashDate = new Date('2022-01-02T12:00:00Z');
		const stashes = [createMockStashCommit(stashDate, ['parent1'])] as GitStashCommit[];

		const result = findOldestStashTimestamp(stashes, new Map());
		assert.strictEqual(result, stashDate.getTime());
	});

	test('should return oldest parent timestamp when parent is older than stash', () => {
		const stashDate = new Date('2022-01-02T12:00:00Z');
		const oldest = 1640995200; // 2022-01-01 00:00:00 UTC
		const stashes = [createMockStashCommit(stashDate, ['parent1'])] as GitStashCommit[];
		const parentTimestamps = buildParentTimestamps([
			{ sha: 'parent1', authorDate: oldest, committerDate: 1640995260 },
		]);

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		const expectedOldest = oldest * 1000; // Convert to milliseconds
		assert.strictEqual(result, expectedOldest);
	});

	test('should return stash date when stash is older than parents', () => {
		const stashDate = new Date('2022-01-01T00:00:00Z'); // Older
		const stashes = [createMockStashCommit(stashDate, ['parent1'])] as GitStashCommit[];
		const parentTimestamps = buildParentTimestamps([
			{ sha: 'parent1', authorDate: 1641081600, committerDate: 1641081660 }, // 2022-01-02 00:00:00 UTC (newer)
		]);

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		assert.strictEqual(result, stashDate.getTime());
	});

	test('should handle multiple stashes and find the globally oldest timestamp', () => {
		const stash1Date = new Date('2022-01-03T00:00:00Z');
		const oldest = 1640995200; // 2022-01-01 00:00:00 UTC (oldest overall)
		const stash2Date = new Date('2022-01-02T00:00:00Z');

		const stashes = [
			createMockStashCommit(stash1Date, ['parent1']),
			createMockStashCommit(stash2Date, ['parent2']),
		] as GitStashCommit[];
		const parentTimestamps = buildParentTimestamps([
			{ sha: 'parent1', authorDate: oldest, committerDate: 1640995260 },
			{ sha: 'parent2', authorDate: 1641081600, committerDate: 1641081660 }, // 2022-01-02 00:00:00 UTC
		]);

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		const expectedOldest = oldest * 1000; // parent1's authorDate
		assert.strictEqual(result, expectedOldest);
	});

	test('should consider both authorDate and committerDate of parents', () => {
		const stashDate = new Date('2022-01-02T00:00:00Z');
		const oldest = 1640995200; // 2022-01-01 00:00:00 UTC (older)
		const stashes = [createMockStashCommit(stashDate, ['parent1'])] as GitStashCommit[];
		const parentTimestamps = buildParentTimestamps([
			{ sha: 'parent1', authorDate: 1641081600, committerDate: oldest }, // committerDate is older
		]);

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		const expectedOldest = oldest * 1000;
		assert.strictEqual(result, expectedOldest);
	});

	test('should skip non-finite parent timestamp fields (NaN from missing git output)', () => {
		// `Number('')` is 0 and `Number(undefined)` is NaN — both can leak from a malformed parser
		// result; the function must skip them so they don't corrupt the Math.min.
		const stashDate = new Date('2022-01-02T00:00:00Z');
		const oldest = 1640995200; // 2022-01-01 00:00:00 UTC
		const stashes = [createMockStashCommit(stashDate, ['parent1', 'parent2'])] as GitStashCommit[];
		const parentTimestamps = buildParentTimestamps([
			{ sha: 'parent1', authorDate: NaN, committerDate: NaN },
			{ sha: 'parent2', authorDate: oldest, committerDate: NaN },
		]);

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		const expectedOldest = oldest * 1000; // Only valid timestamp
		assert.strictEqual(result, expectedOldest);
	});

	test('should handle multiple parents per stash', () => {
		const stashDate = new Date('2022-01-03T00:00:00Z');
		const oldest = 1640995200; // 2022-01-01 00:00:00 UTC (oldest)
		const stashes = [createMockStashCommit(stashDate, ['parent1', 'parent2', 'parent3'])] as GitStashCommit[];
		const parentTimestamps = buildParentTimestamps([
			{ sha: 'parent1', authorDate: 1641081600, committerDate: 1641081660 }, // 2022-01-02 00:00:00 UTC
			{ sha: 'parent2', authorDate: oldest, committerDate: 1640995260 },
			{ sha: 'parent3', authorDate: 1641168000, committerDate: 1641168060 }, // 2022-01-03 00:00:00 UTC
		]);

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		const expectedOldest = oldest * 1000; // parent2's authorDate
		assert.strictEqual(result, expectedOldest);
	});

	test('should work with Map.values() as used in production code', () => {
		const stashMap = new Map<string, GitStashCommit>();
		const oldest = 1640995200; // 2022-01-01 00:00:00 UTC (oldest)

		const stash1Date = new Date('2022-01-02T00:00:00Z');
		stashMap.set('stash1', createMockStashCommit(stash1Date, ['parent1']) as GitStashCommit);
		const parentTimestamps = buildParentTimestamps([
			{ sha: 'parent1', authorDate: oldest, committerDate: 1640995260 },
		]);

		const result = findOldestStashTimestamp(stashMap.values(), parentTimestamps);
		const expectedOldest = oldest * 1000;
		assert.strictEqual(result, expectedOldest);
	});

	test('should fall back to stash date when every parent timestamp is non-finite', () => {
		const stashDate = new Date('2022-01-02T00:00:00Z');
		const stashes = [createMockStashCommit(stashDate, ['parent1'])] as GitStashCommit[];
		const parentTimestamps = buildParentTimestamps([{ sha: 'parent1', authorDate: NaN, committerDate: NaN }]);

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		assert.strictEqual(result, stashDate.getTime()); // Falls back to stash date
	});

	test('should handle very large collections efficiently', () => {
		const stashes: GitStashCommit[] = [];
		const baseTime = new Date('2022-01-01T00:00:00Z').getTime();
		const parentTimestamps = new Map<string, { authorDate: number; committerDate: number }>();

		// Create 1000 stashes with various timestamps
		for (let i = 0; i < 1000; i++) {
			const stashDate = new Date(baseTime + i * 60000); // Each stash 1 minute apart
			const parentSha = `parent${i}`;
			stashes.push(createMockStashCommit(stashDate, [parentSha]) as GitStashCommit);
			parentTimestamps.set(parentSha, {
				authorDate: Math.floor((baseTime + i * 30000) / 1000), // 30 seconds apart
				committerDate: Math.floor((baseTime + i * 45000) / 1000), // 45 seconds apart
			});
		}

		const result = findOldestStashTimestamp(stashes, parentTimestamps);
		assert.strictEqual(result, baseTime); // Should be the first parent's authorDate
	});
});
