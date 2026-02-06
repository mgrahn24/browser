import { chromium, Browser, Page } from 'playwright';
import { Strategy, ClickEverywhereStrategy, DOMScanStrategy, ContentScanStrategy, HierarchyScanStrategy, AIRelevanceStrategy, SmartButtonClickStrategy } from './strategies';

export interface RunnerConfig {
    targetUrl: string;
    headless: boolean;
    strategies: Strategy[];
    auto?: boolean;
}

/**
 * Runner that loops through strategies indefinitely
 */
export class Runner {
    private config: RunnerConfig;
    private browser: Browser | null = null;
    private running = true;
    private isPaused = false;
    private autoMode: boolean; // Mutable auto mode that can be toggled

    constructor(config: Partial<RunnerConfig> & { targetUrl: string }) {
        this.config = {
            targetUrl: config.targetUrl,
            headless: config.headless ?? true,
            strategies: config.strategies ?? [new AIRelevanceStrategy()],
            auto: config.auto ?? false,
        };
        this.autoMode = this.config.auto ?? false; // Initialize from config
    }

    async run(): Promise<void> {
        console.log('🚀 Browser Challenge Runner');
        console.log(`Target: ${this.config.targetUrl}`);
        console.log(`Headless: ${this.config.headless}`);
        console.log(`Auto Mode: ${this.autoMode ? 'ENABLED (Alternating AI/Click)' : 'DISABLED (Manual)'}`);
        console.log(`Strategies: ${this.config.strategies.map(s => s.name).join(', ')}`);
        console.log('Press [P] to pause/resume, [M] to toggle mode, Ctrl+C to stop\n');

        this.browser = await chromium.launch({
            headless: this.config.headless,
        });

        const context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 },
        });

        const page = await context.newPage();

        // Setup keyboard listeners
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', (data) => {
                const key = data.toString();
                if (key.toLowerCase() === 'p') {
                    this.isPaused = !this.isPaused;
                    if (this.isPaused) {
                        console.log('\n⏸️  PAUSED. Press [P] to resume...');
                    } else {
                        console.log('\n▶️  RESUMING...');
                    }
                } else if (key.toLowerCase() === 'm') {
                    this.autoMode = !this.autoMode;

                    // Update debug mode in all strategies
                    const newDebugMode = !this.autoMode;
                    this.config.strategies.forEach(strategy => {
                        if ('setDebugMode' in strategy && typeof strategy.setDebugMode === 'function') {
                            (strategy as any).setDebugMode(newDebugMode);
                        }
                    });

                    const mode = this.autoMode ? 'AUTO (Continuous AI execution)' : 'MANUAL (Step-by-step with debug pauses)';
                    console.log(`\n🔄 MODE SWITCHED: ${mode}`);
                } else if (key === '\u0003') { // Ctrl+C
                    console.log('\n\nStopping...');
                    process.exit(0);
                }
            });
        }

        process.on('SIGINT', () => {
            console.log('\n\nStopping...');
            this.running = false;
        });

        try {
            console.log(`Navigating to ${this.config.targetUrl}...`);
            await page.goto(this.config.targetUrl, { waitUntil: 'domcontentloaded' });

            const startRunTime = Date.now();
            let round = 1;

            while (this.running) {
                if (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                const elapsedTotal = Math.floor((Date.now() - startRunTime) / 1000);
                console.log(`\n=== Round ${round} (Elapsed: ${elapsedTotal}s) ===`);

                let strategy: Strategy;

                if (this.autoMode) {
                    const smartStrategy = this.config.strategies.find(s => s.name === 'smart-button-click');
                    const aiStrategy = this.config.strategies.find(s => s.name === 'ai-relevance');

                    if (round % 2 === 0 && smartStrategy) {
                        strategy = smartStrategy;
                        console.log(`\n🔄 [AUTO] Round ${round}: Executing Smart Button Clicker (Z-Priority) to shake up state...`);
                    } else {
                        strategy = aiStrategy || this.config.strategies[0];
                    }

                    // Small delay between rounds to let page settle naturally
                    await page.waitForTimeout(500);
                } else {
                    console.log('Available Strategies:');
                    this.config.strategies.forEach((s, i) => {
                        console.log(`  ${i + 1}. ${s.name}`);
                    });

                    console.log('\nPress [1-' + this.config.strategies.length + '] to run a strategy, or Ctrl+C to stop...');

                    // Use raw mode to capture keypress
                    const strategyIndex = await new Promise<number>((resolve) => {
                        const handleKey = (data: Buffer) => {
                            const key = data.toString();

                            // Handle Ctrl+C (SIGINT)
                            if (key === '\u0003') {
                                console.log('\n\nStopping...');
                                process.exit(0);
                            }

                            const num = parseInt(key);
                            if (!isNaN(num) && num > 0 && num <= this.config.strategies.length) {
                                process.stdin.removeListener('data', handleKey);
                                // Keep raw mode on so 'M' and 'P' keys continue working
                                resolve(num - 1);
                            }
                        };

                        // Raw mode is already on from initial setup, just add the listener
                        process.stdin.on('data', handleKey);
                    });

                    strategy = this.config.strategies[strategyIndex];
                }

                console.log(`\nExecuting: ${strategy.name}`);
                try {
                    const result = await strategy.execute(page);
                    console.log(`  → ${result.message}`);
                } catch (error) {
                    console.log(`  → Error: ${error}`);
                }

                round++;
            }

            console.log('\n✅ Stopped.');
        } catch (error) {
            console.error('Error:', error);
        } finally {
            await this.browser.close();
        }
    }

    private shuffle<T>(array: T[]): T[] {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
}

// Simple CLI
async function main() {
    const args = process.argv.slice(2);

    let url = '';
    let headless = true;
    let auto = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-u' || args[i] === '--url') {
            url = args[++i];
        } else if (args[i] === '--no-headless') {
            headless = false;
        } else if (args[i] === '--headless') {
            headless = true;
        } else if (args[i] === '--auto') {
            auto = true;
        }
    }

    if (!url) {
        console.log('Usage: npm start -- -u <url> [--no-headless] [--auto]');
        process.exit(1);
    }

    // Expose all available strategies for selection
    // Enable debug mode (step-through) when not in auto mode
    const debugMode = !auto;

    const runner = new Runner({
        targetUrl: url,
        headless,
        auto,
        strategies: [
            new AIRelevanceStrategy(200, debugMode)
        ],
    });

    await runner.run();
}

main();
