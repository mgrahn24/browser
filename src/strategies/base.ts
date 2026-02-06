import { Page } from 'playwright';

/**
 * Result of a strategy execution
 */
export interface StrategyResult {
    success: boolean;
    message: string;
    timeMs: number;
}

/**
 * Base interface for strategies
 */
export interface Strategy {
    name: string;
    execute(page: Page): Promise<StrategyResult>;
}
