const INTERACTIVE_SELECTOR = 'button, [role="button"], .clickable-icon';

export const BUTTON_DEBOUNCE_MS = 400;

/**
 * Install a capture-phase guard on one Clip2MD settings/modal root. Dynamic
 * buttons are covered automatically, while buttons outside the plugin root
 * are left untouched.
 */
export function installButtonClickGuard(root: HTMLElement, wait = BUTTON_DEBOUNCE_MS): void {
    if (root.dataset.clip2mdButtonGuard === 'true') return;
    root.dataset.clip2mdButtonGuard = 'true';
    const lastClickAt = new WeakMap<HTMLElement, number>();

    root.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const button = target.closest(INTERACTIVE_SELECTOR);
        if (!(button instanceof HTMLElement) || !root.contains(button)) return;
        if (button.instanceOf(HTMLButtonElement) && button.disabled) return;
        if (button.getAttribute('aria-disabled') === 'true') return;

        const now = Date.now();
        const last = lastClickAt.get(button);
        if (last !== undefined && now - last < wait) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        lastClickAt.set(button, now);
    }, true);
}
