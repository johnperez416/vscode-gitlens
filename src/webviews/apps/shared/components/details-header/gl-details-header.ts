import { html, LitElement, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { elementBase } from '../styles/lit/base.css.js';
import { modeHeaderStyles, modeToggleStyles } from '../styles/lit/mode.css.js';
import { detailsHeaderStyles } from './gl-details-header.css.js';
import '../chips/action-chip.js';
import '../progress.js';

type Mode = 'review' | 'compose' | 'compare';

const modeConfig: Record<
	Mode,
	{ icon: string; label: string; closeLabel: string; text: string; collapsible: boolean }
> = {
	compose: {
		icon: 'wand',
		label: 'Compose Changes',
		closeLabel: 'Close Compose Changes',
		text: 'Compose',
		collapsible: true,
	},
	review: {
		icon: 'checklist',
		label: 'Review Changes',
		closeLabel: 'Close Review Changes',
		text: 'Review',
		collapsible: true,
	},
	compare: {
		icon: 'compare-changes',
		label: 'Compare',
		closeLabel: 'Close Compare',
		text: 'Compare',
		collapsible: false,
	},
};

@customElement('gl-details-header')
export class GlDetailsHeader extends LitElement {
	static override styles = [elementBase, detailsHeaderStyles, modeHeaderStyles, modeToggleStyles];

	@property() activeMode?: Mode | null;
	@property({ type: Boolean }) loading = false;
	@property({ type: Array }) modes?: Mode[];

	override render() {
		const isModeActive = this.activeMode != null;

		return html`<div class="details-header mode-header ${isModeActive ? 'mode-header--active' : ''}">
			<div class="details-header__row">
				<div class="details-header__content">
					<slot></slot>
				</div>
				<div class="details-header__actions">
					${this.renderModeToggles()}
					<slot name="actions"></slot>
				</div>
			</div>
			<slot name="secondary"></slot>
			<progress-indicator position="bottom" ?active=${this.loading}></progress-indicator>
		</div>`;
	}

	private renderModeToggles() {
		if (!this.modes?.length) return nothing;

		const isAnyActive = this.activeMode != null;

		return this.modes.map(mode => {
			const isActive = this.activeMode === mode;
			const config = modeConfig[mode];

			// When any mode is active, only the active mode shows its label — the others
			// collapse to icon-only so the active mode stands out and the cluster stays
			// compact. When no mode is active, collapsible modes show their label (subject
			// to the @container collapse rules in gl-details-header.css.ts).
			const showText = isActive || (config.collapsible && !isAnyActive);

			return html`<gl-action-chip
				icon=${config.icon}
				.activeIcon=${isActive ? 'close' : undefined}
				label="${isActive ? config.closeLabel : config.label}"
				overlay="tooltip"
				class=${classMap({
					'mode-toggle': true,
					[`mode-toggle--${mode}`]: true,
					'mode-toggle--active': isActive,
				})}
				@click=${() => this.handleToggleMode(mode)}
				>${showText ? html`<span class="mode-toggle__text">${config.text}</span>` : nothing}</gl-action-chip
			>`;
		});
	}

	private handleToggleMode(mode: Mode) {
		this.dispatchEvent(new CustomEvent('toggle-mode', { detail: { mode: mode }, bubbles: true, composed: true }));
	}
}
