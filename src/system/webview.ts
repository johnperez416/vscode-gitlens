import type { GlPlusCommands, GlWebviewCommands } from '../constants.commands.js';
import type { WebviewIds } from '../constants.views.js';

export function createWebviewCommandLink<T>(
	command: GlWebviewCommands | GlPlusCommands,
	webviewId: WebviewIds,
	webviewInstanceId: string | undefined,
	args?: T,
): string {
	return `command:${command}?${encodeURIComponent(
		JSON.stringify({ webview: webviewId, webviewInstance: webviewInstanceId, ...args } satisfies WebviewContext),
	)}`;
}

export interface WebviewContext {
	webview: WebviewIds;
	webviewInstance: string | undefined;
}

export function isWebviewContext(item: object | null | undefined): item is WebviewContext {
	if (item == null) return false;

	return 'webview' in item && item.webview != null;
}

export interface WebviewItemContext<TValue = unknown> extends Partial<WebviewContext> {
	webviewItem: string;
	webviewItemValue: TValue;
	webviewItemsValues?: { webviewItem: string; webviewItemValue: TValue }[];
}

export function isWebviewItemContext<TValue = unknown>(
	item: object | null | undefined,
): item is WebviewItemContext<TValue> & WebviewContext {
	if (item == null) return false;

	return 'webview' in item && item.webview != null && 'webviewItem' in item;
}

export interface WebviewItemGroupContext<TValue = unknown> extends Partial<WebviewContext> {
	webviewItemGroup: string;
	webviewItemGroupValue: TValue;
}

export function isWebviewItemGroupContext<TValue = unknown>(
	item: object | null | undefined,
): item is WebviewItemGroupContext<TValue> & WebviewContext {
	if (item == null) return false;

	return 'webview' in item && item.webview != null && 'webviewItemGroup' in item;
}

export function serializeWebviewItemContext<T = WebviewItemContext | WebviewItemGroupContext>(context: T): string {
	return JSON.stringify(context);
}

/**
 * Returns a copy of `context` with `+<flag>` appended to its `webviewItem` string. Used for
 * conditionally-applied flags like `+working` whose state isn't known at the time the host
 * builds the base context (e.g. async `hasChanges` resolution for worktrees). No-op if the
 * flag is already present so repeated applications are idempotent.
 */
export function withWebviewItemFlag<T extends WebviewItemContext>(context: T, flag: string): T {
	const re = new RegExp(`\\+${flag}\\b`);
	if (re.test(context.webviewItem)) return context;
	return { ...context, webviewItem: `${context.webviewItem}+${flag}` };
}
