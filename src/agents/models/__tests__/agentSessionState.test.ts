import * as assert from 'node:assert';
import type { AgentSession } from '@gitlens/agents/types.js';
import { getSessionDisplayName } from '../agentSessionState.js';

function makeSession(overrides: Partial<AgentSession>): AgentSession {
	return {
		id: 'session-1',
		providerId: 'claudeCode',
		providerName: 'Claude Code',
		status: 'idle',
		phase: 'idle',
		phaseSince: new Date(0),
		lastActivity: new Date(0),
		isSubagent: false,
		isInWorkspace: true,
		...overrides,
	};
}

suite('getSessionDisplayName', () => {
	test('prefers the harness-supplied name', () => {
		const session = makeSession({
			name: 'Refactor auth',
			firstPrompt: 'do something else',
			worktreePath: '/repo/.worktrees/feature-x',
			cwd: '/Users/me/repo',
		});
		assert.strictEqual(getSessionDisplayName(session, 'feature-x'), 'Refactor auth');
	});

	test('falls back to a prompt-derived name when no harness name', () => {
		const session = makeSession({
			firstPrompt: 'please fix the login bug',
			worktreePath: '/repo/.worktrees/feature-x',
			cwd: '/Users/me/repo',
		});
		assert.strictEqual(getSessionDisplayName(session, 'feature-x'), 'Fix the login bug');
	});

	test('falls back to a lastPrompt-derived name when firstPrompt is missing', () => {
		const session = makeSession({
			lastPrompt: 'please rename the foo helper',
			worktreePath: '/repo/.worktrees/feature-x',
			cwd: '/Users/me/repo',
		});
		assert.strictEqual(getSessionDisplayName(session, 'feature-x'), 'Rename the foo helper');
	});

	test('prefers firstPrompt over lastPrompt when both yield names', () => {
		const session = makeSession({
			firstPrompt: 'implement search',
			lastPrompt: 'fix the typo',
		});
		assert.strictEqual(getSessionDisplayName(session, undefined), 'Implement search');
	});

	test('falls back to the resolved worktree name when prompt yields nothing', () => {
		const session = makeSession({
			worktreePath: '/repo/.worktrees/feature-x',
			cwd: '/Users/me/repo',
		});
		assert.strictEqual(getSessionDisplayName(session, 'feature-x'), 'On feature-x');
	});

	test('falls back to the worktree path basename when no resolved name', () => {
		const session = makeSession({
			worktreePath: '/repo/.worktrees/feature-x',
			cwd: '/Users/me/repo',
		});
		assert.strictEqual(getSessionDisplayName(session, undefined), 'On feature-x');
	});

	test('falls back to the cwd basename when no worktree info', () => {
		const session = makeSession({ cwd: '/Users/me/code/my-project' });
		assert.strictEqual(getSessionDisplayName(session, undefined), 'On my-project');
	});

	test('handles trailing separators on cwd', () => {
		const session = makeSession({ cwd: '/Users/me/code/my-project/' });
		assert.strictEqual(getSessionDisplayName(session, undefined), 'On my-project');
	});

	test('handles Windows-style cwd separators', () => {
		const session = makeSession({ cwd: 'D:\\PROJ\\GKGL\\vscode-gitlens' });
		assert.strictEqual(getSessionDisplayName(session, undefined), 'On vscode-gitlens');
	});

	test('falls back to the provider name when nothing else is available', () => {
		const session = makeSession({});
		assert.strictEqual(getSessionDisplayName(session, undefined), 'Claude Code');
	});

	test('falls back to the provider name when only an empty cwd is set', () => {
		const session = makeSession({ cwd: '/' });
		assert.strictEqual(getSessionDisplayName(session, undefined), 'Claude Code');
	});
});
