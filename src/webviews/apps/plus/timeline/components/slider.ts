import type WaSlider from '@awesome.me/webawesome/dist/components/slider/slider.js';
import { css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import type { TimelineDatum } from '../../../../plus/timeline/protocol.js';
import { GlElement } from '../../../shared/components/element.js';
import '@awesome.me/webawesome/dist/components/slider/slider.js';

const tagName = 'gl-chart-slider';

@customElement(tagName)
export class GlChartSlider extends GlElement {
	static readonly tagName = tagName;

	static override styles = css`
		:host {
			display: block;
		}

		.slider-container {
			width: 100%;
			position: relative;
			padding-bottom: 0.4rem;
		}

		wa-slider {
			--track-size: 3px;
			--thumb-width: 16px;
			--thumb-height: 16px;
		}

		wa-slider::part(track) {
			background-color: var(--vscode-scrollbarSlider-background);
		}

		/* Indicator is anchored to max via indicator-offset, so it spans thumb to right edge —
		   the range from the selected commit to the working tree. Hidden by default (matches
		   track), revealed in the accent color only while Shift is held. */
		wa-slider::part(indicator) {
			background-color: transparent;
		}

		:host([shift]) wa-slider::part(indicator) {
			background-color: var(--wa-color-primary-600);
		}

		/* WA's thumb defaults to var(--wa-form-control-activated-color) (background) + 2px
		   border in var(--wa-color-surface-default) — neither token is defined since we
		   don't ship WA's theme CSS, so the thumb is invisible without these overrides. */
		wa-slider::part(thumb) {
			cursor: pointer;
			background-color: var(--vscode-foreground);
			border: 2px solid var(--vscode-editor-background);
		}
	`;

	@state()
	private _value: number = 0;
	private _max: number = 0;
	private _min: number = 0;

	private _data: TimelineDatum[] | undefined;
	get data() {
		return this._data;
	}
	@property({ type: Array })
	set data(value: TimelineDatum[] | undefined) {
		if (this._data === value) return;

		this._data = value;

		this._min = 0;
		this._max = (value?.length ?? 1) - 1;
	}

	private _shift: boolean = false;
	get shift() {
		return this._shift;
	}
	@property({ type: Boolean })
	set shift(value: boolean) {
		this._shift = value;
	}

	get value() {
		return this.data?.[this._value];
	}

	@query('wa-slider')
	private _slider!: WaSlider;

	override render() {
		return html`<div class="slider-container">
			<wa-slider
				id="slider"
				.min=${this._min}
				.max=${this._max}
				.value=${this._value}
				.indicatorOffset=${this._max}
				with-tooltip
				tooltip-placement="top"
				.valueFormatter=${(_: number) => `Hold shift to compare with working tree`}
				@change=${this.handleSliderInput}
				@input=${this.handleSliderInput}
				@click=${this.handleSliderInput}
				@pointerenter=${this.handleShowTooltip}
				@pointermove=${this.handleShowTooltip}
				@pointerleave=${this.handleHideTooltip}
			></wa-slider>
		</div>`;
	}

	// wa-slider's tooltip only opens on focus/drag-start. Add hover triggers by toggling the
	// internal `wa-tooltip` element directly — `showTooltip`/`hideTooltip` exist at runtime but
	// are typed `private`, so go through the rendered shadow tree.
	private handleShowTooltip = () => {
		const tooltip = this._slider?.shadowRoot?.getElementById('tooltip') as { open: boolean } | null;
		if (tooltip != null) {
			tooltip.open = true;
		}
	};

	private handleHideTooltip = () => {
		const tooltip = this._slider?.shadowRoot?.getElementById('tooltip') as { open: boolean } | null;
		if (tooltip != null) {
			tooltip.open = false;
		}
	};

	select(id: string): void;
	select(date: Date): void;
	select(idOrDate: string | Date) {
		let index;
		if (typeof idOrDate === 'string') {
			index = this.data?.findIndex(d => d.sha === idOrDate);
		} else {
			const isoDate = idOrDate.toISOString();
			index = this.data?.findIndex(d => d.date === isoDate);
		}
		if (index == null || index === -1) return;

		this._value = index;
	}

	private handleSliderInput(e: MouseEvent | CustomEvent<void>) {
		if (!this.data?.length) return;

		const index = parseInt((e.target as HTMLInputElement).value);

		const date = new Date(this.data[index].date);
		this.emit('gl-slider-change', { date: date, shift: this.shift, interim: e.type === 'input' });
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'gl-chart-slider': GlChartSlider;
	}

	interface GlobalEventHandlersEventMap {
		'gl-slider-change': CustomEvent<SliderChangeEventDetail>;
	}
}

export interface SliderChangeEventDetail {
	date: Date;
	shift: boolean;
	/** True for `input` events fired while dragging; false for the final `change`/`click`. */
	interim: boolean;
}
