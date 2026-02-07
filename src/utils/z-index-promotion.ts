import { Page } from 'playwright';
import * as readline from 'readline';

export interface ZIndexPromotionOptions {
    debugMode?: boolean;
    showOverlay?: boolean;
    waitForUser?: boolean;
}

/**
 * Wait for user to press Enter in the terminal
 */
async function waitForEnter(): Promise<void> {
    return new Promise((resolve) => {
        // Save current raw mode state
        const wasRaw = process.stdin.isRaw;

        // Temporarily disable raw mode for readline
        if (wasRaw) {
            process.stdin.setRawMode(false);
        }

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('', () => {
            rl.close();

            // Restore raw mode if it was enabled
            if (wasRaw && process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }

            resolve();
        });
    });
}

/**
 * Promotes an element and all its ancestors to the top z-index layer
 * to ensure interactions aren't blocked by overlays.
 *
 * Important: This handles nested stacking contexts where a child's z-index
 * is relative to its parent's stacking context.
 */
export async function withZIndexPromotion<T>(
    page: Page,
    selector: string,
    action: () => Promise<T>,
    options: ZIndexPromotionOptions = {}
): Promise<T> {
    // Promote element and ancestors to top layer
    const restore = await page.evaluate((sel) => {
        const element = document.querySelector(sel);
        if (!element) return null;

        // Helper function to generate a unique selector (defined in browser context)
        const generateUniqueSelector = (element: Element): string => {
            // Try data-ai-id first (most reliable in this system)
            const aiId = element.getAttribute('data-ai-id');
            if (aiId) {
                return `[data-ai-id="${aiId}"]`;
            }

            // Fall back to ID
            if (element.id) {
                return `#${element.id}`;
            }

            // Fall back to nth-child path
            const path: string[] = [];
            let current: Element | null = element;

            while (current && current !== document.body) {
                let selector = current.tagName.toLowerCase();

                if (current.parentElement) {
                    const siblings = Array.from(current.parentElement.children);
                    const index = siblings.indexOf(current);
                    if (siblings.length > 1) {
                        selector += `:nth-child(${index + 1})`;
                    }
                }

                path.unshift(selector);
                current = current.parentElement;
            }

            return path.join(' > ');
        };

        const originalStyles: Array<{
            element: Element;
            zIndex: string;
            position: string;
            hadPosition: boolean;
        }> = [];

        // Get all ancestors up to body
        const ancestors: Element[] = [];
        let current: Element | null = element;
        while (current && current !== document.body) {
            ancestors.push(current);
            current = current.parentElement;
        }

        // Promote each ancestor in the chain
        ancestors.forEach((el) => {
            const computed = window.getComputedStyle(el);
            const htmlEl = el as HTMLElement;

            const original = {
                element: el,
                zIndex: htmlEl.style.zIndex,
                position: htmlEl.style.position,
                hadPosition: computed.position !== 'static'
            };
            originalStyles.push(original);

            // Ensure element is positioned (needed for z-index to work)
            if (computed.position === 'static') {
                htmlEl.style.position = 'relative';
            }

            // Promote to top layer
            htmlEl.style.zIndex = '999999';
        });

        // Return restoration data serialized
        return originalStyles.map(s => ({
            selector: generateUniqueSelector(s.element),
            zIndex: s.zIndex,
            position: s.position,
            hadPosition: s.hadPosition
        }));
    }, selector);

    // Small delay to ensure browser applies z-index changes
    await page.waitForTimeout(50);

    // Determine if we should show overlay and/or wait
    const shouldShowOverlay = options.showOverlay ?? options.debugMode ?? false;
    const shouldWait = options.waitForUser ?? options.debugMode ?? false;

    // Add visual indicators if enabled
    if (shouldShowOverlay && restore) {
        await page.evaluate((selectors) => {
            selectors.forEach(({ selector }: any) => {
                const el = document.querySelector(selector) as HTMLElement;
                if (el) {
                    el.style.outline = '3px solid #00ff00';
                    el.style.outlineOffset = '2px';
                }
            });
        }, restore);

        // Wait for user to press Enter (only if enabled)
        if (shouldWait) {
            console.log('\n⏸️  [DEBUG] Z-index promoted. Press ENTER to continue...\n');
            await waitForEnter();
        }
    }

    try {
        // Perform the action with element promoted
        return await action();
    } finally {
        // Remove visual indicators if they were added
        if (shouldShowOverlay && restore) {
            await page.evaluate((selectors) => {
                selectors.forEach(({ selector }: any) => {
                    const el = document.querySelector(selector) as HTMLElement;
                    if (el) {
                        el.style.outline = '';
                        el.style.outlineOffset = '';
                    }
                });
            }, restore);
        }

        // Restore original styles
        if (restore) {
            await page.evaluate((styleData) => {
                styleData.forEach(({ selector, zIndex, position, hadPosition }) => {
                    const el = document.querySelector(selector) as HTMLElement;
                    if (el) {
                        el.style.zIndex = zIndex;
                        if (!hadPosition) {
                            el.style.position = position;
                        }
                    }
                });
            }, restore);
        }
    }
}
