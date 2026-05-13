/**
 * gl-file-icon — renders a file icon from the bundled Seti icon theme font.
 *
 * Accepts a filename, resolves the icon internally from the Seti mapping,
 * and renders the appropriate font glyph with color.
 */

import type { PropertyValues } from 'lit';
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { SetiIcon } from './seti-icons.js';
import { resolveSetiFileIcon } from './seti-icons.js';

@customElement('gl-file-icon')
export class GlFileIcon extends LitElement {
	static override styles = css`
		:host {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			width: var(--gl-file-icon-size, 16px);
			height: var(--gl-file-icon-size, 16px);
			vertical-align: text-bottom;
		}

		.font-icon {
			display: inline-block;
			font-family: 'seti';
			font-size: var(--gl-file-icon-size, 16px);
			line-height: 1;
			text-align: center;
			-webkit-font-smoothing: antialiased;
			-moz-osx-font-smoothing: grayscale;
		}
	`;

	@property()
	filename?: string;

	private _icon?: SetiIcon;

	override willUpdate(changed: PropertyValues): void {
		if (!changed.has('filename')) return;

		if (this.filename == null) {
			this._icon = undefined;
			return;
		}

		const isLight =
			document.body.classList.contains('vscode-light') ||
			document.body.classList.contains('vscode-high-contrast-light');
		this._icon = resolveSetiFileIcon(this.filename, isLight);
	}

	override updated(changed: PropertyValues): void {
		if (!changed.has('filename')) return;
		// Set color via CSSOM on the host (inherits to .font-icon) — the webview CSP forbids
		// inline `style="…"` attributes; direct property writes are allowed.
		this.style.color = this._icon?.color ?? '';
	}

	override render(): unknown {
		if (this._icon == null) return nothing;
		return html`<span class="font-icon">${parseFontCharacter(this._icon.character)}</span>`;
	}
}

/**
 * Parse a font character string like "\\E001" into the actual Unicode character.
 */
function parseFontCharacter(char: string): string {
	if (char.length === 1) return char;

	const match = /^\\+(?:u)?([0-9a-fA-F]{4,6})$/.exec(char);
	if (match != null) {
		return String.fromCodePoint(parseInt(match[1], 16));
	}

	return char;
}

declare global {
	interface HTMLElementTagNameMap {
		'gl-file-icon': GlFileIcon;
	}
}
