import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { AgentSessionPhase } from '../../../../../agents/provider.js';
import { createCommandLink } from '../../../../../system/commands.js';
import type { AgentSessionState } from '../../../../home/protocol.js';
import { elementBase } from '../../../shared/components/styles/lit/base.css.js';
import '../../../shared/components/code-icon.js';
import '../../../shared/components/button.js';
import '../../../shared/components/overlays/popover.js';
import '../../../shared/components/overlays/tooltip.js';

type Category = 'working' | 'needs-input' | 'idle';

const phaseToCategory: Record<AgentSessionPhase, Category> = {
	working: 'working',
	waiting: 'needs-input',
	idle: 'idle',
};

const categoryRank: Record<Category, number> = {
	'needs-input': 0,
	working: 1,
	idle: 2,
};

/** Idle sessions older than this fold behind a "Show N idle (24h+)" disclosure. Inside-a-workday
 *  idle sessions surface inline; older ones become noise unless the user opts in. */
const staleIdleThresholdMs = 24 * 60 * 60 * 1000;

/** Cap on cluster dots in the section heading. Beyond this, an `+N` overflow chip takes the slot
 *  so the heading width stays bounded. */
const maxClusterDots = 5;

function formatElapsed(timestamp: number | undefined): string | undefined {
	if (timestamp == null) return undefined;
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function categoryLabel(category: Category): string {
	switch (category) {
		case 'needs-input':
			return 'Needs input';
		case 'working':
			return 'Working';
		case 'idle':
			return 'Idle';
	}
}

/** Builds the per-session "what is it doing" line. needs-input → awaiting tool; working tool_use →
 *  current tool; otherwise last-active timestamp or the most-recent prompt. Card detail uses the
 *  long "Awaiting permission:" prefix; the compact hover row uses just "Awaiting:". The hover row
 *  also drops the "Last active …" fallback in favor of `lastPrompt` since elapsed is shown
 *  separately in the phase badge. */
function describeSession(
	session: AgentSessionState,
	category: Category,
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

declare global {
	interface HTMLElementTagNameMap {
		'gl-details-agent-status': GlDetailsAgentStatus;
	}
}

/**
 * Branch-scoped agent status display for the graph details panel. Renders a conditional banner
 * (when any session is non-idle) above a section with a clickable heading-cluster (chevron +
 * label + dot cluster + counts, with a hover popover for per-session detail) and a collapsible
 * cards list. Stale idle sessions (>24h) fold behind a separate disclosure inside the list.
 */
@customElement('gl-details-agent-status')
export class GlDetailsAgentStatus extends LitElement {
	static override styles = [
		elementBase,
		css`
			:host {
				display: block;

				--gl-agent-working: var(--vscode-progressBar-background);
				--gl-agent-attention: var(--vscode-editorWarning-foreground);
				--gl-agent-idle: var(--vscode-descriptionForeground);
			}

			:host([hidden]) {
				display: none;
			}

			/* ---------- Banner ---------- */

			.banner {
				display: flex;
				align-items: center;
				gap: 0.8rem;
				padding: 0.8rem var(--gl-panel-padding-right, 1rem) 0.8rem var(--gl-panel-padding-left, 1.2rem);
				border-bottom: 1px solid var(--gl-metadata-bar-border);
				background: linear-gradient(
					to right,
					color-mix(in srgb, var(--banner-accent, var(--gl-agent-idle)) 14%, transparent),
					color-mix(in srgb, var(--banner-accent, var(--gl-agent-idle)) 4%, transparent)
				);
				border-left: 3px solid var(--banner-accent, var(--gl-agent-idle));
			}

			.banner--needs-input {
				--banner-accent: var(--gl-agent-attention);
			}
			.banner--working {
				--banner-accent: var(--gl-agent-working);
			}
			.banner--idle {
				--banner-accent: var(--gl-agent-idle);
			}

			.banner__icon {
				flex: none;
				color: var(--banner-accent);
				font-size: 1.6em;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: 2.4rem;
				height: 2.4rem;
				border-radius: 50%;
				background-color: color-mix(in srgb, var(--banner-accent) 18%, transparent);
			}

			.banner__icon--pulse code-icon {
				animation: gl-agent-pulse 1.5s ease-in-out infinite;
			}

			@keyframes gl-agent-pulse {
				0%,
				100% {
					opacity: 1;
				}
				50% {
					opacity: 0.45;
				}
			}

			.banner__text {
				flex: 1;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 0.1rem;
			}

			.banner__title {
				font-weight: 600;
				font-size: var(--gl-font-base);
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			.banner__subtitle {
				font-size: 0.9em;
				color: var(--vscode-descriptionForeground);
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			.banner__actions {
				flex: none;
				display: flex;
				align-items: center;
				gap: 0.3rem;
			}

			/* Shared overflow-menu styling — used by both the banner and the cards' ⋯ button. */
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

			/* ---------- Section (heading + collapsible cards list) ---------- */

			.section {
				display: flex;
				flex-direction: column;
				gap: 0.4rem;
				padding: 0.6rem var(--gl-panel-padding-right, 1rem) 0.8rem var(--gl-panel-padding-left, 1.2rem);
				background-color: var(--gl-metadata-bar-bg);
				border-bottom: 1px solid var(--gl-metadata-bar-border);
			}

			/* Heading doubles as the collapse toggle AND the at-a-glance phase summary —
			   chevron + label on the left, dot cluster + counts on the right. The dots and
			   counts remain visible when the list is collapsed so the summary still informs
			   at a glance. */
			.section__heading {
				appearance: none;
				display: flex;
				align-items: center;
				gap: 0.6rem;
				width: 100%;
				padding: 0.2rem 0;
				background: transparent;
				border: none;
				font: inherit;
				font-size: 0.85em;
				color: var(--vscode-descriptionForeground);
				text-transform: uppercase;
				letter-spacing: 0.04em;
				cursor: pointer;
				text-align: left;
				line-height: 1.2;
			}

			.section__heading-chevron {
				font-size: 1em;
				line-height: 1;
				color: var(--vscode-descriptionForeground);
				flex: none;
			}

			.section__heading-label {
				flex: 1;
				min-width: 0;
			}

			.section__heading:hover {
				color: var(--vscode-foreground);
			}

			.section__heading:focus-visible {
				outline: 1px solid var(--vscode-focusBorder);
				outline-offset: 2px;
				border-radius: 0.2rem;
			}

			/* Cluster — dots + textual summary inside the heading row. */
			.section__cluster {
				display: inline-flex;
				align-items: center;
				gap: 0.6rem;
				flex: none;
				font-size: 0.95em;
				text-transform: none;
				letter-spacing: 0;
				color: var(--vscode-foreground);
			}

			.section__cluster-dots {
				display: inline-flex;
				align-items: center;
			}

			.section__cluster-dot {
				width: 1rem;
				height: 1rem;
				border-radius: 50%;
				border: 2px solid var(--gl-metadata-bar-bg, var(--vscode-editor-background));
				margin-left: -0.4rem;
				display: inline-flex;
				align-items: center;
				justify-content: center;
				font-size: 0.7em;
				color: var(--vscode-foreground);
			}

			.section__cluster-dot:first-child {
				margin-left: 0;
			}

			.section__cluster-dot--working {
				background-color: var(--gl-agent-working);
			}

			.section__cluster-dot--needs-input {
				background-color: var(--gl-agent-attention);
				/* Subtle attention nudge so a waiting dot reads as the priority signal */
				box-shadow: 0 0 0 0.2rem color-mix(in srgb, var(--gl-agent-attention) 28%, transparent);
			}

			.section__cluster-dot--idle {
				background-color: var(--gl-agent-idle);
			}

			.section__cluster-dot--overflow {
				background-color: var(--vscode-editor-background);
				border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 40%, transparent);
				color: var(--vscode-descriptionForeground);
			}

			.section__cluster-summary strong {
				color: var(--gl-agent-attention);
				font-weight: 600;
			}

			.section__list {
				display: contents;
			}

			.section__hover {
				display: flex;
				flex-direction: column;
				gap: 0.6rem;
				padding: 0.2rem;
				min-width: 24rem;
			}

			.section__hover-row {
				display: grid;
				grid-template-columns: auto 1fr auto;
				column-gap: 0.6rem;
				row-gap: 0.1rem;
				align-items: center;
			}

			.section__hover-row + .section__hover-row {
				padding-top: 0.6rem;
				border-top: 1px solid var(--gl-metadata-bar-border, var(--vscode-widget-border));
			}

			.section__hover-dot {
				width: 0.7rem;
				height: 0.7rem;
				border-radius: 50%;
				flex: none;
			}
			.section__hover-dot--working {
				background-color: var(--gl-agent-working);
			}
			.section__hover-dot--needs-input {
				background-color: var(--gl-agent-attention);
			}
			.section__hover-dot--idle {
				background-color: var(--gl-agent-idle);
			}

			.section__hover-name {
				min-width: 0;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
				font-weight: 600;
			}

			.section__hover-phase {
				font-size: 0.85em;
				color: var(--vscode-descriptionForeground);
				text-transform: uppercase;
				letter-spacing: 0.04em;
				white-space: nowrap;
			}

			.section__hover-phase--needs-input {
				color: var(--gl-agent-attention);
				font-weight: 600;
			}

			.section__hover-detail {
				grid-column: 2 / -1;
				font-size: 0.9em;
				color: var(--vscode-descriptionForeground);
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			/* Two-row grid: rail + body on top, action row spans the full body column on bottom.
			   The actions always sit at the bottom of the card regardless of panel width. */
			.card {
				display: grid;
				grid-template-columns: auto 1fr;
				grid-template-rows: auto auto;
				column-gap: 0.6rem;
				row-gap: 0.4rem;
				align-items: start;
				padding: 0.6rem 0.8rem;
				border-radius: 0.4rem;
				background-color: var(--vscode-editor-background);
				border: 1px solid var(--gl-metadata-bar-border, var(--vscode-widget-border));
			}

			.card--needs-input {
				border-left: 3px solid var(--gl-agent-attention);
			}
			.card--working {
				border-left: 3px solid var(--gl-agent-working);
			}
			.card--idle {
				border-left: 3px solid var(--gl-agent-idle);
				opacity: 0.85;
			}

			.card__rail {
				grid-row: 1;
				grid-column: 1;
				display: flex;
				align-items: center;
				justify-content: center;
				/* Align the rail's dot to the title row's vertical midpoint without forcing a
				   width on the column — the dot sets the column's intrinsic size. */
				min-height: 1.6em;
			}

			/* Lock dimensions and prevent flex/grid from stretching the dot into an oval. */
			.card__dot {
				width: 0.8rem;
				height: 0.8rem;
				border-radius: 50%;
				flex: none;
				aspect-ratio: 1;
			}

			.card--needs-input .card__dot {
				background-color: var(--gl-agent-attention);
				box-shadow: 0 0 0 0.3rem color-mix(in srgb, var(--gl-agent-attention) 28%, transparent);
			}
			.card--working .card__dot {
				background-color: var(--gl-agent-working);
				animation: gl-agent-pulse 1.5s ease-in-out infinite;
			}
			.card--idle .card__dot {
				background-color: var(--gl-agent-idle);
			}

			.card__body {
				grid-row: 1;
				grid-column: 2;
				min-width: 0;
				display: flex;
				flex-direction: column;
				gap: 0.2rem;
			}

			.card__title-row {
				display: flex;
				align-items: center;
				gap: 0.6rem;
				min-width: 0;
			}

			.card__name {
				flex: 1;
				min-width: 0;
				font-weight: 600;
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			.card__phase {
				flex: none;
				font-size: 0.85em;
				color: var(--vscode-descriptionForeground);
				text-transform: uppercase;
				letter-spacing: 0.04em;
			}

			.card__phase--needs-input {
				color: var(--gl-agent-attention);
				font-weight: 600;
			}

			.card__detail {
				font-size: 0.9em;
				color: var(--vscode-descriptionForeground);
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}

			.card__prompt {
				font-size: 0.9em;
				color: var(--vscode-descriptionForeground);
				font-style: italic;
				display: -webkit-box;
				-webkit-line-clamp: 2;
				-webkit-box-orient: vertical;
				overflow: hidden;
				margin-top: 0.2rem;
			}

			.card__actions {
				grid-row: 2;
				grid-column: 2;
				display: flex;
				flex-direction: row;
				align-items: center;
				justify-content: flex-end;
				gap: 0.3rem;
				flex: none;
			}

			.cards__more-toggle {
				appearance: none;
				display: inline-flex;
				align-items: center;
				gap: 0.3rem;
				align-self: flex-start;
				padding: 0.3rem 0.6rem;
				border-radius: 0.4rem;
				border: 1px dashed color-mix(in srgb, var(--vscode-descriptionForeground) 50%, transparent);
				background: transparent;
				color: var(--vscode-descriptionForeground);
				font: inherit;
				font-size: 0.85em;
				line-height: 1;
				cursor: pointer;
				margin-top: 0.2rem;
			}

			.cards__more-toggle code-icon {
				font-size: 1em;
				line-height: 1;
			}

			.cards__more-toggle:hover {
				border-color: var(--vscode-descriptionForeground);
				color: var(--vscode-foreground);
			}

			.cards__more-toggle:focus-visible {
				outline: 1px solid var(--vscode-focusBorder);
				outline-offset: 2px;
			}
		`,
	];

	@property({ type: Array })
	sessions?: AgentSessionState[];

	@state() private _showStale = false;
	@state() private _collapsed = true;

	/** Splits idle sessions older than {@link staleIdleThresholdMs} out into a `stale`
	 *  bucket. Non-idle sessions (working, needs-input) are always considered fresh regardless
	 *  of timestamp — they're inherently active. */
	private partitionStaleIdle(sessions: AgentSessionState[]): {
		fresh: AgentSessionState[];
		stale: AgentSessionState[];
	} {
		const now = Date.now();
		const fresh: AgentSessionState[] = [];
		const stale: AgentSessionState[] = [];
		for (const s of sessions) {
			const ts = s.lastActivityTimestamp ?? s.phaseSinceTimestamp ?? now;
			if (phaseToCategory[s.phase] === 'idle' && now - ts > staleIdleThresholdMs) {
				stale.push(s);
			} else {
				fresh.push(s);
			}
		}
		return { fresh: fresh, stale: stale };
	}

	/** Sort by category-actionability first (needs-input → working → idle), then by most-recent
	 *  activity within each category. Same ordering everywhere — banner just reads `sessions[0]`
	 *  to find its primary subject. Actionable always wins: a fresh idle session never outranks
	 *  a session that's actually waiting on you. */
	private get sortedSessions(): AgentSessionState[] | undefined {
		if (this.sessions == null || this.sessions.length === 0) return undefined;
		return this.sessions.toSorted((a, b) => {
			const ra = categoryRank[phaseToCategory[a.phase]];
			const rb = categoryRank[phaseToCategory[b.phase]];
			if (ra !== rb) return ra - rb;
			const ta = a.lastActivityTimestamp ?? a.phaseSinceTimestamp ?? 0;
			const tb = b.lastActivityTimestamp ?? b.phaseSinceTimestamp ?? 0;
			if (ta !== tb) return tb - ta;
			return (a.name ?? '').localeCompare(b.name ?? '');
		});
	}

	override render(): unknown {
		const sessions = this.sortedSessions;
		if (sessions == null) return nothing;

		const counts = this.tally(sessions);
		const hasActionable = counts['needs-input'] > 0 || counts.working > 0;

		return html`
			${hasActionable ? this.renderBanner(sessions, counts) : nothing} ${this.renderSection(sessions, counts)}
		`;
	}

	/* ---------- Banner ---------- */

	private renderBanner(sessions: AgentSessionState[], counts: Record<Category, number>): unknown {
		// `sortedSessions` is category-then-timestamp ordered, so the first entry is always the
		// highest-actionability session — exactly the right banner subject.
		const top = sessions[0];
		const topCategory = phaseToCategory[top.phase];

		const summaryParts: string[] = [];
		if (counts['needs-input'] > 0) {
			summaryParts.push(`${counts['needs-input']} needs input`);
		}
		if (counts.working > 0) {
			summaryParts.push(`${counts.working} working`);
		}
		if (counts.idle > 0) {
			summaryParts.push(`${counts.idle} idle`);
		}

		const elapsed = formatElapsed(top.phaseSinceTimestamp);
		const subtitleParts: string[] = [];
		if (top.name) {
			subtitleParts.push(top.name);
		}
		if (elapsed) {
			subtitleParts.push(elapsed);
		}

		const icon = topCategory === 'needs-input' ? 'warning' : topCategory === 'working' ? 'sync' : 'circle-outline';

		return html`
			<div class="banner banner--${topCategory}" role="status">
				<span class="banner__icon ${topCategory === 'working' ? 'banner__icon--pulse' : ''}">
					<code-icon icon=${icon}></code-icon>
				</span>
				<div class="banner__text">
					<span class="banner__title">${summaryParts.join(' · ') || 'Agents on this branch'}</span>
					${subtitleParts.length
						? html`<span class="banner__subtitle">${subtitleParts.join(' — ')}</span>`
						: nothing}
				</div>
				<div class="banner__actions">${this.renderBannerActions(top)}</div>
			</div>
		`;
	}

	private renderBannerActions(top: AgentSessionState): unknown {
		const openHref = createCommandLink('gitlens.agents.openSession', JSON.stringify(top.id));
		const detail = top.pendingPermissionDetail;
		const canResolve = phaseToCategory[top.phase] === 'needs-input' && top.isInWorkspace && detail != null;

		if (!canResolve) {
			return html`
				<gl-tooltip content="Open Session" placement="bottom">
					<gl-button appearance="secondary" density="compact" href=${openHref} aria-label="Open Session">
						<code-icon icon="link-external"></code-icon>
					</gl-button>
				</gl-tooltip>
			`;
		}

		const allowHref = createCommandLink('gitlens.agents.resolvePermission', {
			sessionId: top.id,
			decision: 'allow' as const,
		});
		const denyHref = createCommandLink('gitlens.agents.resolvePermission', {
			sessionId: top.id,
			decision: 'deny' as const,
		});

		return html`
			<gl-tooltip content="Allow" placement="bottom">
				<gl-button density="compact" href=${allowHref} aria-label="Allow">
					<code-icon icon="check"></code-icon>
				</gl-button>
			</gl-tooltip>
			<gl-tooltip content="Deny" placement="bottom">
				<gl-button appearance="secondary" density="compact" href=${denyHref} aria-label="Deny">
					<code-icon icon="x"></code-icon>
				</gl-button>
			</gl-tooltip>
			${this.renderMoreActionsAnchor(top)}
		`;
	}

	/** Shared ⋯ overflow menu for banner + cards. Always Allow only renders when the agent
	 *  exposed `hasSuggestions` (matches the existing pill popover's gate); Open Session is
	 *  always available regardless of phase. */
	private renderMoreActionsAnchor(session: AgentSessionState): unknown {
		const detail = session.pendingPermissionDetail;
		const canResolve = phaseToCategory[session.phase] === 'needs-input' && session.isInWorkspace && detail != null;
		const showAlwaysAllow = canResolve && detail.hasSuggestions === true;
		const openHref = createCommandLink('gitlens.agents.openSession', JSON.stringify(session.id));
		const alwaysAllowHref = showAlwaysAllow
			? createCommandLink('gitlens.agents.resolvePermission', {
					sessionId: session.id,
					decision: 'allow' as const,
					alwaysAllow: true,
				})
			: undefined;

		return html`
			<gl-popover placement="bottom-end" trigger="click" hoist>
				<gl-tooltip slot="anchor" content="More actions" placement="bottom">
					<gl-button appearance="secondary" density="compact" aria-label="More actions">
						<code-icon icon="ellipsis"></code-icon>
					</gl-button>
				</gl-tooltip>
				<div slot="content" class="more-menu" role="menu" @mousedown=${this.stopMouseDown}>
					${showAlwaysAllow && alwaysAllowHref != null
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

	/** Stops popover-internal mousedown from closing the popover before the click on the
	 *  command-link `<a>` fires. Mirrors the pattern used in `gl-agent-status-pill`. */
	private stopMouseDown = (e: MouseEvent): void => {
		e.stopPropagation();
	};

	/* ---------- Section (combined heading + cards list) ---------- */

	private renderSection(sessions: AgentSessionState[], counts: Record<Category, number>): unknown {
		const { fresh, stale } = this.partitionStaleIdle(sessions);
		const visible = this._showStale ? sessions : fresh;

		return html`
			<div class="section">
				<gl-popover placement="bottom" hoist ?disabled=${!this._collapsed}>
					${this.renderSectionHeading(sessions, counts)}
					<div slot="content" class="section__hover">${sessions.map(s => this.renderHoverRow(s))}</div>
				</gl-popover>
				${this._collapsed
					? nothing
					: html`<div id="section__list" class="section__list">
							${visible.map(s => this.renderCard(s))}
							${stale.length > 0 ? this.renderStaleToggle(stale.length) : nothing}
						</div>`}
			</div>
		`;
	}

	private renderSectionHeading(sessions: AgentSessionState[], counts: Record<Category, number>): unknown {
		const collapsed = this._collapsed;
		const visibleDots = sessions.slice(0, maxClusterDots);
		const overflow = sessions.length - visibleDots.length;

		return html`
			<button
				slot="anchor"
				type="button"
				class="section__heading"
				aria-expanded=${collapsed ? 'false' : 'true'}
				aria-controls="section__list"
				@click=${() => (this._collapsed = !collapsed)}
			>
				<code-icon
					class="section__heading-chevron"
					icon=${collapsed ? 'chevron-right' : 'chevron-down'}
				></code-icon>
				<span class="section__heading-label">Agents on this branch</span>
				<span class="section__cluster">
					<span class="section__cluster-dots">
						${visibleDots.map(
							s =>
								html`<span
									class=${`section__cluster-dot section__cluster-dot--${phaseToCategory[s.phase]}`}
								></span>`,
						)}
						${overflow > 0
							? html`<span
									class="section__cluster-dot section__cluster-dot--idle section__cluster-dot--overflow"
								>
									+${overflow}
								</span>`
							: nothing}
					</span>
					<span class="section__cluster-summary">${this.renderCountsSummary(counts)}</span>
				</span>
			</button>
		`;
	}

	private renderStaleToggle(staleCount: number): unknown {
		const showStale = this._showStale;
		return html`
			<button
				type="button"
				class="cards__more-toggle"
				aria-expanded=${showStale ? 'true' : 'false'}
				@click=${() => (this._showStale = !showStale)}
			>
				${showStale
					? html`<code-icon icon="chevron-up"></code-icon> Show fewer`
					: html`<code-icon icon="chevron-down"></code-icon> Show ${staleCount} idle
							${staleCount === 1 ? 'session' : 'sessions'} (24h+)`}
			</button>
		`;
	}

	private renderCountsSummary(counts: Record<Category, number>): unknown {
		const parts: unknown[] = [];
		if (counts['needs-input'] > 0) {
			parts.push(html`<strong>${counts['needs-input']} need input</strong>`);
		}
		if (counts.working > 0) {
			parts.push(html`<span>${counts.working} working</span>`);
		}
		if (counts.idle > 0) {
			parts.push(html`<span>${counts.idle} idle</span>`);
		}

		const out: unknown[] = [];
		parts.forEach((p, i) => {
			if (i > 0) {
				out.push(' · ');
			}
			out.push(p);
		});
		return out;
	}

	private renderHoverRow(session: AgentSessionState): unknown {
		const category = phaseToCategory[session.phase];
		const elapsed = formatElapsed(session.phaseSinceTimestamp);
		const phaseLabel = categoryLabel(category);
		const detail = describeSession(session, category, elapsed, {
			awaitingPrefix: 'short',
			idleFallback: 'lastPrompt',
		});

		return html`
			<div class="section__hover-row">
				<span class=${`section__hover-dot section__hover-dot--${category}`}></span>
				<span class="section__hover-name" title=${session.name}>${session.name}</span>
				<span class=${`section__hover-phase section__hover-phase--${category}`}>
					${phaseLabel}${elapsed != null ? ` · ${elapsed}` : ''}
				</span>
				${detail ? html`<span class="section__hover-detail" title=${detail}>${detail}</span>` : nothing}
			</div>
		`;
	}

	private renderCard(session: AgentSessionState): unknown {
		const category = phaseToCategory[session.phase];
		const elapsed = formatElapsed(session.phaseSinceTimestamp);
		const phaseLabel = categoryLabel(category);
		const detailLine = describeSession(session, category, elapsed, {
			awaitingPrefix: 'long',
			idleFallback: 'lastActive',
		});

		return html`
			<div class=${`card card--${category}`}>
				<div class="card__rail"><span class="card__dot"></span></div>
				<div class="card__body">
					<div class="card__title-row">
						<span class="card__name" title=${session.name}>${session.name}</span>
						<span class=${`card__phase card__phase--${category}`}>
							${phaseLabel}${elapsed != null ? html` · ${elapsed}` : nothing}
						</span>
					</div>
					${detailLine ? html`<span class="card__detail" title=${detailLine}>${detailLine}</span>` : nothing}
					${session.lastPrompt
						? html`<span class="card__prompt" title=${session.lastPrompt}>${session.lastPrompt}</span>`
						: nothing}
				</div>
				<div class="card__actions">${this.renderCardActions(session)}</div>
			</div>
		`;
	}

	private renderCardActions(session: AgentSessionState): unknown {
		const openHref = createCommandLink('gitlens.agents.openSession', JSON.stringify(session.id));
		const detail = session.pendingPermissionDetail;
		const canResolve = phaseToCategory[session.phase] === 'needs-input' && session.isInWorkspace && detail != null;

		if (!canResolve) {
			return html`
				<gl-button appearance="secondary" density="compact" href=${openHref}>
					<code-icon icon="link-external" slot="prefix"></code-icon>
					Open
				</gl-button>
			`;
		}

		const allowHref = createCommandLink('gitlens.agents.resolvePermission', {
			sessionId: session.id,
			decision: 'allow' as const,
		});
		const denyHref = createCommandLink('gitlens.agents.resolvePermission', {
			sessionId: session.id,
			decision: 'deny' as const,
		});

		return html`
			<gl-button density="compact" href=${allowHref}>
				<code-icon icon="check" slot="prefix"></code-icon>
				Allow
			</gl-button>
			<gl-button appearance="secondary" density="compact" href=${denyHref}>
				<code-icon icon="x" slot="prefix"></code-icon>
				Deny
			</gl-button>
			${this.renderMoreActionsAnchor(session)}
		`;
	}

	private tally(sessions: AgentSessionState[]): Record<Category, number> {
		const counts: Record<Category, number> = { working: 0, 'needs-input': 0, idle: 0 };
		for (const s of sessions) {
			counts[phaseToCategory[s.phase]]++;
		}
		return counts;
	}
}
