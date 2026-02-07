import { Page } from 'playwright';
import { Strategy, StrategyResult } from './base';
import { withZIndexPromotion } from '../utils/z-index-promotion';

export class SmartButtonClickStrategy implements Strategy {
    name = 'smart-button-click';
    private debugMode: boolean;

    constructor(debugMode: boolean = false) {
        this.debugMode = debugMode;
    }

    async execute(page: Page): Promise<StrategyResult> {
        const start = Date.now();

        console.log(`[SmartClick] Identifying interactive elements and analyzing Z-Index/Cursor...`);

        const elements = await page.evaluate(() => {
            const interactiveSelectors = [
                'button', 'a', 'input[type="button"]', 'input[type="submit"]',
                'input[type="reset"]', '[role="button"]', '[onclick]'
            ];

            const results: any[] = [];
            const seen = new Set();

            interactiveSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                    if (seen.has(el)) return;
                    seen.add(el);

                    const htmlEl = el as HTMLElement;
                    const style = window.getComputedStyle(htmlEl);

                    // Filter out truly invisible elements
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

                    // Filter out explicitly non-clickable elements
                    if (style.cursor === 'not-allowed' || style.pointerEvents === 'none' || (htmlEl as any).disabled) return;

                    const rect = htmlEl.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return;

                    // Calculate effective Z-Index
                    let zIndex = 0;
                    let current: Element | null = htmlEl;
                    while (current) {
                        const s = window.getComputedStyle(current);
                        const z = parseInt(s.zIndex);
                        if (!isNaN(z)) {
                            zIndex = Math.max(zIndex, z);
                        }
                        current = current.parentElement;
                    }

                    // Get cursor style
                    const cursor = style.cursor;

                    // Unique selector or data-ai-id
                    let aiId = htmlEl.getAttribute('data-ai-id');
                    if (!aiId) {
                        // Generate a temporary ID if missing
                        aiId = `temp-${Math.random().toString(36).substr(2, 9)}`;
                        htmlEl.setAttribute('data-ai-id', aiId);
                    }

                    results.push({
                        id: aiId,
                        tag: htmlEl.tagName.toLowerCase(),
                        text: htmlEl.innerText?.substring(0, 30).replace(/\n/g, ' ') || '',
                        zIndex,
                        cursor,
                        priority: cursor === 'pointer' ? 1 : 0
                    });
                });
            });

            // Sort by Z-Index (desc), then by cursor priority (desc)
            return results.sort((a, b) => {
                if (b.zIndex !== a.zIndex) return b.zIndex - a.zIndex;
                return b.priority - a.priority;
            });
        });

        console.log(`[SmartClick] Found ${elements.length} candidates. Executing top-down...`);

        let clickCount = 0;
        for (const el of elements) {
            try {
                const selector = `[data-ai-id="${el.id}"]`;
                // Promote element z-index before clicking
                await withZIndexPromotion(page, selector, async () => {
                    // We use a very short timeout since this is a brute-force sweep
                    await page.click(selector, { timeout: 200, force: true });
                }, { showOverlay: this.debugMode, waitForUser: false });
                clickCount++;
                console.log(`  ✅ Clicked [Z:${el.zIndex}] [${el.cursor}] <${el.tag}> "${el.text}"`);

                // Optional: Check if page changed significantly to skip remaining?
                // For now, click 'em all as requested.
            } catch (err) {
                // Skip failed clicks quietly
            }
        }

        const timeMs = Date.now() - start;
        return {
            success: true,
            message: `Smart clicked ${clickCount}/${elements.length} elements in ${timeMs}ms`,
            timeMs
        };
    }
}
