import { Page } from 'playwright';
import { Strategy, StrategyResult } from './base';

interface InteractableElement {
    tagName: string;
    id: string;
    rect: { x: number; y: number; width: number; height: number };
}

/**
 * Scans for ALL potentially interactable elements and clicks them immediately.
 * No prioritization - just speed.
 */
export class ContentScanStrategy implements Strategy {
    name = 'content-scan';

    async execute(page: Page): Promise<StrategyResult> {
        const start = Date.now();

        // 1. Scan for all clickables
        const clickables = await page.evaluate(this.scanClickables);

        console.log(`[ContentScan] Found ${clickables.length} clickable elements.`);

        // 2. Click them all fast
        let clicked = 0;
        for (const el of clickables) {
            try {
                // Click center
                const x = el.rect.x + el.rect.width / 2;
                const y = el.rect.y + el.rect.height / 2;

                await page.mouse.click(x, y, { delay: 0 });
                clicked++;
            } catch (e) {
                // Ignore errors (element moved/detached)
            }
        }

        const timeMs = Date.now() - start;
        return {
            success: true,
            message: `Clicked ${clicked}/${clickables.length} elements in ${timeMs}ms`,
            timeMs
        };
    }

    /**
     * Finds all elements that look interactable.
     */
    private scanClickables(): InteractableElement[] {
        const results: InteractableElement[] = [];

        const isVisible = (el: HTMLElement) => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
        };

        const allElements = document.querySelectorAll('*');

        allElements.forEach(node => {
            const el = node as HTMLElement;
            if (!isVisible(el)) return;

            const tagName = el.tagName.toLowerCase();
            const style = window.getComputedStyle(el);
            const role = el.getAttribute('role');

            // Heuristic for "clickable"
            const isInteractiveTag = ['button', 'a', 'input', 'select', 'textarea', 'summary', 'details'].includes(tagName);
            const isInteractiveRole = ['button', 'link', 'menuitem', 'checkbox', 'radio', 'switch'].includes(role || '');
            const hasPointerCursor = style.cursor === 'pointer';
            const hasOnClick = el.hasAttribute('onclick');

            if (isInteractiveTag || isInteractiveRole || hasPointerCursor || hasOnClick) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    results.push({
                        tagName,
                        id: el.id,
                        rect: {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width,
                            height: rect.height
                        }
                    });
                }
            }
        });

        return results;
    }
}
