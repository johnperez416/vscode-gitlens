import { css, html, LitElement, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { getAltKeySymbol } from '@env/platform.js';
import type { CurrentUserNameStyle } from '@gitlens/git/utils/commit.utils.js';
import { formatIdentityDisplayName } from '@gitlens/git/utils/commit.utils.js';
import { shortenRevision } from '@gitlens/git/utils/revision.utils.js';
import { getCssVariable } from '@gitlens/utils/color.js';
import { defer } from '@gitlens/utils/promise.js';
import { pluralize } from '@gitlens/utils/string.js';
import type { State, TimelineDatum, TimelineSliceBy } from '../../../../plus/timeline/protocol.js';
import { GlElement } from '../../../shared/components/element.js';
import { formatDate, fromNow } from '../../../shared/date.js';
import type { Disposable } from '../../../shared/events.js';
import { onDidChangeTheme } from '../../../shared/theme.js';
import type { TimelineBinUnit, TimelineViewModel } from './chart/timelineData.js';
import { buildViewModel, chooseBinUnit } from './chart/timelineData.js';
import type { TimelineDrawState, TimelineLayout, TimelineTheme } from './chart/timelineRenderer.js';
import {
	computeLayout,
	drawHeader,
	drawOverlay,
	drawSwimlanes,
	drawVolume,
	findNearestVolumeBar,
	formatY2,
	getAxisTicks,
	getHorizontalScrollbarGeometry,
	hitTestBubble,
	hitTestHorizontalScrollbar,
	hitTestVerticalScrollbar,
	hitTestVolumeBar,
	horizontalScrollbarDeltaToTimestampShift,
	pickY2TickStops,
	sliceVirtualCenterY,
	tsToX,
	verticalScrollbarDeltaToScrollY,
	volumeBarHeight,
	xToTs,
} from './chart/timelineRenderer.js';
import type { SliderChangeEventDetail } from './slider.js';
import { GlChartSlider } from './slider.js';
import '../../../shared/components/avatar/avatar.js';
import '../../../shared/components/overlays/tooltip.js';
import '../../../shared/components/button.js';
import '../../../shared/components/code-icon.js';
import '../../../shared/components/commit-sha.js';
import '../../../shared/components/indicators/watermark-loader.js';

const brushThresholdPx = 3;
const maxZoomExtent = 40;
const wheelZoomFactor = 0.001;

// Default 10-color categorical palette. Picked to read against both light and dark themes; can be
// overridden per-theme via `--color-timeline-slice-0` … `--color-timeline-slice-9` CSS variables.
const defaultSlicePalette: readonly string[] = [
	'#3D7EFF',
	'#FF9F40',
	'#1AB394',
	'#E91E63',
	'#9C27B0',
	'#8B5A2B',
	'#FF6B9D',
	'#7B7B7B',
	'#FFC107',
	'#26A69A',
];

export const tagName = 'gl-timeline-chart';

/**
 * Canvas-backed Visual File History chart. Owns the bubble swimlanes, volume histogram, slider footer,
 * and all interactions; the surrounding [timeline.ts](../timeline.ts) wires it to scope/period/sliceBy
 * state and forwards `gl-commit-select` selections to the host extension.
 */
@customElement(tagName)
export class GlTimelineChart extends GlElement {
	static readonly tagName = tagName;

	static override shadowRootOptions: ShadowRootInit = {
		...LitElement.shadowRootOptions,
		delegatesFocus: true,
	};

	static override styles = css`
		:host {
			display: flex;
			flex-direction: column;
			width: 100%;
			height: 100%;
			position: relative;
			outline: none;
			/* Sizing constants shared between the canvas layout and the DOM rail overlay so the
			   rail's bottom edge lines up with the canvas's swimlane bottom (= top of axis label
			   strip). Keep in sync with the constants in timelineRenderer.ts:
			   volumeHeightPx (64) + axisLabelStripHeightPx (20) = 84px bottom offset; headerPaddingPx
			   (18) = top offset. */
			--rail-left-offset: 8px;
			--rail-column-width: 36px;
			--rail-edge-padding: 4px;
			--rail-bottom-offset: 0px;
			--timeline-glass-start: color-mix(in srgb, var(--vscode-editor-background) 42%, transparent);
			--timeline-glass-end: color-mix(in srgb, var(--vscode-editor-background) 28%, transparent);
			--timeline-glass-filter: blur(10px) saturate(1.45) brightness(1.08);
		}

		.rail {
			/* Overlays the canvas's left gutter. Avatars inside are positioned with absolute
			   canvas-Y coords, and the Y2 axis ("Lines changed") is rendered at the bottom.
			   The glass pane lives in ::before so text and avatars stay crisp above it. */
			position: absolute;
			top: 0;
			left: 0;
			width: calc(var(--rail-left-offset, 8px) + var(--rail-column-width, 36px) + var(--rail-edge-padding, 4px));
			bottom: var(--rail-bottom-offset, 84px);
			pointer-events: none;
			z-index: 2;
			overflow: visible;
		}

		.rail::before {
			content: '';
			position: absolute;
			inset: 0;
			pointer-events: none;
			background: linear-gradient(90deg, var(--timeline-glass-start), var(--timeline-glass-end));
			backdrop-filter: var(--timeline-glass-filter);
			-webkit-backdrop-filter: var(--timeline-glass-filter);
			border-right: 1px solid color-mix(in srgb, var(--vscode-widget-border) 32%, transparent);
			box-shadow: inset -1px 0 0 color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
		}

		.rail__avatar {
			position: absolute;
			z-index: 1;
			left: calc(var(--rail-left-offset, 8px) + var(--rail-column-width, 36px) / 2);
			transform: translate(-50%, -50%);
			cursor: pointer;
			pointer-events: auto;
			border-radius: 50%;
			padding: 2px;
			background: transparent;
			transition:
				transform 120ms ease-out,
				opacity 120ms ease-out,
				background 120ms ease-out;
		}

		.rail__avatar gl-tooltip {
			display: block;
		}

		.rail__avatar gl-avatar {
			display: block;
			border-radius: 50%;
			/* Slotted initials inherit color from gl-avatar's shadow .thumb--text rule (slot's own
			   color wins over light-DOM cascade). The --gl-avatar-text-color custom property
			   crosses the shadow boundary and pins the initials black against the slice color. */
			--gl-avatar-text-color: #000;
		}

		.rail__avatar gl-avatar::part(avatar) {
			background: var(--rail-avatar-color, transparent);
			box-shadow: 0 0 0 1.5px var(--rail-avatar-color, transparent);
			font-weight: 700;
		}

		.rail__avatar[data-dimmed='true'] {
			opacity: 0.35;
		}

		.rail__avatar[data-hidden='true'] {
			opacity: 0.3;
			filter: grayscale(0.85);
		}

		.rail__avatar[data-active='true'] {
			background: var(--vscode-list-hoverBackground);
		}

		.rail__avatar:hover {
			transform: translate(-50%, -50%) scale(1.08);
			z-index: 4;
		}

		.rail-tooltip__name {
			font-weight: 600;
		}

		.rail-tooltip__meta {
			color: var(--color-foreground--75);
			font-size: 0.85em;
			margin-top: 0.15rem;
		}

		.rail-tooltip__hint {
			color: var(--color-foreground--50);
			font-size: 0.8em;
			margin-top: 0.4rem;
			max-width: 16rem;
		}

		.rail__y2-title {
			position: absolute;
			left: calc(var(--rail-left-offset, 8px) + 2px);
			transform: translate(-50%, -50%) rotate(-90deg);
			color: var(--color-foreground--75);
			font-size: 10px;
			white-space: nowrap;
			pointer-events: none;
			z-index: 1;
		}

		.rail__y2-tick {
			position: absolute;
			right: -4px;
			width: 4px;
			height: 1px;
			background: var(--color-foreground--85);
			transform: translateY(-50%);
			z-index: 1;
		}

		.rail__y2-label {
			position: absolute;
			right: 6px;
			color: var(--color-foreground--75);
			font-size: 10px;
			white-space: nowrap;
			transform: translateY(-50%);
			pointer-events: none;
			z-index: 1;
		}

		.axis-overlay {
			position: absolute;
			left: 0;
			width: 100%;
			pointer-events: none;
			z-index: 2;
			overflow: visible;
			color: var(--axis-label-color);
			font-size: 10px;
			line-height: 12px;
		}

		.axis-overlay__glass {
			position: absolute;
			top: 0;
			bottom: 0;
			background: linear-gradient(
				180deg,
				color-mix(in srgb, var(--vscode-editor-background) 68%, transparent),
				color-mix(in srgb, var(--vscode-editor-background) 56%, transparent)
			);
			backdrop-filter: var(--timeline-glass-filter);
			-webkit-backdrop-filter: var(--timeline-glass-filter);
			border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 22%, transparent);
			box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-foreground) 7%, transparent);
		}

		.axis-overlay__baseline {
			position: absolute;
			height: 1px;
			background: color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent);
		}

		.axis-overlay__tick {
			position: absolute;
			width: 1px;
			height: 5px;
			background: var(--axis-domain-color);
			transform: translateX(-50%);
		}

		.axis-overlay__label {
			position: absolute;
			bottom: 4px;
			color: var(--axis-label-color);
			font-size: 10px;
			line-height: 12px;
			white-space: nowrap;
			transform: translateX(-50%);
		}

		.axis-overlay[data-compact='true'] .axis-overlay__label {
			top: 50%;
			bottom: auto;
			transform: translate(-50%, -50%);
		}

		.axis-overlay__scrollbar {
			position: absolute;
			background: color-mix(in srgb, var(--axis-scrollbar-track) 35%, transparent);
		}

		.axis-overlay__scrollbar-thumb {
			position: absolute;
			top: 0;
			height: 100%;
			background: var(--axis-scrollbar-thumb);
		}

		#wrapper {
			flex: 1 1 auto;
			min-height: 0;
			position: relative;
			outline: none;
			overflow: visible;
		}

		footer {
			flex: 0 0 auto;
			display: flex;
			align-items: center;
			margin: 0 1rem 0.4rem 1rem;
			gap: 0.8rem;
		}

		gl-chart-slider {
			flex: 1 0 auto;
			margin-left: 1.4rem;
		}

		gl-commit-sha-copy {
			color: var(--color-foreground--75);
			text-align: right;
			min-width: 7.5rem;
			margin-left: 1.2rem;
		}

		.actions {
			display: flex;
			align-items: center;
			gap: 0.2rem;
		}

		canvas {
			display: block;
			width: 100%;
			height: 100%;
			cursor: default;
		}

		canvas[data-brushing='true'] {
			cursor: ew-resize;
		}

		.tooltip {
			position: absolute;
			pointer-events: none;
			background: var(--vscode-editorHoverWidget-background, var(--color-hover-background));
			color: var(--vscode-editorHoverWidget-foreground, var(--color-hover-foreground));
			border: 1px solid var(--vscode-editorHoverWidget-border, var(--color-hover-border));
			border-radius: 3px;
			padding: 6px 8px;
			font-size: 11px;
			max-width: 320px;
			z-index: 10;
			display: none;
		}

		.tooltip[data-visible='true'] {
			display: block;
		}

		.tooltip .tooltip__author {
			font-weight: 600;
			margin-bottom: 2px;
		}

		.tooltip .tooltip__row {
			display: flex;
			gap: 6px;
			margin-top: 2px;
			color: var(--color-foreground--75);
		}

		.tooltip .tooltip__additions {
			color: var(--vscode-gitlens-timelineAdditionsColor, #49be47);
		}

		.tooltip .tooltip__deletions {
			color: var(--vscode-gitlens-timelineDeletionsColor, #c3202d);
		}

		.tooltip .tooltip__message {
			margin-top: 4px;
			max-width: 300px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		@keyframes notice-fade-in {
			from {
				opacity: 0;
			}
			to {
				opacity: 1;
			}
		}

		.notice {
			position: absolute;
			inset: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			padding: 10% 2rem 30% 2rem;
			pointer-events: none;
			color: var(--color-foreground--75);
			z-index: 3;
		}

		/* Re-enable pointer events on interactive content rendered into the empty slot
		   (e.g. the timeframe dropdown shown when no commits match). The .notice wrapper
		   stays click-through so the canvas behind keeps receiving hover/brush events. */
		::slotted([slot='empty']) {
			pointer-events: auto;
		}

		.notice--blur {
			backdrop-filter: blur(15px);
			-webkit-backdrop-filter: blur(15px);
			animation: notice-fade-in 0.2s ease-in forwards;
			opacity: 0;
		}

		:host([placement='view']) .notice--blur {
			animation-delay: 0.5s;
		}

		.a11y-list {
			position: absolute;
			width: 1px;
			height: 1px;
			margin: -1px;
			padding: 0;
			overflow: hidden;
			clip: rect(0, 0, 0, 0);
			white-space: nowrap;
			border: 0;
		}
	`;

	@query('#canvas')
	private _canvas?: HTMLCanvasElement;

	@query('#tooltip')
	private _tooltipEl?: HTMLDivElement;

	@property()
	placement: 'editor' | 'view' | 'panel' = 'editor';

	@property()
	dateFormat!: string;

	@property({ type: String })
	head?: string;

	@property({ type: Object })
	scope?: State['scope'];

	@property()
	shortDateFormat!: string;

	@property()
	currentUserNameStyle: CurrentUserNameStyle = 'nameAndYou';

	@property()
	sliceBy: TimelineSliceBy = 'author';

	/**
	 * External "loading" signal — set to true by the host while a dataset fetch is in flight at the
	 * RPC level (option change → resource refetch). The chart's own `_loading` only fires when the
	 * `dataPromise` *prop* changes, which doesn't catch the host-side fetch since the resource keeps
	 * the previous dataset reference until the new one arrives. Without piping this through, option
	 * changes never showed the spinner.
	 */
	@property({ type: Boolean })
	loading = false;

	private _dataPromise: State['dataset'];
	@property({ type: Object })
	get dataPromise(): State['dataset'] {
		return this._dataPromise;
	}
	set dataPromise(value: State['dataset']) {
		if (this._dataPromise === value) return;
		this._dataPromise = value;
		void this._loadData();
	}

	@state() private _loading?: ReturnType<typeof defer<void>>;
	@state() private _data: TimelineDatum[] | null = null;
	@state() private _dataReversed?: TimelineDatum[];
	@state() private _selectedSha?: string;
	@state() private _shaHovered?: string;
	private _hoverIndex?: number;
	private _hoverVolumeIndex?: number;
	private _scrubSha?: string;
	@state() private _shiftKeyPressed = false;
	@state() private _zoomed = false;
	@state() private _hoverSliceIndex?: number;
	@state() private _renderTick = 0;
	@state() private _hiddenSlices: Set<number> = new Set();

	@query(GlChartSlider.tagName)
	private _slider?: GlChartSlider;

	private _ctx?: CanvasRenderingContext2D;
	private _layout?: TimelineLayout;
	private _theme?: TimelineTheme;
	private _viewModel?: TimelineViewModel;
	private _binUnit: TimelineBinUnit = 'none';

	private _zoomRange?: { oldest: number; newest: number };
	private _scrollY = 0;
	private _maxScrollY = 0;
	private _brushRange?: { startX: number; endX: number };
	private _isBrushing = false;
	private _isThumbDragging = false;
	private _thumbDragStartY = 0;
	private _thumbDragStartScrollY = 0;

	private _isHThumbDragging = false;
	private _hThumbDragStartX = 0;
	private _hThumbDragStartZoomOldest = 0;
	private _hThumbDragStartZoomNewest = 0;
	private _drawRAF: number | undefined;

	/**
	 * Hover animation state. When hover transitions, we don't drop the previous index immediately
	 * — instead we keep it as `_outgoingHoverIndex` while it fades out, and ramp the new
	 * `_hoverIndex` up. Each `_draw()` advances both intensities toward their targets and requests
	 * another frame until both reach steady state. ~140ms feels snappy without being jarring.
	 */
	private _hoverIntensity = 0;
	private _hoverIntensityTarget = 0;
	private _outgoingHoverIndex?: number;
	private _outgoingHoverIntensity = 0;
	private _lastFrameTime = 0;
	private static readonly _hoverAnimDurationMs = 140;

	private _resizeObserver?: ResizeObserver;
	private _themeDisposable?: Disposable;
	private _abortController?: AbortController;

	override connectedCallback(): void {
		super.connectedCallback?.();
		this._themeDisposable = onDidChangeTheme(() => {
			this._theme = undefined;
			this._requestDraw();
		});
		this._resizeObserver = new ResizeObserver(() => {
			this._layout = undefined;
			this._requestDraw();
		});
		document.addEventListener('keydown', this._onDocumentKeyDown);
		document.addEventListener('keyup', this._onDocumentKeyUp);
		// Observed on the wrapper element after first render — see firstUpdated.
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback?.();
		this._themeDisposable?.dispose();
		this._themeDisposable = undefined;
		this._resizeObserver?.disconnect();
		this._resizeObserver = undefined;
		this._abortController?.abort();
		this._abortController = undefined;
		if (this._drawRAF != null) {
			cancelAnimationFrame(this._drawRAF);
			this._drawRAF = undefined;
		}
		document.removeEventListener('keydown', this._onDocumentKeyDown);
		document.removeEventListener('keyup', this._onDocumentKeyUp);
		this._loading?.cancel();
	}

	private readonly _onDocumentKeyDown = (e: KeyboardEvent): void => {
		this._shiftKeyPressed = e.shiftKey;
	};

	private readonly _onDocumentKeyUp = (e: KeyboardEvent): void => {
		this._shiftKeyPressed = e.shiftKey;
	};

	protected override firstUpdated(): void {
		if (this._canvas == null) return;
		this._ctx = this._canvas.getContext('2d', { alpha: false }) ?? undefined;
		const wrapper = this.shadowRoot?.getElementById('wrapper');
		if (wrapper && this._resizeObserver) {
			this._resizeObserver.observe(wrapper);
		}
		this._requestDraw();
	}

	protected override updated(changed: Map<PropertyKey, unknown>): void {
		if (changed.has('sliceBy') || changed.has('head')) {
			this._viewModel = undefined;
			this._zoomRange = undefined;
			this._scrollY = 0;
		}
		this._requestDraw();
	}

	private async _loadData(): Promise<void> {
		this._abortController?.abort();
		this._abortController = new AbortController();
		const signal = this._abortController.signal;

		if (!this._loading?.pending) {
			this._loading = defer<void>();
			void this._loading.promise.finally(() => (this._loading = undefined));
			this.emit('gl-loading', this._loading.promise);
		}

		if (this._dataPromise == null) {
			this._data = null;
			this._viewModel = undefined;
			this._loading?.fulfill();
			return;
		}

		try {
			const data = await this._dataPromise;
			if (signal.aborted) {
				this._loading?.cancel();
				return;
			}
			this._data = data;
			this._dataReversed = data?.toReversed();
			this._viewModel = undefined;
			this._zoomRange = undefined;
			this._zoomed = false;
			this._scrollY = 0;

			// Auto-select the most recent commit visually so the chart highlights the working tree
			// on first paint, but DON'T emit `gl-commit-select` — the host would interpret an emit
			// as the user picking a commit and open a diff editor unprompted. The user only opts
			// into the diff by interacting with a bubble or the slider thumb.
			this._selectedSha = data[0]?.sha;

			this._requestDraw();
			this._loading?.fulfill();
		} catch {
			this._data = null;
			this._loading?.cancel();
		}
	}

	override render(): unknown {
		return html`<div id="wrapper" tabindex="0" @keydown=${this._onKeyDown}>
				${this._renderNotice()}
				<canvas
					id="canvas"
					data-brushing=${this._isBrushing ? 'true' : 'false'}
					@pointerdown=${this._onPointerDown}
					@pointermove=${this._onPointerMove}
					@pointerup=${this._onPointerUp}
					@pointerleave=${this._onPointerLeave}
					@wheel=${this._onWheel}
				></canvas>
				${this._renderRail()} ${this._renderAxisOverlay()}
				<div id="tooltip" class="tooltip"></div>
				${this._renderA11yList()}
			</div>
			${this._data?.length ? this._renderFooter() : nothing}`;
	}

	/**
	 * Per-slice avatar column — sits in its own gutter to the left of the canvas wrapper, never
	 * overlapping the chart area. Each row is a `<gl-avatar>` (gravatar when an email is available,
	 * initials otherwise) ringed in the slice's color so the rail doubles as the chart legend.
	 * Hover pins the slice (canvas dims other rows + volume columns); click toggles visibility.
	 */
	private _renderRail(): unknown {
		const lo = this._layout;
		const vm = this._viewModel;
		if (lo == null || vm == null) return nothing;
		// `_renderTick` is read so Lit re-runs this when scroll / row height / dataset changes.
		void this._renderTick;

		const palette = this._theme?.slicePalette ?? defaultSlicePalette;
		// Avatar size targets 28px when rows are tall enough, then scales down with the row so
		// adjacent avatars don't overlap. The `- 6` reserves the ring padding (3px above + 3px
		// below). Floor of 18 keeps initials legible at the smallest compact rows.
		const railSize = Math.max(18, Math.min(28, lo.rowHeight - 6));
		const items = vm.slices.map((slice, i) => {
			const cy = lo.swimlaneTop + lo.swimlaneTopBufferPx + i * lo.rowHeight + lo.rowHeight / 2 - this._scrollY;
			// Cull avatars that would render outside the swimlane region (top: into the header
			// padding; bottom: into the X-axis label strip). With the size scaled to the row, this
			// keeps the rail tidy without clipping legible avatars.
			const avatarHalf = railSize / 2 + 4;
			if (cy - avatarHalf < lo.swimlaneTop || cy + avatarHalf > lo.swimlaneBottom) {
				return nothing;
			}
			const dimmed = this._hoverSliceIndex != null && this._hoverSliceIndex !== i;
			const active = this._hoverSliceIndex === i;
			const hidden = this._hiddenSlices?.has(i) === true;
			const color = palette[slice.colorIndex % palette.length];
			const initials = computeInitials(slice.name);
			// "Solo" pinpoints just this slice; "Unsolo" restores the rest. Both alt-click and a
			// plain click on the soloed slice run the same revert path.
			const isSoloed = !hidden && vm.slices.length > 1 && this._hiddenSlices.size === vm.slices.length - 1;
			const clickAction = isSoloed ? 'Unsolo' : hidden ? 'Show' : 'Hide';
			const altAction = isSoloed ? 'Unsolo' : 'Solo';
			const hint = `Click to ${clickAction} · [${getAltKeySymbol()}] Click to ${altAction}`;
			const meta = slice.commitCount != null ? pluralize('commit', slice.commitCount) : '';
			const displayName = formatIdentityDisplayName(
				{ name: slice.name, current: slice.current },
				this.currentUserNameStyle,
			);
			return html`<div
				class="rail__avatar"
				data-dimmed=${dimmed ? 'true' : 'false'}
				data-active=${active ? 'true' : 'false'}
				data-hidden=${hidden ? 'true' : 'false'}
				style=${`top: ${cy}px; --rail-avatar-color: ${color}; --gl-avatar-size: ${railSize}px;`}
				@pointerenter=${() => this._setSliceHover(i)}
				@pointerleave=${() => this._setSliceHover(undefined)}
				@click=${(e: MouseEvent) => this._toggleSlice(i, e)}
			>
				<gl-tooltip placement="right" distance=${10}>
					<gl-avatar .src=${slice.avatarUrl}>${initials}</gl-avatar>
					<div slot="content">
						<div class="rail-tooltip__name">${displayName}</div>
						${meta ? html`<div class="rail-tooltip__meta">${meta}</div>` : nothing}
						<div class="rail-tooltip__hint">${hint}</div>
					</div>
				</gl-tooltip>
			</div>`;
		});

		let y2Axis: unknown = nothing;
		if (lo.chartLeft > 0) {
			const yMax = Math.max(1, vm.yMaxAdd + vm.yMaxDel);
			const baselineY = lo.volumeTop;
			const farY = lo.volumeBottom;
			const usableH = Math.max(0, farY - baselineY - 2);

			// Pick the tick count by available height (each 10px label needs ~14px breathing room).
			// Below ~14px usable: skip ticks entirely so labels don't pile on top of each other.
			let tickCount = 0;
			if (usableH >= 50) {
				tickCount = 3;
			} else if (usableH >= 30) {
				tickCount = 2;
			} else if (usableH >= 14) {
				tickCount = 1;
			}

			// "Lines changed" rotates -90° and runs vertically through the strip — it needs ~50px
			// to read without clipping into the swimlane bubbles above.
			const showTitle = usableH >= 50;

			if (tickCount > 0 || showTitle) {
				const stops = tickCount > 0 ? pickY2TickStops(yMax, tickCount) : [];
				const y2Ticks = stops.map(v => {
					const y = baselineY + volumeBarHeight(v, yMax, usableH);
					return html`
						<div class="rail__y2-tick" style="top: ${y}px;"></div>
						<div class="rail__y2-label" style="top: ${y}px;">${formatY2(v)}</div>
					`;
				});

				y2Axis = html`
					${showTitle
						? html`<div class="rail__y2-title" style="top: ${(baselineY + farY) / 2}px;">
								Lines changed
							</div>`
						: nothing}
					${y2Ticks}
				`;
			}
		}

		return html`<aside class="rail" aria-label="Authors">${items} ${y2Axis}</aside>`;
	}

	private _renderAxisOverlay(): unknown {
		const lo = this._layout;
		const vm = this._viewModel;
		const theme = this._theme;
		if (lo == null || vm == null || theme == null) return nothing;
		void this._renderTick;

		const oldest = this._zoomRange?.oldest ?? vm.oldest;
		const newest = this._zoomRange?.newest ?? vm.newest;
		const axisHeight = lo.axisStripBottom - lo.axisStripTop;
		if (axisHeight <= 0 || newest <= oldest) return nothing;

		const ticks = getAxisTicks(
			lo,
			oldest,
			newest,
			(date, unit, opts) => formatTickLabel(date, unit, this.shortDateFormat, opts),
			label => this._measureAxisLabelWidth(label),
		);
		const scrollbar =
			this._zoomRange != null
				? getHorizontalScrollbarGeometry(lo, vm.oldest, vm.newest, this._zoomRange)
				: undefined;

		// Compact mode kicks in when the volume strip is hidden (very short canvas) — the axis
		// strip shrinks to ~12px to match the scrollbar footprint, and the tick nubs are dropped
		// since they don't fit cleanly in that height.
		const compact = lo.volumeBottom - lo.volumeTop <= 0;

		const overlayStyle = [
			`top: ${lo.axisStripTop}px`,
			`height: ${axisHeight}px`,
			`--axis-label-color: ${theme.axisLabel}`,
			`--axis-domain-color: ${theme.axisDomain}`,
			`--axis-scrollbar-track: ${theme.scrollThumb}`,
			`--axis-scrollbar-thumb: ${theme.scrollThumbHover}`,
		].join('; ');
		const glassStyle = `left: ${lo.chartLeft}px; width: ${lo.chartRight - lo.chartLeft}px;`;
		const baselineStyle = `left: 0; top: ${axisHeight - 1}px; width: 100%;`;

		return html`<div
			class="axis-overlay"
			data-compact=${compact ? 'true' : 'false'}
			aria-hidden="true"
			style=${overlayStyle}
		>
			<div class="axis-overlay__glass" style=${glassStyle}></div>
			<div class="axis-overlay__baseline" style=${baselineStyle}></div>
			${ticks.map(tick =>
				compact
					? html`<div class="axis-overlay__label" style=${`left: ${tick.x}px;`}>${tick.label}</div>`
					: html`<div
								class="axis-overlay__tick"
								style=${`left: ${tick.x}px; top: ${axisHeight - 2}px;`}
							></div>
							<div class="axis-overlay__label" style=${`left: ${tick.x}px;`}>${tick.label}</div>`,
			)}
			${scrollbar != null
				? html`<div
						class="axis-overlay__scrollbar"
						style=${`left: ${scrollbar.trackX}px; top: ${scrollbar.trackY - lo.axisStripTop}px; width: ${scrollbar.trackWidth}px; height: ${scrollbar.trackHeight}px;`}
					>
						<div
							class="axis-overlay__scrollbar-thumb"
							style=${`left: ${scrollbar.thumbX - scrollbar.trackX}px; width: ${scrollbar.thumbWidth}px;`}
						></div>
					</div>`
				: nothing}
		</div>`;
	}

	private _setSliceHover(index: number | undefined): void {
		if (this._hoverSliceIndex === index) return;
		this._hoverSliceIndex = index;
		this._requestDraw();
	}

	/**
	 * Toggle slice visibility. Plain click toggles one slice (or unsolos when the slice is the
	 * only one currently visible). Alt-click solos (or unsolos when already soloed). The "soloed
	 * slice clicked = unsolo" shortcut means a user who solo-clicked their way in can revert with
	 * one more click on the same avatar instead of having to remember the modifier.
	 */
	private _toggleSlice(index: number, e: MouseEvent): void {
		e.stopPropagation();
		const vm = this._viewModel;
		if (vm == null) return;
		const totalSlices = vm.slices.length;
		const hidden = this._hiddenSlices ?? new Set<number>();
		const isAlreadySolo = !hidden.has(index) && totalSlices > 1 && hidden.size === totalSlices - 1;

		if (e.altKey) {
			// Solo (or unsolo): if this slice is the only one visible, restore everyone; otherwise
			// hide every slice except this one.
			if (isAlreadySolo) {
				this._hiddenSlices = new Set();
			} else {
				const next = new Set<number>();
				for (let i = 0; i < totalSlices; i++) {
					if (i !== index) {
						next.add(i);
					}
				}
				this._hiddenSlices = next;
			}
		} else if (isAlreadySolo) {
			// Plain click on the soloed slice = unsolo. Saves the user from having to alt-click
			// to revert when they may not remember the modifier.
			this._hiddenSlices = new Set();
		} else {
			// Plain click: toggle this slice's visibility.
			const next = new Set(hidden);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			this._hiddenSlices = next;
		}
		this._requestDraw();
	}

	private _renderFooter(): unknown {
		const sha = this._shaHovered ?? this._selectedSha;
		return html`<footer>
			<gl-chart-slider
				.data=${this._dataReversed}
				?shift=${this._shiftKeyPressed}
				@gl-slider-change=${this._onSliderChanged}
			></gl-chart-slider>
			<gl-commit-sha-copy .sha=${sha} .size=${16}></gl-commit-sha-copy>
			<div class="actions">
				${this._zoomed
					? html`<gl-button
							appearance="toolbar"
							@click=${(e: MouseEvent) => (e.shiftKey || e.altKey ? this.resetZoom() : this._zoomBy(-1))}
							aria-label="Zoom Out"
						>
							<code-icon icon="zoom-out"></code-icon>
							<span slot="tooltip">Zoom Out<br />${getAltKeySymbol()} Reset Zoom</span>
						</gl-button>`
					: nothing}
				<gl-button
					appearance="toolbar"
					@click=${() => this._zoomBy(0.5)}
					tooltip="Zoom In"
					aria-label="Zoom In"
				>
					<code-icon icon="zoom-in"></code-icon>
				</gl-button>
			</div>
		</footer>`;
	}

	private readonly _onSliderChanged = (e: CustomEvent<SliderChangeEventDetail>): void => {
		const ts = e.detail.date.getTime();
		const commit = this._data?.find(c => new Date(c.date).getTime() === ts);
		if (commit == null) return;

		this._selectedSha = commit.sha;

		// While the user is dragging, treat the slider thumb as a virtual hover — drive the same
		// halo/scale/ring as a real pointer hover and surface the DOM tooltip — so the focused
		// commit is unmistakable in dense swimlanes. On release, fade the hover out and let the
		// quieter selection ring stand alone. Index/position resolution runs at draw-time
		// (`_resolveScrubHover`) so the auto-pan-driven viewModel rebuild below is the one read.
		if (e.detail.interim) {
			this._scrubSha = commit.sha;
			this._shaHovered = commit.sha;
			// Clear any leftover volume-strip spotlight from before the scrub started — once the
			// slider owns hover, pointer-driven volume highlights would compete with the scrub.
			this._hoverVolumeIndex = undefined;
		} else {
			this._scrubSha = undefined;
			this._shaHovered = undefined;
			this._setHover(undefined);
			this._hideTooltip();
		}

		// If the commit is outside the current zoom window, slide the window so it's visible —
		// matches the legacy chart's `revealDate` behavior.
		if (this._zoomRange != null) {
			const span = this._zoomRange.newest - this._zoomRange.oldest;
			if (ts < this._zoomRange.oldest || ts > this._zoomRange.newest) {
				const half = span / 2;
				this._zoomRange = {
					oldest: ts - half,
					newest: ts + half,
				};
				this._viewModel = undefined;
			}
		}

		// Pass `interim` along so `actions.selectDataPoint` can skip the host RPC during scrub —
		// the diff editor only opens when the user releases the slider thumb.
		this.emit('gl-commit-select', { id: commit.sha, shift: e.detail.shift, interim: e.detail.interim });
		this._requestDraw();
	};

	/**
	 * Resolve `_scrubSha` against the current viewModel and drive `_setHover` + `_showTooltip` from
	 * the bubble's actual canvas position. Runs inside `_draw` so the rebuilt viewModel from a
	 * scrub-triggered auto-pan is the one consulted (and so the freshly-set `_hoverIndex` lands in
	 * the same frame's draw state instead of one frame late).
	 */
	private _resolveScrubHover(): void {
		if (this._scrubSha == null || this._viewModel == null || this._layout == null) return;

		const index = this._viewModel.shaToIndex.get(this._scrubSha);
		if (index == null) {
			this._setHover(undefined);
			this._hideTooltip();
			return;
		}

		this._setHover(index);

		const lo = this._layout;
		const vm = this._viewModel;
		const oldest = this._zoomRange?.oldest ?? vm.oldest;
		const newest = this._zoomRange?.newest ?? vm.newest;
		const cx = tsToX(vm.timestamps[index], oldest, newest, lo);
		const cy = sliceVirtualCenterY(vm.sliceIndex[index], lo) - this._scrollY + lo.swimlaneTop;
		this._showTooltip(index, cx, cy);
	}

	/**
	 * Zoom into the chart around a specific commit/bin index — used by the volume-bar click. Picks
	 * a window of ~10% of the current visible span (so each click drills in roughly 10×) and
	 * centers it on the hit's timestamp. Stops at the renderer's `maxZoomExtent` floor so the user
	 * can't zoom into a single point.
	 */
	private _zoomToVolumeBar(idx: number): void {
		const vm = this._viewModel;
		if (vm == null) return;
		const ts = vm.timestamps[idx];
		if (ts == null || Number.isNaN(ts)) return;

		const oldest = this._zoomRange?.oldest ?? vm.oldest;
		const newest = this._zoomRange?.newest ?? vm.newest;
		const currentSpan = newest - oldest;
		const dataSpan = vm.newest - vm.oldest;
		const minSpan = dataSpan / maxZoomExtent;
		const newSpan = Math.max(minSpan, currentSpan * 0.1);

		const halfNew = newSpan / 2;
		let newOldest = ts - halfNew;
		let newNewest = ts + halfNew;
		// Clamp to the dataset bounds without shrinking the span (slide into view instead).
		if (newOldest < vm.oldest) {
			newNewest += vm.oldest - newOldest;
			newOldest = vm.oldest;
		}
		if (newNewest > vm.newest) {
			newOldest -= newNewest - vm.newest;
			newNewest = vm.newest;
		}
		newOldest = Math.max(vm.oldest, newOldest);
		newNewest = Math.min(vm.newest, newNewest);

		this._zoomRange = { oldest: newOldest, newest: newNewest };
		this._zoomed = newNewest - newOldest < dataSpan;
		this._viewModel = undefined;
		this._requestDraw();
	}

	private _zoomBy(factor: number): void {
		if (factor === 0) {
			this.resetZoom();
			return;
		}
		const vm = this._viewModel;
		if (vm == null) return;

		const oldest = this._zoomRange?.oldest ?? vm.oldest;
		const newest = this._zoomRange?.newest ?? vm.newest;
		const span = newest - oldest;
		const dataSpan = vm.newest - vm.oldest;
		const newSpan = Math.max(dataSpan / maxZoomExtent, span * (1 - factor));
		const mid = (oldest + newest) / 2;
		const halfNew = newSpan / 2;
		const newOldest = Math.max(vm.oldest, mid - halfNew);
		const newNewest = Math.min(vm.newest, newOldest + newSpan);

		if (newSpan >= dataSpan) {
			this._zoomRange = undefined;
			this._zoomed = false;
		} else {
			this._zoomRange = { oldest: newOldest, newest: newNewest };
			this._zoomed = true;
		}
		this._viewModel = undefined;
		this._requestDraw();
	}

	private _renderNotice(): unknown {
		if (this.loading || this._loading?.pending || this._data == null) {
			return html`<div class="notice notice--blur">
				<gl-watermark-loader pulse><p>Loading...</p></gl-watermark-loader>
			</div>`;
		}
		if (!this._data.length) {
			return html`<div class="notice">
				<gl-watermark-loader><slot name="empty"></slot></gl-watermark-loader>
			</div>`;
		}
		return nothing;
	}

	private _renderA11yList(): unknown {
		const data = this._data;
		if (data == null || data.length === 0) return nothing;
		return html`<ul class="a11y-list" role="list" aria-label="Commits">
			${data.map(
				c =>
					html`<li role="listitem">
						${`commit ${shortenRevision(c.sha)} by ${formatIdentityDisplayName({ name: c.author, current: c.current }, this.currentUserNameStyle)} on ${formatDate(new Date(c.date), this.dateFormat)}, +${c.additions ?? 0} -${c.deletions ?? 0} lines: ${c.message}`}
					</li>`,
			)}
		</ul>`;
	}

	private _measureAxisLabelWidth(label: string): number {
		const ctx = this._ctx;
		if (ctx == null) return label.length * 6;

		// Restore the prior font afterwards instead of save/restore — the full state push/pop pair
		// is heavier than a single font swap, and this is called once per axis tick label per frame.
		const prevFont = ctx.font;
		ctx.font = '10px var(--font-family, sans-serif)';
		const width = ctx.measureText(label).width;
		ctx.font = prevFont;
		return width;
	}

	private _layoutSliceCount = -1;
	private _lastRenderSig?: string;

	private _ensureLayout(): TimelineLayout | undefined {
		const canvas = this._canvas;
		if (canvas == null) return undefined;
		const wrapper = canvas.parentElement;
		if (wrapper == null) return undefined;

		const rect = wrapper.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return undefined;

		const dpr = window.devicePixelRatio || 1;
		const targetW = Math.round(rect.width * dpr);
		const targetH = Math.round(rect.height * dpr);
		// Assigning canvas.width/height resets the GPU buffer AND wipes canvas state — gate by
		// change so per-frame redraws don't trigger needless resets and reflows.
		if (canvas.width !== targetW || canvas.height !== targetH) {
			canvas.width = targetW;
			canvas.height = targetH;
			canvas.style.width = `${rect.width}px`;
			canvas.style.height = `${rect.height}px`;
			this._ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		const sliceCount = this._viewModel?.slices.length ?? 0;
		this._layout = computeLayout(rect.width, rect.height, dpr, sliceCount, {
			showVolume: this._data != null && this._data.length > 0,
			showY2: this._data != null && this._data.length > 0,
			showHorizontalScrollbar: this._zoomed,
		});
		this._layoutSliceCount = sliceCount;

		const visibleH = this._layout.swimlaneBottom - this._layout.swimlaneTop;
		this._maxScrollY = Math.max(0, this._layout.virtualSwimlaneHeight - visibleH);
		this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY));

		return this._layout;
	}

	private _ensureTheme(): TimelineTheme {
		if (this._theme) return this._theme;
		const style = window.getComputedStyle(this);

		const palette: string[] = [];
		for (let i = 0; i < 10; i++) {
			const v = getCssVariable(`--color-timeline-slice-${i}`, style);
			palette.push(v || defaultSlicePalette[i]);
		}

		this._theme = {
			background: getCssVariable('--vscode-editor-background', style) || '#1e1e1e',
			zebraOdd: getCssVariable('--vscode-list-hoverBackground', style) || 'rgba(255,255,255,0.03)',
			axisDomain: getCssVariable('--color-foreground--50', style) || '#888',
			axisLabel: getCssVariable('--color-foreground--75', style) || '#bbb',
			axisLabelMuted: getCssVariable('--color-foreground--50', style) || '#888',
			gridLine: getCssVariable('--color-foreground--85', style) || '#ccc',
			bubbleStroke: getCssVariable('--color-view-foreground', style) || '#fff',
			selectedRing: getCssVariable('--color-foreground', style) || '#fff',
			hoverRing: getCssVariable('--color-foreground--85', style) || '#ddd',
			additions: getCssVariable('--vscode-gitlens-timelineAdditionsColor', style) || 'rgba(73, 190, 71, 1)',
			deletions: getCssVariable('--vscode-gitlens-timelineDeletionsColor', style) || 'rgba(195, 32, 45, 1)',
			scrollThumb: getCssVariable('--vscode-scrollbarSlider-background', style) || 'rgba(121,121,121,0.4)',
			scrollThumbHover:
				getCssVariable('--vscode-scrollbarSlider-hoverBackground', style) || 'rgba(100,100,100,0.7)',
			tooltipBg: getCssVariable('--vscode-editorHoverWidget-background', style) || '#252526',
			tooltipFg: getCssVariable('--vscode-editorHoverWidget-foreground', style) || '#cccccc',
			tooltipBorder: getCssVariable('--vscode-editorHoverWidget-border', style) || '#454545',
			slicePalette: palette,
		};
		return this._theme;
	}

	private _ensureViewModel(): TimelineViewModel | undefined {
		if (this._data == null || this._data.length === 0) return undefined;
		if (this._viewModel) return this._viewModel;

		// First pass: build at native resolution to learn the dataset's time domain.
		const first = buildViewModel({
			dataset: this._data,
			sliceBy: this.sliceBy,
			defaultBranch: this.head ?? 'HEAD',
		});

		const layout = this._layout;
		if (layout && layout.chartWidth > 0 && first.commits.length > 0) {
			const span = first.newest - first.oldest;
			if (span > 0) {
				const pxPerCommit = layout.chartWidth / first.commits.length;
				const binUnit = chooseBinUnit(pxPerCommit);
				if (binUnit !== 'none') {
					this._viewModel = buildViewModel({
						dataset: this._data,
						sliceBy: this.sliceBy,
						defaultBranch: this.head ?? 'HEAD',
						binUnit: binUnit,
					});
					this._binUnit = binUnit;
					return this._viewModel;
				}
			}
		}

		this._viewModel = first;
		this._binUnit = 'none';
		return this._viewModel;
	}

	private _requestDraw(): void {
		if (this._drawRAF != null) return;
		this._drawRAF = requestAnimationFrame(() => {
			this._drawRAF = undefined;
			this._draw();
		});
	}

	private _draw(): void {
		const ctx = this._ctx;
		if (ctx == null) return;

		const layout = this._ensureLayout();
		if (layout == null) return;

		const theme = this._ensureTheme();
		const viewModel = this._ensureViewModel();

		ctx.fillStyle = theme.background;
		ctx.fillRect(0, 0, layout.width, layout.height);

		if (viewModel == null) return;

		// Recompute layout only when slice count differs from what `_ensureLayout` used —
		// row height depends on it. On steady state the cached layout is reused.
		let lo = layout;
		if (this._layoutSliceCount !== viewModel.slices.length) {
			lo = computeLayout(layout.width, layout.height, layout.dpr, viewModel.slices.length, {
				showVolume: true,
				showY2: true,
				showHorizontalScrollbar: this._zoomed,
			});
			this._layout = lo;
			this._layoutSliceCount = viewModel.slices.length;
		}

		const visibleH = lo.swimlaneBottom - lo.swimlaneTop;
		this._maxScrollY = Math.max(0, lo.virtualSwimlaneHeight - visibleH);
		this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY));

		// DOM rail + axis overlay re-render only when their inputs actually change. Stamping a
		// signature instead of bumping every frame keeps Lit from running render() inside the RAF
		// loop on no-op redraws (hover tweens, mousemove on the same bubble, etc.).
		const sig = `${lo.width}|${lo.height}|${lo.rowHeight}|${lo.virtualSwimlaneHeight}|${this._scrollY}|${viewModel.slices.length}|${this._zoomRange?.oldest ?? 0}|${this._zoomRange?.newest ?? 0}`;
		if (sig !== this._lastRenderSig) {
			this._lastRenderSig = sig;
			this._renderTick++;
		}

		// Map the active scrub sha onto the rebuilt viewModel's bin index BEFORE the hover tween
		// advances, so the slider drag drives the same eased halo + tooltip path as a real pointer
		// hover (and so the index lands in this frame's drawState, not the next one).
		this._resolveScrubHover();

		// Advance the hover-highlight tween. Eased toward the target intensity each frame so the
		// hover effect grows in over ~140ms rather than snapping to full size, and the previously
		// hovered bubble fades out smoothly instead of disappearing.
		const now = performance.now();
		const dt = Math.min(50, this._lastFrameTime > 0 ? now - this._lastFrameTime : 16);
		this._lastFrameTime = now;
		const step = dt / GlTimelineChart._hoverAnimDurationMs;
		const animating = this._stepHoverIntensity(step);

		const drawState: TimelineDrawState = {
			viewModel: viewModel,
			layout: lo,
			theme: theme,
			scrollY: this._scrollY,
			zoomRange: this._zoomRange,
			selectedSha: this._selectedSha,
			hoverIndex: this._hoverIndex,
			hoverIntensity: easeOutCubic(this._hoverIntensity),
			outgoingHoverIndex: this._outgoingHoverIndex,
			outgoingHoverIntensity: easeOutCubic(this._outgoingHoverIntensity),
			hoverSliceIndex: this._hoverSliceIndex,
			hoverVolumeIndex: this._hoverVolumeIndex,
			hiddenSlices: this._hiddenSlices.size > 0 ? this._hiddenSlices : undefined,
			brushRange: this._brushRange,
		};

		// Header strip (sticky top).
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, lo.width, lo.headerHeight);
		ctx.clip();
		drawHeader(ctx, drawState, (date, unit, opts) => formatTickLabel(date, unit, this.shortDateFormat, opts));
		ctx.restore();

		// Swimlane region — clip only vertically (extended to canvas y=0 so top-row bubbles can
		// extend up into the header padding and bottom-row bubbles can shine through the X-axis
		// glass). Horizontal clip is intentionally OPEN: bubbles near the chart edges bleed into
		// the rail and right-gutter columns, where the frosted-glass backdrop blurs them.
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, lo.width, lo.axisStripBottom);
		ctx.clip();
		ctx.translate(0, lo.swimlaneTop - this._scrollY);
		drawSwimlanes(ctx, drawState);
		ctx.restore();

		// Volume strip — bars rise downward from the X-axis baseline at the top of this region.
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, lo.volumeTop, lo.width, lo.volumeBottom - lo.volumeTop);
		ctx.clip();
		drawVolume(ctx, drawState);
		ctx.restore();

		// Overlay layer — focus line, rings, brush, vertical scrollbar. X-axis labels and the
		// horizontal scrollbar render as crisp DOM chrome above their frosted pane.
		drawOverlay(ctx, drawState);

		// Keep ticking while the hover tween is in flight so the scale-up / fade-out animates
		// instead of snapping to its target on the next pointer event.
		if (animating) {
			this._requestDraw();
		} else {
			this._lastFrameTime = 0;
		}
	}

	/**
	 * Advances the hover intensities toward their targets. Returns true while either is still in
	 * flight; once both have settled the host can stop requesting new frames.
	 */
	private _stepHoverIntensity(step: number): boolean {
		let animating = false;

		if (this._hoverIntensity < this._hoverIntensityTarget) {
			this._hoverIntensity = Math.min(this._hoverIntensityTarget, this._hoverIntensity + step);
			if (this._hoverIntensity < this._hoverIntensityTarget) {
				animating = true;
			}
		} else if (this._hoverIntensity > this._hoverIntensityTarget) {
			this._hoverIntensity = Math.max(this._hoverIntensityTarget, this._hoverIntensity - step);
			if (this._hoverIntensity > this._hoverIntensityTarget) {
				animating = true;
			}
		}

		if (this._outgoingHoverIndex != null) {
			this._outgoingHoverIntensity = Math.max(0, this._outgoingHoverIntensity - step);
			if (this._outgoingHoverIntensity > 0) {
				animating = true;
			} else {
				this._outgoingHoverIndex = undefined;
			}
		}

		return animating;
	}

	private _setHover(index: number | undefined): void {
		if (index === this._hoverIndex) return;

		// Hand the previously-hovered bubble off to the outgoing slot so it fades out while the
		// new bubble fades in. Skipped when the prior intensity is already low (the user moved off
		// the chart and back again) so we don't spawn a phantom outgoing fade from nothing.
		if (this._hoverIndex != null && this._hoverIntensity > 0.05) {
			this._outgoingHoverIndex = this._hoverIndex;
			this._outgoingHoverIntensity = this._hoverIntensity;
		}
		this._hoverIndex = index;
		this._hoverIntensity = 0;
		this._hoverIntensityTarget = index != null ? 1 : 0;
		if (this._lastFrameTime === 0) {
			this._lastFrameTime = performance.now();
		}

		const newSha = index != null ? this._viewModel?.commits[index]?.sha : undefined;
		if (this._shaHovered !== newSha) {
			this._shaHovered = newSha;
		}
		this._requestDraw();
	}

	private _onPointerDown = (e: PointerEvent): void => {
		const lo = this._layout;
		if (lo == null) return;

		// Horizontal scrollbar (when zoomed)?
		if (this._zoomRange != null && this._viewModel != null) {
			const hbar = hitTestHorizontalScrollbar(
				e.offsetX,
				e.offsetY,
				lo,
				this._zoomRange,
				this._viewModel.oldest,
				this._viewModel.newest,
			);
			if (hbar?.kind === 'thumb') {
				this._isHThumbDragging = true;
				this._hThumbDragStartX = e.offsetX;
				this._hThumbDragStartZoomOldest = this._zoomRange.oldest;
				this._hThumbDragStartZoomNewest = this._zoomRange.newest;
				(e.target as HTMLElement).setPointerCapture(e.pointerId);
				e.preventDefault();
				return;
			}
			if (hbar?.kind === 'track') {
				const span = this._zoomRange.newest - this._zoomRange.oldest;
				const direction = hbar.side === 'before' ? -1 : 1;
				const shift = direction * span * 0.9;
				const fullOldest = this._viewModel.oldest;
				const fullNewest = this._viewModel.newest;
				const newOldest = Math.max(fullOldest, Math.min(fullNewest - span, this._zoomRange.oldest + shift));
				const newNewest = newOldest + span;
				this._zoomRange = { oldest: newOldest, newest: newNewest };
				this._viewModel = undefined;
				this._requestDraw();
				return;
			}
		}

		// Vertical scrollbar?
		const sbar = hitTestVerticalScrollbar(e.offsetX, e.offsetY, this._scrollY, lo);
		if (sbar?.kind === 'thumb') {
			this._isThumbDragging = true;
			this._thumbDragStartY = e.offsetY;
			this._thumbDragStartScrollY = this._scrollY;
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			e.preventDefault();
			return;
		}
		if (sbar?.kind === 'track') {
			const visibleH = lo.swimlaneBottom - lo.swimlaneTop;
			const direction = sbar.side === 'up' ? -1 : 1;
			this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY + direction * visibleH * 0.9));
			this._requestDraw();
			return;
		}

		// Volume-bar click → zoom into a window around that timestamp. Gives the user a one-click
		// way to drill into a busy day without manually drag-selecting on the swimlane.
		if (
			this._viewModel != null &&
			e.offsetY >= lo.volumeTop &&
			e.offsetY <= lo.volumeBottom &&
			e.offsetX >= lo.chartLeft &&
			e.offsetX <= lo.chartRight
		) {
			const oldest = this._zoomRange?.oldest ?? this._viewModel.oldest;
			const newest = this._zoomRange?.newest ?? this._viewModel.newest;
			const hiddenForHit = this._hiddenSlices.size > 0 ? this._hiddenSlices : undefined;
			const hit = hitTestVolumeBar(e.offsetX, e.offsetY, this._viewModel, oldest, newest, lo, hiddenForHit);
			if (hit != null) {
				this._zoomToVolumeBar(hit);
				e.preventDefault();
				return;
			}
		}

		// Brush start (anywhere within the swimlane region).
		if (e.offsetY >= lo.swimlaneTop && e.offsetY <= lo.swimlaneBottom) {
			this._isBrushing = true;
			this._brushRange = { startX: e.offsetX, endX: e.offsetX };
			(e.target as HTMLElement).setPointerCapture(e.pointerId);
			this._requestDraw();
		}
	};

	private _onPointerMove = (e: PointerEvent): void => {
		const lo = this._layout;
		const viewModel = this._viewModel;
		if (lo == null || viewModel == null) return;

		// Slider scrub owns hover for the duration of the drag — ignore pointer movement over the
		// canvas so the user doesn't get a competing bubble/volume spotlight when their cursor
		// drifts off the slider thumb. Released by `_onSliderChanged` on `interim: false`.
		if (this._scrubSha != null) return;

		if (this._isHThumbDragging && this._viewModel != null) {
			const deltaX = e.offsetX - this._hThumbDragStartX;
			const shift = horizontalScrollbarDeltaToTimestampShift(
				deltaX,
				lo,
				this._viewModel.oldest,
				this._viewModel.newest,
			);
			const span = this._hThumbDragStartZoomNewest - this._hThumbDragStartZoomOldest;
			const fullOldest = this._viewModel.oldest;
			const fullNewest = this._viewModel.newest;
			const newOldest = Math.max(
				fullOldest,
				Math.min(fullNewest - span, this._hThumbDragStartZoomOldest + shift),
			);
			this._zoomRange = { oldest: newOldest, newest: newOldest + span };
			this._viewModel = undefined;
			this._requestDraw();
			return;
		}

		if (this._isThumbDragging) {
			const delta = e.offsetY - this._thumbDragStartY;
			const scrollDelta = verticalScrollbarDeltaToScrollY(delta, lo);
			this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._thumbDragStartScrollY + scrollDelta));
			this._requestDraw();
			return;
		}

		if (this._isBrushing && this._brushRange) {
			this._brushRange = { startX: this._brushRange.startX, endX: e.offsetX };
			this._requestDraw();
			return;
		}

		// Hover hit-test.
		const oldest = this._zoomRange?.oldest ?? viewModel.oldest;
		const newest = this._zoomRange?.newest ?? viewModel.newest;
		const bubbleHit = hitTestBubble(e.offsetX, e.offsetY, this._scrollY, viewModel, oldest, newest, lo);

		// Volume-strip scrub — when the pointer is anywhere inside the volume strip (and not on a
		// bubble), snap to the nearest visible bar regardless of distance. Continuous tracking keeps
		// the linked spotlight locked onto a focused commit while scrubbing, instead of flashing off
		// as the cursor passes through gaps between bars.
		const hiddenForHit = this._hiddenSlices.size > 0 ? this._hiddenSlices : undefined;
		const volumeHit =
			bubbleHit == null
				? findNearestVolumeBar(e.offsetX, e.offsetY, viewModel, oldest, newest, lo, hiddenForHit)
				: undefined;
		if (volumeHit !== this._hoverVolumeIndex) {
			this._hoverVolumeIndex = volumeHit;
			this._requestDraw();
		}

		// Focused commit = bubble hit when over a bubble, otherwise the largest commit at the
		// hovered volume bar. The same `_hoverIndex` drives the bubble glow + the tooltip, so the
		// linked spotlight reads as "you're focused on THIS commit" rather than just dimming.
		const focused = bubbleHit ?? volumeHit;
		this._setHover(focused);

		// Scrollbar cursor is `default` (not `zoom-in` or `pointer`) so the user reads it as a
		// system scrollbar, not a clickable bubble. Bubble hits override (so a bubble overlapping
		// the scrollbar zone still gets the pointer cursor).
		const onScrollbar =
			(this._zoomed &&
				hitTestHorizontalScrollbar(
					e.offsetX,
					e.offsetY,
					lo,
					this._zoomRange ?? viewModel,
					viewModel.oldest,
					viewModel.newest,
				) != null) ||
			hitTestVerticalScrollbar(e.offsetX, e.offsetY, this._scrollY, lo) != null;

		const canvas = this._canvas;
		if (canvas) {
			let cursor: 'pointer' | 'zoom-in' | 'default';
			if (bubbleHit != null) {
				cursor = 'pointer';
			} else if (onScrollbar) {
				cursor = 'default';
			} else if (volumeHit != null) {
				cursor = 'zoom-in';
			} else {
				cursor = 'default';
			}
			if (canvas.style.cursor !== cursor) {
				canvas.style.cursor = cursor;
			}
		}
		this._showTooltip(focused, e.offsetX, e.offsetY);
	};

	private _onPointerUp = (e: PointerEvent): void => {
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);

		if (this._isHThumbDragging) {
			this._isHThumbDragging = false;
			return;
		}

		if (this._isThumbDragging) {
			this._isThumbDragging = false;
			return;
		}

		if (this._isBrushing && this._brushRange) {
			const { startX, endX } = this._brushRange;
			const width = Math.abs(endX - startX);
			this._isBrushing = false;
			this._brushRange = undefined;

			if (width >= brushThresholdPx) {
				// Commit zoom to the brushed range.
				const lo = this._layout;
				const viewModel = this._viewModel;
				if (lo && viewModel) {
					const oldest = this._zoomRange?.oldest ?? viewModel.oldest;
					const newest = this._zoomRange?.newest ?? viewModel.newest;
					const ts1 = xToTs(Math.min(startX, endX), oldest, newest, lo);
					const ts2 = xToTs(Math.max(startX, endX), oldest, newest, lo);
					if (!Number.isNaN(ts1) && !Number.isNaN(ts2) && ts2 > ts1) {
						this._zoomRange = { oldest: ts1, newest: ts2 };
						this._zoomed = true;
						this._viewModel = undefined; // force rebuild — bin choice may change
					}
				}
				this._requestDraw();
				return;
			}

			// Treat as a click — hit-test for a bubble.
			const lo = this._layout;
			const viewModel = this._viewModel;
			if (lo && viewModel) {
				const oldest = this._zoomRange?.oldest ?? viewModel.oldest;
				const newest = this._zoomRange?.newest ?? viewModel.newest;
				const hit = hitTestBubble(endX, e.offsetY, this._scrollY, viewModel, oldest, newest, lo);
				if (hit != null) {
					const sha = viewModel.commits[hit].sha;
					this._selectedSha = sha;
					this._slider?.select(sha);
					this.emit('gl-commit-select', { id: sha, shift: e.shiftKey });
				}
			}
			this._requestDraw();
		}
	};

	private _onPointerLeave = (): void => {
		// Don't tear down hover state mid-scrub — the slider owns it until release.
		if (this._scrubSha != null) return;

		this._setHover(undefined);
		this._shaHovered = undefined;
		if (this._hoverVolumeIndex != null) {
			this._hoverVolumeIndex = undefined;
			this._requestDraw();
		}
		const canvas = this._canvas;
		if (canvas) {
			canvas.style.cursor = 'default';
		}
		this._hideTooltip();
	};

	private _onWheel = (e: WheelEvent): void => {
		const lo = this._layout;
		const viewModel = this._viewModel;
		if (lo == null || viewModel == null) return;

		// Ctrl/Cmd + wheel: zoom around the cursor's X.
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			const oldest = this._zoomRange?.oldest ?? viewModel.oldest;
			const newest = this._zoomRange?.newest ?? viewModel.newest;
			const span = newest - oldest;
			if (span <= 0) return;

			const cursorTs = xToTs(e.offsetX, oldest, newest, lo);
			if (Number.isNaN(cursorTs)) return;

			const factor = Math.exp(e.deltaY * wheelZoomFactor);
			const newSpan = Math.max((newest - oldest) * factor, (viewModel.newest - viewModel.oldest) / maxZoomExtent);
			if (newSpan >= viewModel.newest - viewModel.oldest) {
				this._zoomRange = undefined;
				this._zoomed = false;
			} else {
				const t = (cursorTs - oldest) / span;
				const newOldest = Math.max(viewModel.oldest, cursorTs - newSpan * t);
				const newNewest = Math.min(viewModel.newest, newOldest + newSpan);
				this._zoomRange = { oldest: newOldest, newest: newNewest };
				this._zoomed = true;
			}
			this._viewModel = undefined;
			this._requestDraw();
			return;
		}

		// Default wheel: vertical scroll the swimlane region (V8).
		if (this._maxScrollY > 0) {
			e.preventDefault();
			this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY + e.deltaY));
			this._requestDraw();
		}
	};

	private _onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			if (this._zoomRange != null) {
				this._zoomRange = undefined;
				this._zoomed = false;
				this._viewModel = undefined;
				this._requestDraw();
			}
			return;
		}

		const viewModel = this._viewModel;
		if (viewModel == null || viewModel.commits.length === 0) return;

		const lastIdx = viewModel.commits.length - 1;
		let nextIdx: number | undefined;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			const direction = e.key === 'ArrowLeft' ? -1 : 1;
			const currentIdx = this._selectedSha != null ? (viewModel.shaToIndex.get(this._selectedSha) ?? 0) : 0;
			nextIdx = Math.max(0, Math.min(lastIdx, currentIdx + direction));
		} else if (e.key === 'Home') {
			nextIdx = 0;
		} else if (e.key === 'End') {
			nextIdx = lastIdx;
		} else {
			return;
		}

		const sha = viewModel.commits[nextIdx].sha;
		this._selectedSha = sha;
		this._scrollSelectedIntoView(nextIdx);
		this.emit('gl-commit-select', { id: sha, shift: e.shiftKey });
		e.preventDefault();
		this._requestDraw();
	};

	/**
	 * Scrolls the swimlane region vertically so the selected commit's row is in view, and pans the
	 * zoom window horizontally if the commit falls outside the current zoom range. Only fires for
	 * keyboard-driven selection — pointer-driven selection is already in view by definition.
	 */
	private _scrollSelectedIntoView(idx: number): void {
		const viewModel = this._viewModel;
		const lo = this._layout;
		if (viewModel == null || lo == null) return;

		// Vertical: bring the row into the visible swimlane region. All Y math is in virtual
		// coords, which include the swimlane's top buffer.
		const sliceIdx = viewModel.sliceIndex[idx];
		const rowTop = lo.swimlaneTopBufferPx + sliceIdx * lo.rowHeight;
		const rowCenterY = rowTop + lo.rowHeight / 2;
		const visibleH = lo.swimlaneBottom - lo.swimlaneTop;
		if (rowCenterY < this._scrollY) {
			this._scrollY = Math.max(0, rowTop);
		} else if (rowCenterY > this._scrollY + visibleH) {
			this._scrollY = Math.min(this._maxScrollY, rowTop + lo.rowHeight - visibleH);
		}

		// Horizontal: pan the zoom window so the commit's timestamp is visible. Preserves the
		// current zoom factor so the user's level of detail isn't lost on a keyboard step.
		const ts = viewModel.timestamps[idx];
		if (this._zoomRange != null) {
			const span = this._zoomRange.newest - this._zoomRange.oldest;
			if (ts < this._zoomRange.oldest) {
				const newOldest = Math.max(viewModel.oldest, ts - span * 0.1);
				this._zoomRange = { oldest: newOldest, newest: newOldest + span };
				this._viewModel = undefined;
			} else if (ts > this._zoomRange.newest) {
				const newNewest = Math.min(viewModel.newest, ts + span * 0.1);
				this._zoomRange = { oldest: newNewest - span, newest: newNewest };
				this._viewModel = undefined;
			}
		}
	}

	private _tooltipSha?: string;
	private _tooltipW = 0;
	private _tooltipH = 0;

	private _showTooltip(index: number | undefined, x: number, y: number): void {
		const tooltip = this._tooltipEl;
		if (tooltip == null) return;

		if (index == null || this._viewModel == null) {
			this._hideTooltip();
			return;
		}

		const commit = this._viewModel.commits[index];
		if (commit == null) {
			this._hideTooltip();
			return;
		}

		// Rebuild content only when the focused commit changes — moving the cursor across the same
		// bubble keeps the rendered DOM and only repositions, avoiding the per-mousemove
		// `replaceChildren` + forced `getBoundingClientRect` reflow. Keyed by sha so a viewModel
		// rebuild that shifts indices doesn't serve a stale tooltip.
		if (commit.sha !== this._tooltipSha) {
			// Safe DOM construction — never interpolate user-controlled strings into innerHTML.
			const author = document.createElement('div');
			author.className = 'tooltip__author';
			author.textContent = formatIdentityDisplayName(
				{ name: commit.author, current: commit.current },
				this.currentUserNameStyle,
			);

			const detailsRow = document.createElement('div');
			detailsRow.className = 'tooltip__row';
			const shaSpan = document.createElement('span');
			shaSpan.textContent = shortenRevision(commit.sha);
			detailsRow.appendChild(shaSpan);

			if (commit.additions != null) {
				const addSpan = document.createElement('span');
				addSpan.className = 'tooltip__additions';
				addSpan.textContent = `+${pluralize('line', commit.additions)}`;
				detailsRow.appendChild(addSpan);
			}
			if (commit.deletions != null) {
				const delSpan = document.createElement('span');
				delSpan.className = 'tooltip__deletions';
				delSpan.textContent = `-${pluralize('line', commit.deletions)}`;
				detailsRow.appendChild(delSpan);
			}

			const dateRow = document.createElement('div');
			dateRow.className = 'tooltip__row';
			const date = new Date(commit.date);
			dateRow.textContent = `${capitalize(fromNow(date))} (${formatDate(date, this.dateFormat)})`;

			const message = document.createElement('div');
			message.className = 'tooltip__message';
			message.textContent = commit.message;

			const binCount = this._viewModel.binCount?.[index];
			const children: HTMLElement[] = [author, detailsRow, dateRow, message];
			if (binCount != null && binCount > 1) {
				const binRow = document.createElement('div');
				binRow.className = 'tooltip__row';
				binRow.textContent = `+${binCount - 1} more in this ${this._binUnit}`;
				children.push(binRow);
			}

			tooltip.replaceChildren(...children);
			tooltip.dataset.visible = 'true';

			const tipRect = tooltip.getBoundingClientRect();
			this._tooltipW = tipRect.width || 320;
			this._tooltipH = tipRect.height || 100;
			this._tooltipSha = commit.sha;
		} else {
			tooltip.dataset.visible = 'true';
		}

		// Side-swap when the cursor is far enough right that the default right-side anchor would
		// run the tooltip off the canvas — measured tooltip dimensions are cached so the swap point
		// adapts to the actual content (sometimes a long author name pushes the tooltip wider
		// than the CSS max-width estimate).
		const lo = this._layout;
		const viewportW = lo?.width ?? 0;
		const viewportH = lo?.height ?? 0;
		const tipW = this._tooltipW;
		const tipH = this._tooltipH;
		const padding = 12;

		let left = x + padding;
		if (left + tipW > viewportW) {
			// Doesn't fit on the right of the cursor — flip to the left side. If it still doesn't
			// fit (very narrow placements), clamp to the right edge so it stays on screen.
			left = x - padding - tipW;
			if (left < 0) {
				left = Math.max(0, viewportW - tipW);
			}
		}

		let top = y + padding;
		if (top + tipH > viewportH) {
			top = y - padding - tipH;
			if (top < 0) {
				top = Math.max(0, viewportH - tipH);
			}
		}

		tooltip.style.left = `${left}px`;
		tooltip.style.top = `${top}px`;
	}

	private _hideTooltip(): void {
		const tooltip = this._tooltipEl;
		if (tooltip == null) return;
		tooltip.dataset.visible = 'false';
		this._tooltipSha = undefined;
	}

	resetZoom(): void {
		if (this._zoomRange == null) return;
		this._zoomRange = undefined;
		this._zoomed = false;
		this._viewModel = undefined;
		this._requestDraw();
	}
}

function formatTickLabel(
	date: Date,
	unit: 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year',
	shortFmt: string,
	opts: { showYear: boolean },
): string {
	switch (unit) {
		case 'hour':
			return formatDate(date, 'h a');
		case 'year':
			return formatDate(date, 'YYYY');
		case 'quarter':
		case 'month':
			return opts.showYear ? formatDate(date, 'MMM YYYY') : formatDate(date, 'MMM');
		default:
			return formatDate(date, opts.showYear ? shortFmt || 'MMM D, YYYY' : shortFmt || 'MMM D');
	}
}

function capitalize(s: string): string {
	return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Cubic ease-out — fast at the start, gentle at the end. Gives the hover scale-up that "pop"
 * feel without overshoot, and matches the curve a system motion toolkit would use by default. */
function easeOutCubic(t: number): number {
	const clamped = Math.max(0, Math.min(1, t));
	return 1 - (1 - clamped) ** 3;
}

/**
 * Compute a 1- or 2-character initials string from an author / branch name. Splits on whitespace
 * and most punctuation; falls back to the first 2 characters when the name has no separator
 * (e.g. usernames like `wolfsilver`) or to "?" when empty. Mirrors the heuristic VS Code uses for
 * its own avatar fallbacks.
 */
function computeInitials(name: string | undefined): string {
	if (!name) return '?';
	const parts = name
		.split(/[\s_\-/.@]+/)
		.map(p => p.trim())
		.filter(p => p.length > 0);
	if (parts.length === 0) return '?';
	if (parts.length === 1) return parts[0].slice(0, 2);
	return parts[0][0] + (parts.at(-1) ?? '')[0];
}

export interface CommitEventDetail {
	id: string | undefined;
	shift: boolean;
	/** True when the selection is mid-drag (slider scrub) and the diff should be previewed but
	 * not committed — `actions.selectDataPoint` skips the host RPC for interim events so the
	 * editor doesn't churn through a diff per slider tick. */
	interim?: boolean;
}

declare global {
	interface HTMLElementTagNameMap {
		'gl-timeline-chart': GlTimelineChart;
	}

	interface GlobalEventHandlersEventMap {
		'gl-commit-select': CustomEvent<CommitEventDetail>;
		'gl-loading': CustomEvent<Promise<void>>;
	}
}
