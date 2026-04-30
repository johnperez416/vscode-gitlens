import { consume } from '@lit/context';
import type { TemplateResult } from 'lit';
import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { when } from 'lit/directives/when.js';
import { formatDate, fromNow } from '@gitlens/utils/date.js';
import { pluralize } from '@gitlens/utils/string.js';
import type { AgentSessionState } from '../../../../../agents/models/agentSessionState.js';
import type { GlWebviewCommandsOrCommandsWithSuffix } from '../../../../../constants.commands.js';
import {
	launchpadCategoryToGroupMap,
	launchpadGroupIconMap,
	launchpadGroupLabelMap,
} from '../../../../../plus/launchpad/models/launchpad.js';
import type { BranchRef, OpenWorktreeCommandArgs } from '../../../../home/protocol.js';
import type {
	OverviewBranch,
	OverviewBranchEnrichment,
	OverviewBranchIssue,
	OverviewBranchLaunchpadItem,
	OverviewBranchMergeTarget,
	OverviewBranchWip,
} from '../../../../shared/overviewBranches.js';
import { renderBranchName } from '../../../shared/components/branch-name.js';
import { srOnlyStyles } from '../../../shared/components/styles/lit/a11y.css.js';
import type { WebviewContext } from '../../../shared/contexts/webview.js';
import { webviewContext } from '../../../shared/contexts/webview.js';
import '../../shared/components/merge-target-status.js';
import '../../../shared/components/branch-icon.js';
import '../../../shared/components/card/card.js';
import '../../../shared/components/pills/agent-status-pill.js';
import '../../../shared/components/pills/tracking.js';
import '../../../shared/components/commit/commit-stats.js';
import '../../../shared/components/avatar/avatar-list.js';
import '../../../shared/components/rich/pr-icon.js';
import '../../../shared/components/rich/issue-icon.js';
import '../../../shared/components/overlays/popover.js';
import '../../../shared/components/overlays/tooltip.js';
import '../../../shared/components/code-icon.js';
import '../../../shared/components/actions/action-item.js';
import '../../../shared/components/actions/action-nav.js';
import '../../../shared/components/chips/autolink-chip.js';
import '../../../shared/components/chips/chip-overflow.js';

function getBranchCardIndicator(
	branch: OverviewBranch,
	wip?: OverviewBranchWip,
	enrichment?: OverviewBranchEnrichment,
): string | undefined {
	if (branch.opened) {
		if (wip?.pausedOpStatus != null) {
			if (wip.hasConflicts) return 'conflict';
			switch (wip.pausedOpStatus.type) {
				case 'cherry-pick':
					return 'cherry-picking';
				case 'merge':
					return 'merging';
				case 'rebase':
					return 'rebasing';
				case 'revert':
					return 'reverting';
			}
		}

		const hasWip =
			wip?.workingTreeState != null &&
			wip.workingTreeState.added + wip.workingTreeState.changed + wip.workingTreeState.deleted > 0;
		if (hasWip) return 'branch-changes';

		if (enrichment?.mergeTarget?.mergedStatus?.merged) return 'branch-merged';
	}

	if (branch.upstream?.missing) return 'branch-missingUpstream';
	const state = branch.upstream?.state;
	if (state != null) {
		if (state.ahead > 0 && state.behind > 0) return 'branch-diverged';
		if (state.ahead > 0) return 'branch-ahead';
		if (state.behind > 0) return 'branch-behind';
		return 'branch-synced';
	}
	return undefined;
}

function getLaunchpadItemGroup(
	pr: OverviewBranchEnrichment['pr'],
	launchpadItem: OverviewBranchLaunchpadItem | undefined,
) {
	if (launchpadItem == null || pr?.state !== 'opened') return undefined;
	if (pr.draft && launchpadItem.category === 'unassigned-reviewers') return undefined;

	const group = launchpadCategoryToGroupMap.get(launchpadItem.category);
	if (group == null || group === 'other' || group === 'draft' || group === 'current-branch') {
		return undefined;
	}

	return group;
}

function getLaunchpadItemGrouping(group: ReturnType<typeof getLaunchpadItemGroup>) {
	switch (group) {
		case 'mergeable':
			return 'mergeable';
		case 'blocked':
			return 'blocked';
		case 'follow-up':
		case 'needs-review':
			return 'attention';
	}

	return undefined;
}

function formatIssueIdentifier(id: string): string {
	return isNaN(parseInt(id, 10)) ? id : `#${id}`;
}

function getWipTooltipParts(workingTreeState: { added: number; changed: number; deleted: number }) {
	const parts = [];
	if (workingTreeState.added) {
		parts.push(`${pluralize('file', workingTreeState.added)} added`);
	}
	if (workingTreeState.changed) {
		parts.push(`${pluralize('file', workingTreeState.changed)} changed`);
	}
	if (workingTreeState.deleted) {
		parts.push(`${pluralize('file', workingTreeState.deleted)} deleted`);
	}
	return parts;
}

declare global {
	interface GlobalEventHandlersEventMap {
		'gl-graph-overview-branch-selected': CustomEvent<{
			branchId: string;
			branchName: string;
			mergeTargetTipSha?: string;
		}>;
	}
}

@customElement('gl-graph-overview-card')
export class GlGraphOverviewCard extends LitElement {
	static override styles = css`
		:host {
			display: block;
			--gl-card-background: color-mix(
				in lab,
				var(--color-graph-background, var(--color-background)) 100%,
				#fff 8%
			);
			--gl-card-hover-background: color-mix(
				in lab,
				var(--color-graph-background, var(--color-background)) 100%,
				#fff 12%
			);
		}

		:host-context(.vscode-light),
		:host-context(.vscode-high-contrast-light) {
			--gl-card-background: color-mix(
				in lab,
				var(--color-graph-background, var(--color-background)) 100%,
				#000 6%
			);
			--gl-card-hover-background: color-mix(
				in lab,
				var(--color-graph-background, var(--color-background)) 100%,
				#000 10%
			);
		}

		* {
			box-sizing: border-box;
		}

		gl-popover {
			/* Anchor wrapper inside the popover defaults to fit-content; grow it so the
			   whole card is the hover-target. */
			--gl-popover-anchor-width: 100%;
			/* Slightly slower show keeps quick scan-passes from triggering the rich hover;
			   short hide gives users a beat to move into the popover without it dismissing. */
			--show-delay: 600ms;
			--hide-delay: 120ms;
		}

		.branch-item {
			position: relative;
		}

		gl-card {
			cursor: pointer;
			display: block;
		}

		gl-card::part(base) {
			padding: 0.4rem 0.6rem;
			margin-block-end: 0;
			border-radius: 0.4rem;
		}

		gl-card.is-scoped {
			outline: 1px solid var(--vscode-focusBorder);
		}

		gl-card.is-launchpad-mergeable::part(base) {
			border-inline-end: 0.3rem solid var(--vscode-gitlens-launchpadIndicatorMergeableColor);
		}
		gl-card.is-launchpad-blocked::part(base) {
			border-inline-end: 0.3rem solid var(--vscode-gitlens-launchpadIndicatorBlockedColor);
		}
		gl-card.is-launchpad-attention::part(base) {
			border-inline-end: 0.3rem solid var(--vscode-gitlens-launchpadIndicatorAttentionColor);
		}

		.branch-item__container {
			display: flex;
			flex-direction: column;
			gap: 0.3rem;
		}

		.branch-item__grouping {
			display: inline-flex;
			align-items: center;
			gap: 0.6rem;
			max-width: 100%;
			margin-block: 0;
		}

		.branch-item__icon {
			color: var(--vscode-descriptionForeground);
			flex: none;
		}

		.branch-item__name {
			flex-grow: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			font-weight: bold;
		}

		.branch-item__name--secondary {
			font-weight: normal;
			color: var(--vscode-descriptionForeground);
			text-decoration: none;
		}

		.branch-item__name--secondary:hover {
			color: var(--vscode-textLink-activeForeground);
		}

		.branch-item__identifier {
			color: var(--vscode-descriptionForeground);
			text-decoration: none;
		}

		.branch-item__changes {
			display: flex;
			align-items: center;
			gap: 0.8rem;
			margin-block: 0;
			font-size: 0.9em;
			color: var(--vscode-descriptionForeground);
		}

		.branch-item__agents {
			display: flex;
			flex-direction: row;
			align-items: center;
			gap: 0.4rem;
			flex-wrap: wrap;
			font-size: 0.9em;
		}

		.branch-item__agents code-icon {
			color: var(--vscode-descriptionForeground);
		}

		.branch-item__date {
			margin-inline-end: auto;
		}

		.branch-item__pills {
			margin-block-start: 0.1rem;
		}

		.branch-item__inline-actions {
			position: absolute;
			z-index: 2;
			right: 0.4rem;
			bottom: 0.3rem;
			padding: 0.2rem 0.4rem;
			background-color: var(--gl-card-hover-background);
			font-size: 0.9em;
		}

		.branch-item:not(:focus-within):not(:hover) .branch-item__inline-actions {
			${srOnlyStyles}
		}

		.tracking__pill,
		.wip__pill {
			display: flex;
			flex-direction: row;
			gap: 1rem;
		}

		.tracking__tooltip,
		.wip__tooltip {
			display: contents;
			vertical-align: middle;
		}

		.tracking__tooltip p,
		.wip__tooltip p {
			margin-block: 0;
		}

		.pill {
			--gl-pill-border: color-mix(in srgb, transparent 80%, var(--color-foreground));
		}

		gl-avatar-list {
			--gl-avatar-size: 2rem;
		}

		.hover {
			display: flex;
			flex-direction: column;
			gap: 0.8rem;
			min-width: 24rem;
			max-width: 36rem;
		}

		.hover__section {
			display: flex;
			flex-direction: column;
			gap: 0.4rem;
		}

		.hover__section--inline {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
			justify-content: space-between;
			gap: 0.6rem;
		}

		.hover__section + .hover__section {
			padding-top: 0.6rem;
			border-top: 1px solid var(--vscode-widget-border, transparent);
		}

		.hover__row {
			display: flex;
			align-items: center;
			gap: 0.6rem;
			max-width: 100%;
		}

		.hover__name {
			flex-grow: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.hover__name--bold {
			font-weight: bold;
		}

		.hover__name a {
			color: inherit;
			text-decoration: none;
		}

		.hover__name a:hover {
			text-decoration: underline;
		}

		.hover__identifier {
			color: var(--vscode-descriptionForeground);
		}

		.hover__icon {
			flex: none;
			color: var(--vscode-descriptionForeground);
		}

		.hover__text {
			margin: 0;
			line-height: 1.4;
		}

		.hover__text--secondary {
			font-size: 0.9em;
			color: var(--vscode-descriptionForeground);
		}

		.hover__muted {
			color: var(--vscode-descriptionForeground);
			margin-inline-start: 0.4rem;
		}

		.hover__launchpad {
			display: inline-flex;
			align-items: center;
			gap: 0.4rem;
			font-size: 0.9em;
		}

		.hover__launchpad--mergeable {
			color: var(--vscode-gitlens-launchpadIndicatorMergeableColor);
		}
		.hover__launchpad--blocked {
			color: var(--vscode-gitlens-launchpadIndicatorBlockedColor);
		}
		.hover__launchpad--attention {
			color: var(--vscode-gitlens-launchpadIndicatorAttentionColor);
		}

		.hover__avatars {
			display: flex;
			align-items: center;
			gap: 0.6rem;
		}

		.hover__actions {
			display: flex;
			flex-wrap: wrap;
			gap: 0.4rem;
		}
	`;

	@consume({ context: webviewContext })
	private _webview!: WebviewContext;

	@property({ type: Object })
	branch!: OverviewBranch;

	@property({ type: Object })
	wip?: OverviewBranchWip;

	@property({ type: Object })
	enrichment?: OverviewBranchEnrichment;

	@property({ type: Array })
	agentSessions?: AgentSessionState[];

	@property({ type: Boolean, reflect: true })
	scoped = false;

	// Track when the rich hover has been shown at least once so <gl-merge-target-status>
	// (which has its own popover/loading affordance) only mounts when the user actually opens
	// the hover. The merge target data itself is already part of `enrichment` (eagerly fetched
	// for the scope popover and indicator), so this defers rendering only — see #5170.
	@state()
	private _hoverShown = false;

	private _mergeTargetPromise?: Promise<OverviewBranchMergeTarget | undefined>;
	private _mergeTargetPromiseFor?: OverviewBranchMergeTarget;

	get branchRef(): BranchRef {
		return {
			repoPath: this.branch.repoPath,
			branchId: this.branch.id,
			branchName: this.branch.name,
			worktree: this.branch.worktree
				? { name: this.branch.worktree.name, isDefault: this.branch.worktree.isDefault }
				: undefined,
		};
	}

	get isWorktree(): boolean {
		return this.branch.worktree != null;
	}

	private get hasWip(): boolean {
		return (
			this.wip?.workingTreeState != null &&
			this.wip.workingTreeState.added + this.wip.workingTreeState.changed + this.wip.workingTreeState.deleted > 0
		);
	}

	private get launchpadGrouping() {
		return getLaunchpadItemGrouping(getLaunchpadItemGroup(this.enrichment?.pr, this.enrichment?.resolvedLaunchpad));
	}

	override render() {
		const branch = this.branch;
		if (branch == null) return nothing;

		const branchIndicator = getBranchCardIndicator(this.branch, this.wip, this.enrichment);
		const grouping = this.launchpadGrouping;
		const cardClasses = classMap({
			'branch-item': true,
			'is-scoped': this.scoped,
			[`is-launchpad-${grouping ?? 'none'}`]: grouping != null,
		});

		// placement="right" so the popover floats over the Graph (which sits to the right of
		// the sidebar in typical layouts) rather than into the editor's left margin. The
		// popover's flip behavior auto-corrects when there isn't room.
		return html`
			<gl-popover hoist trigger="hover focus" placement="right" @gl-popover-show=${this.onPopoverShow}>
				<gl-card
					slot="anchor"
					class=${cardClasses}
					focusable
					.indicator=${branchIndicator}
					@click=${this.onCardClick}
					@keydown=${this.onCardKeydown}
				>
					<div class="branch-item__container">
						<p class="branch-item__grouping">
							<span class="branch-item__icon">${this.renderBranchIcon()}</span>
							<span class="branch-item__name">${this.branch.name}</span>
						</p>
						${this.renderChanges()} ${this.renderAgentRow()} ${this.renderPillsRow()}
					</div>
					${this.renderInlineActions()}
				</gl-card>
				<div slot="content" class="hover">${this.renderHoverContent()}</div>
			</gl-popover>
		`;
	}

	private readonly onPopoverShow = () => {
		if (!this._hoverShown) {
			this._hoverShown = true;
		}
	};

	private getMergeTargetPromise(): Promise<OverviewBranchMergeTarget | undefined> | undefined {
		const data = this.enrichment?.mergeTarget;
		if (data == null) return undefined;
		// Memoize per data reference — <gl-merge-target-status> short-circuits when targetPromise
		// is the same reference, so we hand it the same Promise across re-renders unless the
		// underlying enrichment changed.
		if (this._mergeTargetPromiseFor !== data) {
			this._mergeTargetPromiseFor = data;
			this._mergeTargetPromise = Promise.resolve(data);
		}
		return this._mergeTargetPromise;
	}

	private renderBranchIcon() {
		return html`<gl-branch-icon
			branch="${this.branch.name}"
			status="${this.branch.status}"
			?hasChanges=${this.hasWip}
			upstream=${this.branch.upstream?.name ?? ''}
			?worktree=${this.branch.worktree != null}
			?is-default=${this.branch.worktree?.isDefault ?? false}
		></gl-branch-icon>`;
	}

	private renderChanges() {
		const wip = this.renderWip();
		const tracking = this.renderTracking();
		if (wip === nothing && tracking === nothing) return nothing;

		return html`<p class="branch-item__changes">${wip}${tracking}</p>`;
	}

	private describeTracking(): TemplateResult | undefined {
		const upstream = this.branch.upstream;
		if (upstream == null) return undefined;

		if (upstream.missing) {
			return html`${renderBranchName(this.branch.name)} is missing its upstream ${renderBranchName(upstream.name)}`;
		}

		const status: string[] = [];
		if (upstream.state.behind) {
			status.push(`${pluralize('commit', upstream.state.behind)} behind`);
		}
		if (upstream.state.ahead) {
			status.push(`${pluralize('commit', upstream.state.ahead)} ahead of`);
		}
		if (status.length) {
			return html`${renderBranchName(this.branch.name)} is ${status.join(', ')} ${renderBranchName(upstream.name)}`;
		}
		return html`${renderBranchName(this.branch.name)} is up to date with ${renderBranchName(upstream.name)}`;
	}

	private renderTracking() {
		const upstream = this.branch.upstream;
		if (upstream == null) return nothing;

		return html`<gl-tooltip class="tracking__pill" placement="bottom"
			><gl-tracking-pill
				class="pill"
				colorized
				outlined
				always-show
				ahead=${upstream.state.ahead}
				behind=${upstream.state.behind}
				?missingUpstream=${upstream.missing ?? false}
			></gl-tracking-pill>
			<span class="tracking__tooltip" slot="content">${this.describeTracking()}</span></gl-tooltip
		>`;
	}

	private renderWip() {
		const workingTreeState = this.wip?.workingTreeState;
		if (workingTreeState == null) return nothing;

		const total = workingTreeState.added + workingTreeState.changed + workingTreeState.deleted;
		if (total === 0) return nothing;

		const parts = getWipTooltipParts(workingTreeState);

		return html`<gl-tooltip class="wip__pill" placement="bottom"
			><commit-stats
				added=${workingTreeState.added}
				modified=${workingTreeState.changed}
				removed=${workingTreeState.deleted}
				symbol="icons"
			></commit-stats>
			<span class="wip__tooltip" slot="content">
				<p>${parts.length ? `${parts.join(', ')} in the working tree` : 'No working tree changes'}</p>
			</span></gl-tooltip
		>`;
	}

	private renderPillsRow() {
		const pr = this.enrichment?.pr;
		const issues = this.enrichment?.issues ?? [];
		const autolinks = this.enrichment?.autolinks ?? [];
		if (pr == null && issues.length === 0 && autolinks.length === 0) return nothing;

		return html`<div class="branch-item__pills">
			<gl-chip-overflow max-rows="1">
				${pr != null
					? html`<gl-autolink-chip
							type="pr"
							name=${pr.title}
							url=${pr.url}
							identifier="#${pr.id}"
							status=${pr.state}
							?isDraft=${pr.draft ?? false}
						></gl-autolink-chip>`
					: nothing}
				${[...issues, ...autolinks].map(item => this.renderItemChip(item))}
			</gl-chip-overflow>
		</div>`;
	}

	private renderAgentRow() {
		const sessions = this.agentSessions;
		if (sessions == null || sessions.length === 0) return nothing;

		return html`<div class="branch-item__agents">
			<code-icon icon="hubot"></code-icon>
			${sessions.map(s => html`<gl-agent-status-pill .session=${s}></gl-agent-status-pill>`)}
		</div>`;
	}

	private renderItemChip(item: OverviewBranchIssue) {
		switch (item.type) {
			case 'pullrequest':
				return html`<gl-autolink-chip
					type="pr"
					name=${item.title}
					url=${item.url}
					identifier=${formatIssueIdentifier(item.id)}
					status=${item.state}
					?isDraft=${item.draft ?? false}
				></gl-autolink-chip>`;
			case 'issue':
				return html`<gl-autolink-chip
					type="issue"
					name=${item.title}
					url=${item.url}
					identifier=${formatIssueIdentifier(item.id)}
					status=${item.state === 'closed' ? 'closed' : 'opened'}
				></gl-autolink-chip>`;
			default:
				return html`<gl-autolink-chip
					type="autolink"
					name=${item.title}
					url=${item.url}
					identifier=${formatIssueIdentifier(item.id)}
				></gl-autolink-chip>`;
		}
	}

	private renderInlineActions() {
		const actions = [];

		if (this.isWorktree) {
			actions.push(
				html`<action-item
					label="Open Worktree in New Window"
					alt-label="Open Worktree"
					icon="empty-window"
					alt-icon="browser"
					href=${this.createCommandLink<OpenWorktreeCommandArgs>('gitlens.openWorktree:', {
						location: 'newWindow',
					})}
					alt-href=${this.createCommandLink('gitlens.openWorktree:')}
				></action-item>`,
			);
		} else {
			actions.push(
				html`<action-item
					label="Switch to Branch..."
					icon="gl-switch"
					href=${this.createCommandLink('gitlens.switchToBranch:')}
				></action-item>`,
			);
		}

		actions.push(
			html`<action-item
				label="Fetch"
				icon="repo-fetch"
				href=${this.createCommandLink('gitlens.fetch:')}
			></action-item>`,
		);

		return html`<action-nav class="branch-item__inline-actions">${actions}</action-nav>`;
	}

	private renderHoverContent() {
		const pr = this.enrichment?.pr;
		const issues = this.enrichment?.issues ?? [];
		const autolinks = this.dedupedAutolinks();
		const contributors = this.enrichment?.contributors ?? [];

		const hasItems = pr != null || issues.length > 0 || autolinks.length > 0;
		const hasTracking = this.describeTracking() != null;
		const hasAvatars = contributors.length > 0;

		return html`
			${this.renderHoverHeader()} ${when(hasItems, () => this.renderHoverItems(pr, issues, autolinks))}
			${when(hasTracking || hasAvatars, () => this.renderHoverStatus(contributors))}
			${this.renderHoverActions(pr != null)}
		`;
	}

	private renderHoverMergeTarget(): TemplateResult | typeof nothing {
		// Only mount the chip after the user has actually opened the rich hover. The merge
		// target data is in `enrichment` already (eagerly fetched for the scope popover and
		// card indicator), so this defers DOM mount/loading affordance only — the underlying
		// computation isn't deferred yet (#5170 follow-up).
		if (!this._hoverShown) return nothing;
		const promise = this.getMergeTargetPromise();
		if (promise == null) return nothing;
		return html`<gl-merge-target-status .branch=${this.branch} .targetPromise=${promise}></gl-merge-target-status>`;
	}

	private dedupedAutolinks(): NonNullable<OverviewBranchEnrichment['autolinks']> {
		const autolinks = this.enrichment?.autolinks ?? [];
		if (autolinks.length === 0) return [];

		const seen = new Set<string>();
		const pr = this.enrichment?.pr;
		if (pr != null) {
			seen.add(pr.url);
		}
		for (const issue of this.enrichment?.issues ?? []) {
			seen.add(issue.url);
		}

		return autolinks.filter(a => !seen.has(a.url));
	}

	private renderHoverHeader() {
		const worktreeName = this.branch.worktree?.name;
		const showWorktreeName = worktreeName != null && worktreeName !== this.branch.name;
		const timestamp = this.branch.timestamp;
		const dateFormat = 'MMMM Do, YYYY h:mma';

		return html`<div class="hover__section">
			<div class="hover__row">
				<span class="hover__icon">${this.renderBranchIcon()}</span>
				<span class="hover__name hover__name--bold">${this.branch.name}</span>
				${when(showWorktreeName, () => html`<span class="hover__identifier">${worktreeName}</span>`)}
			</div>
			${when(timestamp != null, () => {
				const date = new Date(timestamp!);
				return html`<p class="hover__text hover__text--secondary">
					<time datetime="${date.toISOString()}">${formatDate(date, dateFormat)}</time>
					<span class="hover__muted">(${fromNow(date)})</span>
				</p>`;
			})}
		</div>`;
	}

	private renderHoverItems(
		pr: OverviewBranchEnrichment['pr'] | undefined,
		issues: NonNullable<OverviewBranchEnrichment['issues']>,
		autolinks: NonNullable<OverviewBranchEnrichment['autolinks']>,
	) {
		const launchpadItem = this.enrichment?.resolvedLaunchpad;
		const group = pr != null ? getLaunchpadItemGroup(pr, launchpadItem) : undefined;
		const grouping = getLaunchpadItemGrouping(group);
		const groupLabel = group != null ? launchpadGroupLabelMap.get(group) : undefined;
		const groupIcon = group != null ? launchpadGroupIconMap.get(group) : undefined;
		const groupIconString = groupIcon?.match(/\$\((.*?)\)/)?.[1].replace('gitlens', 'gl');

		return html`<div class="hover__section">
			${when(
				pr != null,
				() => html`
					<div class="hover__row">
						<span class="hover__icon">
							<pr-icon ?draft=${pr!.draft} state=${pr!.state} pr-id=${pr!.id}></pr-icon>
						</span>
						<span class="hover__name">
							<a href=${pr!.url} @click=${this.onLinkClick}>${pr!.title}</a>
						</span>
						<span class="hover__identifier">#${pr!.id}</span>
					</div>
					${when(
						grouping != null && groupLabel != null && groupIconString != null,
						() =>
							html`<p class="hover__launchpad hover__launchpad--${grouping}">
								<code-icon icon="${groupIconString!}"></code-icon
								><span>${groupLabel!.toUpperCase()}</span>
							</p>`,
					)}
				`,
			)}
			${[...issues, ...autolinks].map(item => this.renderHoverItemRow(item))}
		</div>`;
	}

	private renderHoverItemRow(item: OverviewBranchIssue) {
		const identifier = html`<span class="hover__identifier">${formatIssueIdentifier(item.id)}</span>`;
		const link = html`<span class="hover__name">
			<a href=${item.url} @click=${this.onLinkClick}>${item.title}</a>
		</span>`;

		switch (item.type) {
			case 'pullrequest':
				return html`<div class="hover__row">
					<span class="hover__icon">
						<pr-icon ?draft=${item.draft ?? false} state=${item.state} pr-id=${item.id}></pr-icon>
					</span>
					${link}${identifier}
				</div>`;
			case 'issue':
				return html`<div class="hover__row">
					<span class="hover__icon">
						<issue-icon state=${item.state} issue-id=${item.id}></issue-icon>
					</span>
					${link}${identifier}
				</div>`;
			default:
				return html`<div class="hover__row">
					<span class="hover__icon"><code-icon icon="link"></code-icon></span>
					${link}${identifier}
				</div>`;
		}
	}

	private renderHoverStatus(contributors: NonNullable<OverviewBranchEnrichment['contributors']>) {
		const description = this.describeTracking();

		return html`<div class="hover__section">
			${when(description != null, () => html`<p class="hover__text">${description}</p>`)}
			${when(
				contributors.length > 0,
				() =>
					html`<div class="hover__avatars">
						<gl-avatar-list
							.avatars=${contributors.map(a => ({ name: a.name, src: a.avatarUrl }))}
							max="8"
						></gl-avatar-list>
					</div>`,
			)}
		</div>`;
	}

	private renderHoverActions(hasPr: boolean) {
		const branchActions: TemplateResult[] = [];

		if (this.isWorktree) {
			branchActions.push(
				html`<action-item
					label="Open Worktree in New Window"
					alt-label="Open Worktree"
					icon="empty-window"
					alt-icon="browser"
					href=${this.createCommandLink<OpenWorktreeCommandArgs>('gitlens.openWorktree:', {
						location: 'newWindow',
					})}
					alt-href=${this.createCommandLink('gitlens.openWorktree:')}
				></action-item>`,
			);
		} else {
			branchActions.push(
				html`<action-item
					label="Switch to Branch..."
					icon="gl-switch"
					href=${this.createCommandLink('gitlens.switchToBranch:')}
				></action-item>`,
			);
		}

		branchActions.push(
			html`<action-item
				label="Fetch"
				icon="repo-fetch"
				href=${this.createCommandLink('gitlens.fetch:')}
			></action-item>`,
			html`<action-item
				label=${this.isWorktree ? 'Open in Worktrees View' : 'Open in Branches View'}
				icon="arrow-right"
				href=${this.createCommandLink('gitlens.openInView.branch:')}
			></action-item>`,
		);

		const prActions = hasPr
			? html`<action-nav>
					<action-item
						label="Open Pull Request Changes"
						icon="request-changes"
						href=${this.createCommandLink('gitlens.openPullRequestChanges:')}
					></action-item>
					<action-item
						label="Compare Pull Request"
						icon="git-compare"
						href=${this.createCommandLink('gitlens.openPullRequestComparison:')}
					></action-item>
					<action-item
						label="Open Pull Request Details"
						icon="eye"
						href=${this.createCommandLink('gitlens.openPullRequestDetails:')}
					></action-item>
				</action-nav>`
			: nothing;

		return html`<div class="hover__section hover__section--inline">
			${this.renderHoverMergeTarget()}
			<div class="hover__actions">
				<action-nav>${branchActions}</action-nav>
				${prActions}
			</div>
		</div>`;
	}

	private createCommandLink<T>(
		command: GlWebviewCommandsOrCommandsWithSuffix,
		args?: Omit<T, keyof BranchRef>,
	): string {
		return this._webview.createCommandLink<T | BranchRef>(
			command,
			args ? { ...args, ...this.branchRef } : this.branchRef,
		);
	}

	private onCardClick() {
		this.dispatchEvent(
			new CustomEvent('gl-graph-overview-branch-selected', {
				detail: {
					branchId: this.branch.id,
					branchName: this.branch.name,
					mergeTargetTipSha: this.enrichment?.mergeTarget?.sha,
				},
				bubbles: true,
				composed: true,
			}),
		);
	}

	private onCardKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			this.onCardClick();
		}
	}

	private onLinkClick(e: Event) {
		e.stopPropagation();
	}
}
