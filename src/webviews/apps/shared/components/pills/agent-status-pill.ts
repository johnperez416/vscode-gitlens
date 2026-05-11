import type { PropertyValues } from 'lit';
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { createCommandLink } from '../../../../../system/commands.js';
import type { AgentSessionState } from '../../../../home/protocol.js';
import type { AgentSessionCategory } from '../../agentUtils.js';
import { agentPhaseToCategory, getAgentCategoryLabel } from '../../agentUtils.js';
import { elementBase, linkBase } from '../styles/lit/base.css.js';
import '../actions/action-item.js';
import '../actions/action-nav.js';
import '../button.js';
import '../code-icon.js';
import '../overlays/popover.js';

function formatElapsed(timestamp: number | undefined): string | undefined {
	if (timestamp == null) return undefined;

	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

declare global {
	interface HTMLElementTagNameMap {
		'gl-agent-status-pill': GlAgentStatusPill;
	}
}

@customElement('gl-agent-status-pill')
export class GlAgentStatusPill extends LitElement {
	static override styles = [
		elementBase,
		linkBase,
		css`
			:host {
				display: inline-block;
				--max-width: 30rem;

				/* Working (blue) */
				--gl-agent-pill-working-color: var(--vscode-progressBar-background);
				--gl-agent-pill-working-bg: color-mix(in srgb, var(--gl-agent-pill-working-color) 10%, transparent);
				--gl-agent-pill-working-border: color-mix(in srgb, var(--gl-agent-pill-working-color) 50%, transparent);

				/* Needs Input (amber/warning). Border is brighter than the other categories
				   (75% vs. 50%/35%) so the static state already communicates "this one's
				   different" before the breathing animation kicks in. */
				--gl-agent-pill-attention-color: var(--vscode-editorWarning-foreground);
				--gl-agent-pill-attention-bg: color-mix(in srgb, var(--gl-agent-pill-attention-color) 10%, transparent);
				--gl-agent-pill-attention-bg-peak: color-mix(
					in srgb,
					var(--gl-agent-pill-attention-color) 22%,
					transparent
				);
				--gl-agent-pill-attention-border: color-mix(
					in srgb,
					var(--gl-agent-pill-attention-color) 75%,
					transparent
				);

				/* Idle (muted) */
				--gl-agent-pill-idle-color: var(--vscode-descriptionForeground);
				--gl-agent-pill-idle-bg: color-mix(in srgb, var(--gl-agent-pill-idle-color) 10%, transparent);
				--gl-agent-pill-idle-border: color-mix(in srgb, var(--gl-agent-pill-idle-color) 35%, transparent);
			}

			/* Pill badge */
			.pill {
				/* border-box so the 1px border counts inside the 100% width — without it the pill
				   bleeds 2px past its container in full mode. */
				box-sizing: border-box;
				display: inline-flex;
				align-items: center;
				padding: 0.1rem 0.6rem;
				border-radius: 50px;
				border: 1px solid transparent;
				font-size: 0.85em;
				font-weight: 500;
				line-height: normal;
				white-space: nowrap;
				cursor: default;
				transition:
					background-color 250ms ease,
					border-color 250ms ease,
					color 250ms ease;
			}

			.pill__label {
				display: inline-flex;
				align-items: center;
				gap: 0.4rem;
				min-width: 0;
			}

			.pill__dot {
				width: 5px;
				height: 5px;
				border-radius: 50%;
				flex: none;
				transition: background-color 250ms ease;
			}

			/* Full mode — pill grows to fill its container and surfaces inline actions on the
			   right of the label. The popover anchor still wraps the whole pill so hover/focus
			   keeps surfacing the rich detail (without duplicating the action row).
			   full-active is a host-managed attribute, distinct from the public full prop, so the
			   needs-input + !canResolve fallback can still render compact even when the consumer
			   requested full. */
			:host([full-active]) {
				display: block;
				width: 100%;
			}

			:host([full-active]) gl-popover {
				display: block;
				--gl-popover-anchor-width: 100%;
			}

			:host([full-active]) .pill {
				display: flex;
				width: 100%;
				justify-content: space-between;
				padding: 0.3rem 0.6rem;
			}

			.pill__actions {
				flex: none;
				/* Tighten the inline action row so it sits flush with the pill's right padding
				   instead of stretching the pill height. action-nav is a flex container itself —
				   we just nudge gap and offset here. */
				gap: 0.1rem;
				margin-inline-end: -0.3rem;
			}

			.pill__actions action-item {
				width: 1.8rem;
				height: 1.8rem;
				border-radius: 0.4rem;
				color: inherit;
			}

			/* Background-only animation (no box-shadow) so it doesn't get clipped by ancestors
			   with overflow: hidden. */
			.pill--working .pill__dot {
				animation: gl-agent-pill-pulse 1.5s ease 0s infinite;
			}

			@keyframes gl-agent-pill-pulse {
				0% {
					box-shadow: 0 0 0 0 var(--pill-pulse-color, transparent);
				}
				70% {
					box-shadow: 0 0 0 5px transparent;
				}
				100% {
					box-shadow: 0 0 0 0 transparent;
				}
			}

			.pill--needs-input {
				animation: gl-agent-pill-breathing 3.5s ease-in-out 0s infinite;
			}

			@keyframes gl-agent-pill-breathing {
				0%,
				100% {
					background-color: var(--gl-agent-pill-attention-bg);
				}
				50% {
					background-color: var(--gl-agent-pill-attention-bg-peak);
				}
			}

			/* Working */
			.pill--working {
				background-color: var(--gl-agent-pill-working-bg);
				border-color: var(--gl-agent-pill-working-border);
				color: var(--gl-agent-pill-working-color);
			}
			.pill--working .pill__dot {
				background-color: var(--gl-agent-pill-working-color);
				--pill-pulse-color: color-mix(in srgb, var(--gl-agent-pill-working-color) 50%, transparent);
			}

			/* Needs Input */
			.pill--needs-input {
				background-color: var(--gl-agent-pill-attention-bg);
				border-color: var(--gl-agent-pill-attention-border);
				color: var(--gl-agent-pill-attention-color);
			}
			.pill--needs-input .pill__dot {
				background-color: var(--gl-agent-pill-attention-color);
			}

			/* Idle */
			.pill--idle {
				background-color: var(--gl-agent-pill-idle-bg);
				border-color: var(--gl-agent-pill-idle-border);
				color: var(--gl-agent-pill-idle-color);
			}
			.pill--idle .pill__dot {
				background-color: var(--gl-agent-pill-idle-color);
			}

			@media (prefers-reduced-motion: reduce) {
				.pill,
				.pill__dot {
					transition: none;
				}

				.pill--working .pill__dot,
				.pill--needs-input {
					animation: none;
				}
			}

			/* Popover content */
			.hover-card {
				display: flex;
				flex-direction: column;
				gap: 0.6rem;
				white-space: normal;
				min-width: 16rem;
			}

			.hover-header {
				display: flex;
				align-items: center;
				gap: 0.5rem;
			}

			.hover-header__dot {
				width: 8px;
				height: 8px;
				border-radius: 50%;
				flex: none;
			}

			.hover-header__dot--working {
				background-color: var(--gl-agent-pill-working-color);
			}
			.hover-header__dot--needs-input {
				background-color: var(--gl-agent-pill-attention-color);
			}
			.hover-header__dot--idle {
				background-color: var(--gl-agent-pill-idle-color);
			}

			.hover-header__text {
				flex: 1;
				min-width: 0;
				font-weight: 500;
			}

			.hover-header__elapsed {
				flex: none;
				color: var(--vscode-descriptionForeground);
				font-size: 0.9em;
			}

			.hover-section {
				display: flex;
				flex-direction: column;
				gap: 0.2rem;
			}

			.hover-section__label {
				text-transform: uppercase;
				font-size: 0.8em;
				color: var(--vscode-descriptionForeground);
				opacity: 0.7;
			}

			.hover-section__value {
			}

			.hover-code {
				background-color: rgba(0, 0, 0, 0.3);
				border-radius: 2px;
				padding: 0.3rem 0.5rem;
				font-family: var(--vscode-editor-font-family, monospace);
				font-size: 0.9em;
				word-break: break-all;
			}

			:host-context(.vscode-light) .hover-code,
			:host-context(.vscode-high-contrast-light) .hover-code {
				background-color: rgba(0, 0, 0, 0.06);
			}

			.hover-prompt {
				font-size: 0.9em;
				color: var(--vscode-descriptionForeground);
				word-break: break-word;
				display: -webkit-box;
				-webkit-line-clamp: 3;
				-webkit-box-orient: vertical;
				overflow: hidden;
			}

			.hover-actions {
				display: flex;
				flex-direction: column;
				gap: 0.4rem;
				margin-top: 0.2rem;
			}

			.hover-actions__row {
				display: flex;
				flex-direction: row;
				gap: 0.4rem;
			}

			.hover-actions__row > gl-button {
				/* min-width: max-content keeps Allow / Deny from shrinking below their icon+label
				   content when the popover is anchored in a narrow sidebar — the popover body
				   grows horizontally to fit instead. flex: 1 1 0 keeps the row evenly distributed
				   when there's slack. */
				flex: 1 1 0;
				min-width: max-content;
			}

			.hover-actions__row > gl-popover {
				flex: 0 0 auto;
			}

			/* "…" overflow menu — anchored off the third action button. */
			.more-menu {
				display: flex;
				flex-direction: column;
				min-width: 14rem;
				padding: 0.2rem;
			}

			.more-menu__item {
				display: flex;
				align-items: center;
				gap: 0.6rem;
				padding: 0.4rem 0.6rem;
				border-radius: 0.3rem;
				color: var(--vscode-foreground);
				text-decoration: none;
				cursor: pointer;
				font-size: 0.95em;
			}

			.more-menu__item:hover {
				background-color: var(--vscode-list-hoverBackground);
				color: var(--vscode-list-hoverForeground, var(--vscode-foreground));
				text-decoration: none;
			}

			.more-menu__item code-icon {
				color: var(--vscode-descriptionForeground);
				flex: none;
			}
		`,
	];

	@property({ type: Object })
	session!: AgentSessionState;

	/** When set, the pill renders full-width with the category-aware action row inline on the
	 *  right of the label. The hover popover still surfaces the rich detail (header, last prompt,
	 *  tool context) but drops the action row to avoid duplicating the inline buttons.
	 *
	 *  Falls back to compact rendering when `needs-input` cannot resolve inline (`!isInWorkspace`
	 *  or no `pendingPermissionDetail`) — a full-width pill with no actions would be a dead-end. */
	@property({ type: Boolean, reflect: true })
	full = false;

	private onActionMouseDown(e: MouseEvent): void {
		// Stop mousedown from reaching the popover, which would hide it
		// before the click event fires on the <a> tag
		e.stopPropagation();
	}

	override willUpdate(_changed: PropertyValues<this>): void {
		// Reflect the consumer-requested mode via a private `full-active` attribute so the
		// `:host([full-active])` style block only applies when a session is actually mounted
		// (avoids a layout flash before `.session` arrives). Setting the attribute pre-render
		// keeps the styles in sync on the first paint without a one-frame `updated()` lag.
		this.toggleAttribute('full-active', this.full && this.session != null);
	}

	override render(): unknown {
		const category = agentPhaseToCategory[this.session.phase];
		const label = getAgentCategoryLabel(category);
		const detail = this.session.pendingPermissionDetail;
		const canResolve = category === 'needs-input' && this.session.isInWorkspace && detail != null;

		return html`
			<gl-popover placement="bottom" hoist>
				<span slot="anchor" class=${`pill ${category ? `pill--${category}` : ''}`.trim()} tabindex="0">
					<span class="pill__label">
						<span class="pill__dot"></span>
						${label}
					</span>
					${this.full ? this.renderInlineActions(category, canResolve) : nothing}
				</span>
				<div slot="content" class="hover-card" tabindex="-1">
					${this.renderHoverContent(category, this.full)}
				</div>
			</gl-popover>
		`;
	}

	private renderHoverContent(category: AgentSessionCategory, omitActions: boolean): unknown {
		switch (category) {
			case 'working':
				return this.renderWorkingHover(omitActions);
			case 'needs-input':
				return this.renderNeedsInputHover(omitActions);
			case 'idle':
				return this.renderIdleHover(omitActions);
		}
	}

	/** Inline action surface for full mode. `needs-input` + canResolve renders the Allow / Deny / More
	 *  trio. Everything else — working, idle, and the `needs-input` + !canResolve case where the
	 *  permission can't be resolved inline — gets a single Open Session affordance so the pill is
	 *  never a full-width dead end. */
	private renderInlineActions(category: AgentSessionCategory, canResolve: boolean): unknown {
		const openHref = createCommandLink('gitlens.agents.openSession', JSON.stringify(this.session.id));

		if (category === 'needs-input' && canResolve) {
			const detail = this.session.pendingPermissionDetail!;
			const allowHref = createCommandLink('gitlens.agents.resolvePermission', {
				sessionId: this.session.id,
				decision: 'allow' as const,
			});
			const denyHref = createCommandLink('gitlens.agents.resolvePermission', {
				sessionId: this.session.id,
				decision: 'deny' as const,
			});
			const alwaysAllowHref = detail.hasSuggestions
				? createCommandLink('gitlens.agents.resolvePermission', {
						sessionId: this.session.id,
						decision: 'allow' as const,
						alwaysAllow: true,
					})
				: undefined;

			return html`
				<action-nav class="pill__actions" @mousedown=${this.onActionMouseDown}>
					<action-item label="Allow" icon="check" href=${allowHref}></action-item>
					<action-item label="Deny" icon="x" href=${denyHref}></action-item>
					${this.renderMoreActionsMenu(openHref, alwaysAllowHref)}
				</action-nav>
			`;
		}

		return html`
			<action-nav class="pill__actions" @mousedown=${this.onActionMouseDown}>
				<action-item label="Open Session" icon="link-external" href=${openHref}></action-item>
			</action-nav>
		`;
	}

	private renderWorkingHover(omitActions: boolean): unknown {
		const elapsed = formatElapsed(this.session.phaseSinceTimestamp);
		const openHref = createCommandLink('gitlens.agents.openSession', JSON.stringify(this.session.id));

		return html`
			<div class="hover-header">
				<span class="hover-header__dot hover-header__dot--working"></span>
				<span class="hover-header__text">${this.session.name}</span>
				${elapsed != null ? html`<span class="hover-header__elapsed">${elapsed}</span>` : nothing}
			</div>
			${this.session.lastPrompt
				? html`
						<div class="hover-section">
							<span class="hover-section__label">Last Prompt</span>
							<span class="hover-prompt">${this.session.lastPrompt}</span>
						</div>
					`
				: nothing}
			${this.session.status === 'tool_use' && this.session.statusDetail
				? html`
						<div class="hover-section">
							<span class="hover-section__label">Current Tool</span>
							<span class="hover-section__value">${this.session.statusDetail}</span>
						</div>
					`
				: nothing}
			${omitActions
				? nothing
				: html`
						<div class="hover-actions" @mousedown=${this.onActionMouseDown}>
							<gl-button appearance="secondary" full density="compact" href=${openHref}>
								<code-icon icon="link-external" slot="prefix"></code-icon>
								Open Session
							</gl-button>
						</div>
					`}
		`;
	}

	private renderNeedsInputHover(omitActions: boolean): unknown {
		const elapsed = formatElapsed(this.session.phaseSinceTimestamp);
		const detail = this.session.pendingPermissionDetail;
		const openHref = createCommandLink('gitlens.agents.openSession', JSON.stringify(this.session.id));

		const canResolve = this.session.isInWorkspace && detail != null;
		const allowHref = canResolve
			? createCommandLink('gitlens.agents.resolvePermission', {
					sessionId: this.session.id,
					decision: 'allow' as const,
				})
			: undefined;
		const alwaysAllowHref =
			canResolve && detail.hasSuggestions
				? createCommandLink('gitlens.agents.resolvePermission', {
						sessionId: this.session.id,
						decision: 'allow' as const,
						alwaysAllow: true,
					})
				: undefined;
		const denyHref = canResolve
			? createCommandLink('gitlens.agents.resolvePermission', {
					sessionId: this.session.id,
					decision: 'deny' as const,
				})
			: undefined;

		return html`
			<div class="hover-header">
				<span class="hover-header__dot hover-header__dot--needs-input"></span>
				<span class="hover-header__text">${this.session.name}</span>
				${elapsed != null ? html`<span class="hover-header__elapsed">${elapsed}</span>` : nothing}
			</div>
			${this.session.lastPrompt
				? html`
						<div class="hover-section">
							<span class="hover-section__label">Last Prompt</span>
							<span class="hover-prompt">${this.session.lastPrompt}</span>
						</div>
					`
				: nothing}
			${detail != null
				? html`
						<div class="hover-section">
							<span class="hover-section__label">Request</span>
							<div class="hover-code">
								${detail.toolName}${detail.toolDescription
									? html` &mdash; ${detail.toolDescription}`
									: nothing}
							</div>
						</div>
						${detail.toolInputDescription
							? html`
									<div class="hover-section">
										<span class="hover-section__label">Context</span>
										<span class="hover-section__value">${detail.toolInputDescription}</span>
									</div>
								`
							: nothing}
					`
				: nothing}
			${omitActions
				? nothing
				: canResolve
					? html`
							<div class="hover-actions" @mousedown=${this.onActionMouseDown}>
								<div class="hover-actions__row">
									<gl-button full density="compact" href=${allowHref!}>
										<code-icon icon="check" slot="prefix"></code-icon>
										Allow
									</gl-button>
									<gl-button
										appearance="secondary"
										full
										density="compact"
										variant="danger"
										href=${denyHref!}
									>
										<code-icon icon="x" slot="prefix"></code-icon>
										Deny
									</gl-button>
									${this.renderMoreActionsMenu(openHref, alwaysAllowHref)}
								</div>
							</div>
						`
					: html`
							<div class="hover-actions" @mousedown=${this.onActionMouseDown}>
								<gl-button appearance="secondary" full density="compact" href=${openHref}>
									<code-icon icon="link-external" slot="prefix"></code-icon>
									Open Session
								</gl-button>
							</div>
						`}
		`;
	}

	/** Overflow menu anchored off the "…" action in the needs-input row. Always Allow only renders
	 *  when the agent supports it; Open Session is always available. The inner popover uses a click
	 *  trigger — the parent hover popover stays open while focus is on this anchor. */
	private renderMoreActionsMenu(openHref: string, alwaysAllowHref: string | undefined): unknown {
		return html`
			<gl-popover placement="bottom-end" trigger="click" hoist>
				<action-item slot="anchor" label="More actions" icon="ellipsis"></action-item>
				<div slot="content" class="more-menu" role="menu" @mousedown=${this.onActionMouseDown}>
					${alwaysAllowHref != null
						? html`<a class="more-menu__item" role="menuitem" href=${alwaysAllowHref}>
								<code-icon icon="check-all"></code-icon>
								<span>Always Allow</span>
							</a>`
						: nothing}
					<a class="more-menu__item" role="menuitem" href=${openHref}>
						<code-icon icon="link-external"></code-icon>
						<span>Open Session</span>
					</a>
				</div>
			</gl-popover>
		`;
	}

	private renderIdleHover(omitActions: boolean): unknown {
		const openHref = createCommandLink('gitlens.agents.openSession', JSON.stringify(this.session.id));

		return html`
			<div class="hover-header">
				<span class="hover-header__dot hover-header__dot--idle"></span>
				<span class="hover-header__text">${this.session.name}</span>
			</div>
			${this.session.lastPrompt
				? html`
						<div class="hover-section">
							<span class="hover-section__label">Last Prompt</span>
							<span class="hover-prompt">${this.session.lastPrompt}</span>
						</div>
					`
				: nothing}
			${omitActions
				? nothing
				: html`
						<div class="hover-actions" @mousedown=${this.onActionMouseDown}>
							<gl-button appearance="secondary" full density="compact" href=${openHref}>
								<code-icon icon="link-external" slot="prefix"></code-icon>
								Open Session
							</gl-button>
						</div>
					`}
		`;
	}
}
