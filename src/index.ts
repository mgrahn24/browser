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
    private rawModeGuardInterval?: NodeJS.Timeout;
    private pauseStartTime?: number;
    private totalPausedTime = 0;

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

        // Set auto mode on strategies
        this.config.strategies.forEach(strategy => {
            if ('setAutoMode' in strategy && typeof strategy.setAutoMode === 'function') {
                (strategy as any).setAutoMode(this.autoMode);
            }
        });

        // Setup keyboard listeners
        if (process.stdin.isTTY) {
            process.stdin.setEncoding('utf8');
            process.stdin.setRawMode(true);
            process.stdin.resume();

            // Use a named function so we can reference it
            const keyHandler = (data: Buffer) => {
                const key = data.toString();
                if (key.toLowerCase() === 'p') {
                    this.isPaused = !this.isPaused;
                    if (this.isPaused) {
                        // Record when pause started
                        this.pauseStartTime = Date.now();
                        console.log('\n⏸️  PAUSED. Press [P] to resume...');
                    } else {
                        // Calculate pause duration and add to total
                        if (this.pauseStartTime !== undefined) {
                            this.totalPausedTime += Date.now() - this.pauseStartTime;
                            this.pauseStartTime = undefined;
                        }
                        console.log('\n▶️  RESUMING...');
                    }
                    // Ensure raw mode stays enabled after pause toggle
                    if (process.stdin.isTTY && !process.stdin.isRaw) {
                        process.stdin.setRawMode(true);
                    }
                } else if (key.toLowerCase() === 'm') {
                    this.autoMode = !this.autoMode;

                    // Update auto mode and keep debug mode always enabled
                    this.config.strategies.forEach(strategy => {
                        if ('setAutoMode' in strategy && typeof strategy.setAutoMode === 'function') {
                            (strategy as any).setAutoMode(this.autoMode);
                        }
                        if ('setDebugMode' in strategy && typeof strategy.setDebugMode === 'function') {
                            (strategy as any).setDebugMode(true);
                        }
                    });

                    const mode = this.autoMode ? 'AUTO (Continuous AI execution)' : 'MANUAL (Step-by-step with debug pauses)';
                    console.log(`\n🔄 MODE SWITCHED: ${mode}`);

                    // Ensure raw mode stays enabled after mode switch
                    if (process.stdin.isTTY && !process.stdin.isRaw) {
                        process.stdin.setRawMode(true);
                    }
                } else if (key === '\u0003') { // Ctrl+C
                    console.log('\n\nStopping...');
                    process.exit(0);
                }
            };

            process.stdin.on('data', keyHandler);

            // Periodic raw mode restoration (every 2 seconds) to handle any disruptions
            this.rawModeGuardInterval = setInterval(() => {
                if (process.stdin.isTTY && !process.stdin.isRaw) {
                    console.log('⚠️ [System] Restoring raw mode for keyboard input...');
                    process.stdin.setRawMode(true);
                }
            }, 2000);
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
                // Ensure raw mode stays enabled (in case readline disrupted it)
                if (process.stdin.isTTY && !process.stdin.isRaw) {
                    process.stdin.setRawMode(true);
                }

                if (this.isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                    continue;
                }

                // Calculate elapsed time excluding paused time
                const elapsedTotal = Math.floor((Date.now() - startRunTime - this.totalPausedTime) / 1000);
                const aiStrategy = this.config.strategies.find(s => s.name === 'ai-relevance') as AIRelevanceStrategy | undefined;
                const usage = aiStrategy?.getTokenUsageSummary();
                const usageStr = usage ? ` | Tokens: ${usage.totalTokens} (${usage.totalInputTokens} in / ${usage.totalOutputTokens} out) | Cost: ${usage.cost}` : '';
                console.log(`\n=== Round ${round} (Elapsed: ${elapsedTotal}s${usageStr}) ===`);

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
                    // Manual mode: always use ai-relevance strategy
                    const aiStrategy = this.config.strategies.find(s => s.name === 'ai-relevance');
                    strategy = aiStrategy || this.config.strategies[0];
                    console.log(`\n[MANUAL] Using ${strategy.name}...`);
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
            // Clean up raw mode guard interval
            if (this.rawModeGuardInterval) {
                clearInterval(this.rawModeGuardInterval);
            }
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

    let url = 'https://serene-frangipane-7fd25b.netlify.app/';
    let headless = false;
    let auto = true;
    let usePatternFiltering = false;
    let logAICalls = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-u' || args[i] === '--url') {
            url = args[++i];
        } else if (args[i] === '--no-headless') {
            headless = false;
        } else if (args[i] === '--headless') {
            headless = true;
        } else if (args[i] === '--auto') {
            auto = true;
        } else if (args[i] === '--no-filter') {
            usePatternFiltering = false;
        } else if (args[i] === '--log-ai-calls') {
            logAICalls = true;
        }
    }

    if (!url) {
        console.log('Usage: npm start -- [-u <url>] [--headless] [--no-headless] [--auto] [--no-filter] [--log-ai-calls]');
        process.exit(1);
    }

    // Expose all available strategies for selection
    // Always enable debug mode to show visual overlays
    const debugMode = true;

    const runner = new Runner({
        targetUrl: url,
        headless,
        auto,
        strategies: [
            new AIRelevanceStrategy(200, debugMode, usePatternFiltering, logAICalls)
        ],
    });

    await runner.run();
}

main();
