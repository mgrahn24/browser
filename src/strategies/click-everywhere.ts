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
    private showClicks: boolean;
    private directionIndex: number = 0;
    private directions = ['TOP_TO_BOTTOM', 'BOTTOM_TO_TOP', 'LEFT_TO_RIGHT', 'RIGHT_TO_LEFT'];

    constructor(clickDelayMs: number = 0, showClicks: boolean = false) {
        this.clickDelayMs = clickDelayMs;
        this.showClicks = showClicks;
    }

    async execute(page: Page, stopSignal?: { shouldStop: boolean }): Promise<StrategyResult> {
        const start = Date.now();
        const viewport = page.viewportSize() || { width: 1280, height: 720 };

        if (this.showClicks) {
            await this.injectClickVisualizer(page);
        }

        const gridSize = 64; // Fixed 64x64 grid
        const direction = this.directions[this.directionIndex];
        console.log(`[ClickEverywhere] 64x64 grid (${gridSize * gridSize} points) - Direction: ${direction}...`);

        const clickCount = await this.clickGrid(page, viewport, gridSize, direction, stopSignal);

        // Cycle direction for next round
        this.directionIndex = (this.directionIndex + 1) % this.directions.length;

        const timeMs = Date.now() - start;
        return {
            success: true,
            message: `64x64 [${direction}]: ${clickCount} clicks in ${timeMs}ms`,
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
                if (this.showClicks) {
                    await page.evaluate(({ x, y }) => {
                        (window as any).__showClick?.(x, y);
                    }, { x, y });
                }

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

    private async injectClickVisualizer(page: Page): Promise<void> {
        await page.evaluate(() => {
            if ((window as any).__clickVisualizerInjected) return;
            (window as any).__clickVisualizerInjected = true;

            const container = document.createElement('div');
            container.id = '__click-visualizer';
            container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;';
            document.body.appendChild(container);

            (window as any).__showClick = (x: number, y: number) => {
                const dot = document.createElement('div');
                dot.style.cssText = `
          position: fixed;
          left: ${x - 5}px;
          top: ${y - 5}px;
          width: 10px;
          height: 10px;
          background: rgba(255, 50, 50, 0.9);
          border: 1px solid white;
          border-radius: 50%;
          pointer-events: none;
          z-index: 999999;
          animation: clickPop 0.2s ease-out forwards;
        `;
                container.appendChild(dot);
                setTimeout(() => dot.remove(), 200);
            };

            const style = document.createElement('style');
            style.textContent = `
        @keyframes clickPop {
          0% { transform: scale(1); opacity: 1; }
          100% { transform: scale(1.3); opacity: 0; }
        }
      `;
            document.head.appendChild(style);
        });
    }
}
