import type { Cache } from '@gitlens/git/cache.js';
import type { GitServiceContext } from '@gitlens/git/context.js';
import type { GitBranch } from '@gitlens/git/models/branch.js';
import type { GitReference } from '@gitlens/git/models/reference.js';
import { deletedOrMissing } from '@gitlens/git/models/revision.js';
import type { GitTag } from '@gitlens/git/models/tag.js';
import type { GitRefsSubProvider } from '@gitlens/git/providers/refs.js';
import { createReference } from '@gitlens/git/utils/reference.utils.js';
import { isSha, isShaWithOptionalRevisionSuffix, isUncommitted } from '@gitlens/git/utils/revision.utils.js';
import { isCancellationError } from '@gitlens/utils/cancellation.js';
import { debug, trace } from '@gitlens/utils/decorators/log.js';
import { getScopedLogger } from '@gitlens/utils/logger.scoped.js';
import type { Uri } from '@gitlens/utils/uri.js';
import { toFsPath } from '@gitlens/utils/uri.js';
import type { CliGitProviderInternal } from '../cliGitProvider.js';
import type { Git } from '../exec/git.js';

export class RefsGitSubProvider implements GitRefsSubProvider {
	constructor(
		private readonly context: GitServiceContext,
		private readonly git: Git,
		private readonly cache: Cache,
		private readonly provider: CliGitProviderInternal,
	) {}

	@debug()
	async checkIfCouldBeValidBranchOrTagName(repoPath: string, ref: string): Promise<boolean> {
		try {
			const result = await this.git.run({ cwd: repoPath, errors: 'throw' }, 'check-ref-format', '--branch', ref);
			return Boolean(result.stdout.trim());
		} catch {
			return false;
		}
	}

	@debug()
	async getMergeBase(
		repoPath: string,
		ref1: string,
		ref2: string,
		options?: { forkPoint?: boolean },
		cancellation?: AbortSignal,
	): Promise<string | undefined> {
		const scope = getScopedLogger();

		try {
			const result = await this.git.run(
				{
					cwd: repoPath,
					cancellation: cancellation,
					// Why: ref1/ref2 are usually branch names; correctness relies on the gitResults cache being
					// cleared on 'heads'/'remotes' events when refs move. Web (no fs watcher) sees up to
					// `accessTTL` of staleness — acceptable trade-off for the perf win on graph/branch reads.
					caching: { cache: this.cache.gitResults, options: { accessTTL: 5 * 60 * 1000 } },
				},
				'merge-base',
				options?.forkPoint ? '--fork-point' : undefined,
				ref1,
				ref2,
			);
			if (!result.stdout) return undefined;

			return result.stdout.split('\n')[0].trim() || undefined;
		} catch (ex) {
			scope?.error(ex);
			if (isCancellationError(ex)) throw ex;

			return undefined;
		}
	}

	@debug()
	async getReference(repoPath: string, ref: string, cancellation?: AbortSignal): Promise<GitReference | undefined> {
		if (!ref || ref === deletedOrMissing) return undefined;

		if (!(await this.isValidReference(repoPath, ref, undefined, cancellation))) return undefined;

		if (ref !== 'HEAD' && !isShaWithOptionalRevisionSuffix(ref)) {
			const branch = await this.provider.branches.getBranch(repoPath, ref, cancellation);
			if (branch != null) {
				return createReference(branch.ref, repoPath, {
					id: branch.id,
					refType: 'branch',
					name: branch.name,
					remote: branch.remote,
					upstream: branch.upstream,
				});
			}

			const tag = await this.provider.tags.getTag(repoPath, ref, cancellation);
			if (tag != null) {
				return createReference(tag.ref, repoPath, {
					id: tag.id,
					refType: 'tag',
					name: tag.name,
				});
			}
		}

		return createReference(ref, repoPath, { refType: 'revision' });
	}

	@debug()
	async getSymbolicReferenceName(
		repoPath: string,
		ref: string,
		cancellation?: AbortSignal,
	): Promise<string | undefined> {
		const supportsEndOfOptions = await this.git.supports('git:rev-parse:end-of-options');

		const result = await this.git.run(
			{
				cwd: repoPath,
				cancellation: cancellation,
				errors: 'ignore',
				// Why: a fixed ref name's symbolic name is itself stable; only HEAD is mutable, and the
				// gitResults cache is cleared on 'head' events. 60s TTL is the failsafe for watcher
				// latency / web — matches the other "resolve symbolic state" calls in commits.ts.
				caching: { cache: this.cache.gitResults, options: { accessTTL: 60 * 1000 } },
			},
			'rev-parse',
			'--verify',
			'--quiet',
			'--symbolic-full-name',
			'--abbrev-ref',
			supportsEndOfOptions ? '--end-of-options' : undefined,
			ref,
		);
		return result.stdout.trim() || undefined;
	}

	@debug({ args: repoPath => ({ repoPath: repoPath }) })
	async hasBranchOrTag(
		repoPath: string | undefined,
		options?: {
			filter?: { branches?: (b: GitBranch) => boolean; tags?: (t: GitTag) => boolean };
		},
		cancellation?: AbortSignal,
	): Promise<boolean> {
		if (repoPath == null) return false;

		const [{ values: branches }, { values: tags }] = await Promise.all([
			this.provider.branches.getBranches(
				repoPath,
				{ filter: options?.filter?.branches, sort: false },
				cancellation,
			),
			this.provider.tags.getTags(repoPath, { filter: options?.filter?.tags, sort: false }, cancellation),
		]);

		return branches.length !== 0 || tags.length !== 0;
	}

	@debug()
	async isValidReference(
		repoPath: string,
		ref: string,
		pathOrUri?: string | Uri,
		cancellation?: AbortSignal,
	): Promise<boolean> {
		const path = pathOrUri != null ? toFsPath(pathOrUri) : undefined;
		const relativePath = path ? this.provider.getRelativePath(path, repoPath) : undefined;
		return Boolean((await this.validateReference(repoPath, ref, relativePath, cancellation))?.length);
	}

	@trace()
	async validateReference(
		repoPath: string,
		ref: string,
		relativePath?: string,
		cancellation?: AbortSignal,
	): Promise<string | undefined> {
		if (!ref) return undefined;
		if (ref === deletedOrMissing || isUncommitted(ref)) return ref;

		const supportsEndOfOptions = await this.git.supports('git:rev-parse:end-of-options');

		// Why: a SHA-only validation (no path suffix) is effectively immutable — 5-min TTL is safe.
		// Otherwise the resolved SHA can shift on ref move (or working-tree change for path-scoped
		// validation); rely on gitResults being cleared on 'head'/'heads'/'remotes' events, with 60s
		// TTL as the failsafe for watcher latency / web.
		const stable = relativePath == null && isSha(ref);
		const result = await this.git.run(
			{
				cwd: repoPath,
				cancellation: cancellation,
				errors: 'ignore',
				caching: {
					cache: this.cache.gitResults,
					options: { accessTTL: stable ? 5 * 60 * 1000 : 60 * 1000 },
				},
			},
			'rev-parse',
			'--verify',
			supportsEndOfOptions ? '--end-of-options' : undefined,
			relativePath ? `${ref}:./${relativePath}` : `${ref}^{commit}`,
		);
		return result.stdout.trim() || undefined;
	}

	@debug()
	async updateReference(repoPath: string, ref: string, newRef: string, cancellation?: AbortSignal): Promise<void> {
		const scope = getScopedLogger();

		try {
			await this.git.run({ cwd: repoPath, cancellation: cancellation }, 'update-ref', ref, newRef);
		} catch (ex) {
			scope?.error(ex);
			if (isCancellationError(ex)) throw ex;
		}
	}
}
