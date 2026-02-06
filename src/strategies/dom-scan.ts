import { Page } from 'playwright';
import { Strategy, StrategyResult } from './base';

interface Candidate {
    selector: string; // Unique CSS selector
    score: number;
    rect: { x: number; y: number; width: number; height: number };
    tagName: string;
    text: string;
    reason: string[];
}

/**
 * Scans the DOM to identify and prioritize interactable elements using heuristics.
 * Scores elements based on tag, cursor style, attributes, and content.
 */
export class DOMScanStrategy implements Strategy {
    name = 'dom-scan';

    private maxCandidates: number;
    private clickDelayMs: number;
    private visualize: boolean;

    constructor(maxCandidates: number = 20, clickDelayMs: number = 500, visualize: boolean = true) {
        this.maxCandidates = maxCandidates;
        this.clickDelayMs = clickDelayMs;
        this.visualize = visualize;
    }

    async execute(page: Page): Promise<StrategyResult> {
        const start = Date.now();

        // 1. Inject Analysis Script and get ranked candidates
        const candidates = await page.evaluate(this.analyzeDOM);

        console.log(`[DOMScan] Found ${candidates.length} candidates. Top 3:`);
        candidates.slice(0, 3).forEach((c, i) =>
            console.log(`  ${i + 1}. [${c.score}] <${c.tagName}> "${c.text.substring(0, 20)}" - ${c.reason.join(', ')}`)
        );

        // 2. visualize candidates
        if (this.visualize) {
            await this.visualizeCandidates(page, candidates);
        }

        // 3. Interact with top candidates
        let clicks = 0;
        const topCandidates = candidates.slice(0, this.maxCandidates);

        for (const candidate of topCandidates) {
            try {
                // Calculate center point
                const x = candidate.rect.x + candidate.rect.width / 2;
                const y = candidate.rect.y + candidate.rect.height / 2;

                console.log(`[DOMScan] Clicking <${candidate.tagName}> "${candidate.text.substring(0, 15)}..." (Score: ${candidate.score})`);

                await page.mouse.click(x, y);
                clicks++;

                if (this.clickDelayMs > 0) {
                    await page.waitForTimeout(this.clickDelayMs);
                }
            } catch (e) {
                // Ignore click failures (overlapped, moved, etc)
            }
        }

        const timeMs = Date.now() - start;
        return {
            success: true,
            message: `Scanned and clicked ${clicks} high-probability targets in ${timeMs}ms`,
            timeMs
        };
    }

    /**
     * Browser-side DOM analysis function.
     * This runs inside the page context.
     */
    private analyzeDOM(): Candidate[] {
        const candidates: Candidate[] = [];
        const elements = document.querySelectorAll('*');

        // Helper to generate a unique selector (simplified)
        const getSelector = (el: Element): string => {
            if (el.id) return `#${el.id}`;
            let path = [];
            let current = el;
            while (current && current.nodeName !== 'HTML') {
                let selector = current.nodeName.toLowerCase();
                if (current.id) {
                    selector = '#' + current.id;
                    path.unshift(selector);
                    break;
                } else if (current.parentElement) {
                    let siblings = Array.from(current.parentElement.children).filter(e => e.nodeName === current.nodeName);
                    if (siblings.length > 1) {
                        selector += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                    }
                }
                path.unshift(selector);
                current = current.parentElement as Element;
            }
            return path.join(' > ');
        };

        // Helper to check visibility
        const isVisible = (el: HTMLElement) => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0;
        }

        elements.forEach((el) => {
            const element = el as HTMLElement;
            if (!isVisible(element)) return;

            const rect = element.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return; // Too small

            let score = 0;
            const reasons: string[] = [];
            const tagName = element.tagName.toLowerCase();
            const style = window.getComputedStyle(element);

            // --- Heuristics ---

            // 1. Interactive Tags
            if (['button', 'a', 'input', 'select', 'textarea', 'label'].includes(tagName)) {
                score += 10;
                reasons.push('tag');
            }

            // 2. Cursor Pointer
            if (style.cursor === 'pointer') {
                score += 15;
                reasons.push('cursor');
            }

            // 3. Attributes
            if (element.hasAttribute('onclick') || element.getAttribute('role') === 'button') {
                score += 10;
                reasons.push('attr');
            }
            if (element.getAttribute('tabindex') === '0') {
                score += 5;
            }

            // 4. Content Analysis
            const text = (element.innerText || '').trim().toLowerCase();
            if (text.length > 0 && text.length < 50) { // Keep it short labels
                const actionWords = ['next', 'start', 'continue', 'submit', 'go', 'play', 'enter', 'click'];
                const noiseWords = ['privacy', 'terms', 'copyright'];

                if (actionWords.some(w => text.includes(w))) {
                    score += 5;
                    reasons.push('keyword');
                }
                if (noiseWords.some(w => text.includes(w))) {
                    score -= 10;
                    reasons.push('noise');
                }
            }

            // 5. Penalties
            if (tagName === 'div' || tagName === 'span') {
                // Only interest in divs/spans if they act like buttons
                if (score < 15) score = 0;
            }

            // Structure-based filtering
            // Avoid clicking container divs even if they have cursor pointer but cover massive area
            if (rect.width > window.innerWidth * 0.9 && rect.height > window.innerHeight * 0.9) {
                score -= 20; // Probably a wrapper
            }

            if (score > 5) {
                candidates.push({
                    selector: getSelector(element),
                    score,
                    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    tagName,
                    text: element.innerText?.substring(0, 50) || '',
                    reason: reasons
                });
            }
        });

        // Sort by score descending
        return candidates.sort((a, b) => b.score - a.score);
    }

    private async visualizeCandidates(page: Page, candidates: Candidate[]): Promise<void> {
        await page.evaluate((candidates) => {
            // Clear previous
            const old = document.getElementById('__dom_scan_vis');
            if (old) old.remove();

            const container = document.createElement('div');
            container.id = '__dom_scan_vis';
            container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999998;';
            document.body.appendChild(container);

            // Only visualize top 50 to avoid clutter
            candidates.slice(0, 50).forEach((c, idx) => {
                const box = document.createElement('div');
                const color = idx < 5 ? '#00ff00' : (idx < 20 ? '#ffff00' : '#ff0000'); // Top 5 green, then yellow, then red

                box.style.cssText = `
          position: absolute;
          left: ${c.rect.x}px;
          top: ${c.rect.y}px;
          width: ${c.rect.width}px;
          height: ${c.rect.height}px;
          border: 2px solid ${color};
          background-color: ${color}20; /* 20 = low opacity hex */
          box-sizing: border-box;
          pointer-events: none;
        `;

                // Label with rank
                const label = document.createElement('div');
                label.innerText = `#${idx + 1} (${c.score})`;
                label.style.cssText = `
            position: absolute;
            top: -16px;
            left: 0;
            background: ${color};
            color: black;
            font-size: 10px;
            padding: 1px 3px;
        `;
                box.appendChild(label);

                container.appendChild(box);
            });
        }, candidates);
    }
}
