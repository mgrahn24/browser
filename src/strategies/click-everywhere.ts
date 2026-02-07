import { Page } from 'playwright';
import { Strategy, StrategyResult } from './base';

/**
 * Progressive density click strategy.
 * Starts with sparse grid, keeps getting denser each pass.
 * 2x2 → 4x4 → 8x8 → 16x16 → repeat
 */
export class ClickEverywhereStrategy implements Strategy {
    name = 'click-everywhere';

    private clickDelayMs: number;
    private directionIndex: number = 0;
    private directions = ['TOP_TO_BOTTOM', 'BOTTOM_TO_TOP', 'LEFT_TO_RIGHT', 'RIGHT_TO_LEFT'];

    constructor(clickDelayMs: number = 0, showClicks: boolean = false) {
        this.clickDelayMs = clickDelayMs;
    }

    async execute(page: Page, stopSignal?: { shouldStop: boolean }): Promise<StrategyResult> {
        const start = Date.now();
        const viewport = page.viewportSize() || { width: 1280, height: 720 };

        const gridSize = 50; // Fixed 50x50 grid 
        const direction = this.directions[this.directionIndex];
        console.log(`[ClickEverywhere] 50x50 grid (${gridSize * gridSize} points) - Direction: ${direction}...`);

        const clickCount = await this.clickGrid(page, viewport, gridSize, direction, stopSignal);

        // Cycle direction for next round
        this.directionIndex = (this.directionIndex + 1) % this.directions.length;

        const timeMs = Date.now() - start;
        return {
            success: true,
            message: `50x50 [${direction}]: ${clickCount} clicks in ${timeMs}ms`,
            timeMs,
        };
    }

    private async clickGrid(
        page: Page,
        viewport: { width: number; height: number },
        gridSize: number,
        direction: string,
        stopSignal?: { shouldStop: boolean }
    ): Promise<number> {
        const stepX = viewport.width / gridSize;
        const stepY = viewport.height / gridSize;
        let clicks = 0;

        const coords: { x: number, y: number }[] = [];

        if (direction === 'TOP_TO_BOTTOM') {
            for (let row = 0; row < gridSize; row++) {
                for (let col = 0; col < gridSize; col++) {
                    coords.push({
                        x: Math.floor(stepX * col + stepX / 2),
                        y: Math.floor(stepY * row + stepY / 2)
                    });
                }
            }
        } else if (direction === 'BOTTOM_TO_TOP') {
            for (let row = gridSize - 1; row >= 0; row--) {
                for (let col = 0; col < gridSize; col++) {
                    coords.push({
                        x: Math.floor(stepX * col + stepX / 2),
                        y: Math.floor(stepY * row + stepY / 2)
                    });
                }
            }
        } else if (direction === 'LEFT_TO_RIGHT') {
            for (let col = 0; col < gridSize; col++) {
                for (let row = 0; row < gridSize; row++) {
                    coords.push({
                        x: Math.floor(stepX * col + stepX / 2),
                        y: Math.floor(stepY * row + stepY / 2)
                    });
                }
            }
        } else if (direction === 'RIGHT_TO_LEFT') {
            for (let col = gridSize - 1; col >= 0; col--) {
                for (let row = 0; row < gridSize; row++) {
                    coords.push({
                        x: Math.floor(stepX * col + stepX / 2),
                        y: Math.floor(stepY * row + stepY / 2)
                    });
                }
            }
        }

        for (const { x, y } of coords) {
            if (stopSignal?.shouldStop) break;
            try {
                await page.mouse.click(x, y, { delay: 0 });
                clicks++;

                if (this.clickDelayMs > 0) {
                    await page.waitForTimeout(this.clickDelayMs);
                }
            } catch {
                // Ignore
            }
        }
        return clicks;
    }
}
