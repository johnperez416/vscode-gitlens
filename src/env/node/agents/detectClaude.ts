import { access, constants as fsConstants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { platform, env as processEnv } from 'process';

const cacheTtlMs = 30_000;
let cache: { value: boolean; expiresAt: number } | undefined;
let inflight: Promise<boolean> | undefined;

/**
 * Returns whether the `claude` binary (Claude Code CLI) is on PATH. Result is cached for
 * {@link cacheTtlMs}; concurrent callers share the same in-flight probe so banner-render
 * bursts don't hammer the filesystem.
 */
export function isClaudeAvailable(): Promise<boolean> {
	const c = cache;
	if (c != null && c.expiresAt > Date.now()) return Promise.resolve(c.value);

	if (inflight != null) return inflight;

	inflight = (async () => {
		try {
			const value = await isExecutableOnPath('claude');
			cache = { value: value, expiresAt: Date.now() + cacheTtlMs };
			return value;
		} finally {
			inflight = undefined;
		}
	})();

	return inflight;
}

async function isExecutableOnPath(name: string): Promise<boolean> {
	const pathEnv = processEnv.PATH;
	if (!pathEnv) return false;

	const dirs = pathEnv.split(delimiter).filter(Boolean);
	const isWindows = platform === 'win32';
	const exts = isWindows ? (processEnv.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];

	for (const dir of dirs) {
		for (const ext of exts) {
			try {
				await access(join(dir, `${name}${ext}`), isWindows ? fsConstants.F_OK : fsConstants.X_OK);
				return true;
			} catch {
				// not here, keep looking
			}
		}
	}
	return false;
}
