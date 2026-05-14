import type { TemplateResult } from 'lit';
import { html } from 'lit';
import '../../../shared/components/code-icon.js';

export function renderLoadingState(text: string): TemplateResult {
	return html`<div class="review-loading" aria-busy="true" aria-live="polite">
		<div class="review-loading__spinner">
			<code-icon icon="loading" modifier="spin"></code-icon>
		</div>
		<span class="review-loading__text">${text}</span>
	</div>`;
}

export function renderErrorState(
	errorMessage: string | undefined,
	defaultMessage: string,
	retryEventName: string,
): TemplateResult {
	return html`<div class="review-error" role="alert">
		<code-icon icon="error"></code-icon>
		<span>${errorMessage ?? defaultMessage}</span>
		<button
			class="review-error__retry"
			@click=${(e: Event) => {
				(e.currentTarget as HTMLElement).dispatchEvent(
					new CustomEvent(retryEventName, { bubbles: true, composed: true }),
				);
			}}
		>
			Retry
		</button>
	</div>`;
}

/**
 * Vertical chrome (padding + border) of the `.scope-split__picker` wrapper that hosts the scope
 * pane in review/compose mode. `GlCommitsScopePane.contentHeight` only measures the inner scroll
 * pane, so the `.scope-split` snap function adds this to size the fit-content track to the
 * picker's true height — otherwise the track clamps short and clips the content / desyncs the
 * divider. Pass the `gl-commits-scope-pane` element; returns 0 if it isn't inside a picker.
 */
export function getScopeSplitPickerChrome(scopeEl: Element): number {
	const picker = scopeEl.closest<HTMLElement>('.scope-split__picker');
	if (picker == null) return 0;

	const style = getComputedStyle(picker);
	return (
		parseFloat(style.paddingTop) +
		parseFloat(style.paddingBottom) +
		parseFloat(style.borderTopWidth) +
		parseFloat(style.borderBottomWidth)
	);
}
