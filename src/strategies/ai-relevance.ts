import { Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { Strategy, StrategyResult } from './base';
import { HierarchyScanStrategy } from './hierarchy-scan';
import { AIClient } from '../ai/client';
import { withZIndexPromotion } from '../utils/z-index-promotion';
import { ClickEverywhereStrategy } from './click-everywhere';
import { SmartButtonClickStrategy } from './smart-button-click';

export class AIRelevanceStrategy implements Strategy {
    name = 'ai-relevance';
    private hierarchyStrategy: HierarchyScanStrategy;
    private ai: AIClient;
    private ignoreList: Set<string> = new Set();
    private ignoreDetails: Map<string, any> = new Map();
    private roundsSinceNoiseClean = 0;
    private lastFingerprint: string | null = null;
    private lastUrl: string | null = null;
    private pastAttempts: string[] = [];
    private actionTimeout: number;
    private formBruteState: Map<string, Set<string>> = new Map();
    private debugMode: boolean;

    constructor(actionTimeout: number = 200, debugMode: boolean = false) {
        this.hierarchyStrategy = new HierarchyScanStrategy();
        this.ai = new AIClient();
        this.actionTimeout = actionTimeout;
        this.debugMode = debugMode;
    }

    setDebugMode(enabled: boolean): void {
        this.debugMode = enabled;
    }

    async execute(page: Page): Promise<StrategyResult> {
        const start = Date.now();

        // Check if URL changed - clear ignore list and past attempts on navigation
        const currentUrl = page.url();
        if (this.lastUrl && currentUrl !== this.lastUrl) {
            console.log(`🔄 [AI] URL changed (${this.lastUrl} → ${currentUrl}) - clearing ignore list and past attempts`);
            this.ignoreList.clear();
            this.ignoreDetails.clear();
            this.pastAttempts = []; // Clear past attempts on successful navigation
        }
        this.lastUrl = currentUrl;

        // Check if ignore list is getting too large and reset if needed
        if (this.ignoreList.size > 50) {
            console.log(`⚠️ [AI] Ignore list has ${this.ignoreList.size} elements - clearing to prevent over-filtering`);
            this.ignoreList.clear();
            this.ignoreDetails.clear();
            this.roundsSinceNoiseClean = 0; // Reset counter to avoid immediate re-filtering
        } else if (this.ignoreList.size > 0) {
            console.log(`[AI] Currently ignoring ${this.ignoreList.size} noise elements`);
        }

        // 1. Get simplified DOM
        console.log('[AI] Scanning DOM structure...');
        // We use the private helper from HierarchyScanStrategy by duplicating logic or exposing it.
        // Since it's private, I'll essentially reuse the shared concept or just update HierarchyScan to be importable.
        // For speed, I'll treat HierarchyScan as a helper if I can, or just duplicate the browser function.
        // Actually, let's just use the evaluate code from HierarchyScan.
        // BETTER: Let's refactor HierarchyScan to expose its buildHierarchy function string or logic.
        // For now, to avoid breaking changes, I'll copy the browser-side function which is robust.

        // Actually, I can just execute the hierarchy strategy and assume it might return data if I changed the interface.
        // But StrategyResult is limited.
        // I will implement the DOM build logic directly here to be safe and self-contained.

        const tree = await page.evaluate(this.buildHierarchy, Array.from(this.ignoreList));
        console.log(`[AI] DOM Tree built (${JSON.stringify(tree).length} chars). Sending to Groq...`);

        // Log the tree to a file for validation
        try {
            const logsDir = path.join(process.cwd(), 'logs');
            if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

            // Log recursive tree (compressed for AI reference)
            fs.writeFileSync(
                path.join(logsDir, 'dom_scan_latest.json'),
                JSON.stringify(tree, null, 2)
            );

            // Log flat important elements (uncompressed for humans)
            const importantList = this.flattenTree(tree).map(n => this.uncompressNode(n));
            fs.writeFileSync(
                path.join(logsDir, 'important_elements.json'),
                JSON.stringify(importantList, null, 2)
            );

            console.log('[AI] Logged survivors to logs/dom_scan_latest.json and logs/important_elements.json');
        } catch (err) {
            console.error('[AI] Failed to write log files:', err);
        }

        // 2. Send to AI (with background clicking)
        let pastAttemptsContext: string | undefined;
        if (this.pastAttempts.length > 0) {
            console.log(`\n🔄 [AI] FEEDBACK LOOP ACTIVE: Informing AI of ${this.pastAttempts.length} previously failed attempts:`);
            this.pastAttempts.forEach((attempt, i) => console.log(`   ${i + 1}. "${attempt}"`));

            // Detect repeated failures
            const failureAnalysis = this.analyzeFailurePatterns(this.pastAttempts);
            pastAttemptsContext = this.pastAttempts.join('\n');

            if (failureAnalysis.hasRepeatedFailures) {
                console.log(`   ⚠️ REPEATED FAILURES: ${failureAnalysis.repeatedCount} similar attempts detected`);

                // Give escalation hints when we have 6+ failures (automatic escalation at 8)
                if (failureAnalysis.repeatedCount >= 6) {
                    const escalationHint = `\n\n⚠️ REPEATED FAILURE DETECTED: ${failureAnalysis.repeatedCount} similar attempts have failed.` +
                        (failureAnalysis.repeatedCount >= 8
                            ? ` System will automatically clear popups next iteration. Consider:\n`
                            : ` Consider escalating:\n`) +
                        `- If overlays/popups might be blocking: Look for close buttons (×, "Close", etc.) to click, or press "Escape" key to dismiss them, then retry your action\n` +
                        `- If it's a modal form that reappears: Use "brute_force_form" action\n` +
                        `- Otherwise: Try a completely different approach`;
                    pastAttemptsContext += escalationHint;
                }
            }
        }
        console.log('[AI] Requesting analysis...');
        const analysis = await this.ai.analyzeDOM(tree, pastAttemptsContext);

        // Periodic Noise Reduction - runs every 2 rounds to filter out filler content
        this.roundsSinceNoiseClean++;
        if (this.roundsSinceNoiseClean >= 9999) {
            console.log('[AI] Periodically identifying noise in the background...');
            this.roundsSinceNoiseClean = 0;
            // Run in background without blocking current action execution
            this.ai.identifyNoise(tree).then(newNoiseIds => {
                if (newNoiseIds && newNoiseIds.length > 0) {
                    const flatTree = this.flattenTree(tree);

                    // Safety check: Don't filter if tree is already small
                    const currentTreeSize = flatTree.length;
                    if (currentTreeSize < 20) {
                        console.log(`⚠️ [AI] Tree only has ${currentTreeSize} elements - skipping noise reduction to prevent over-filtering`);
                        return;
                    }

                    // Safety check: Don't filter out critical elements
                    const criticalIds = ['ai-1', 'ai-2']; // body and root divs
                    const filteredNoiseIds = newNoiseIds.filter(id => !criticalIds.includes(id));

                    if (filteredNoiseIds.length === 0) {
                        return;
                    }

                    // Safety check: Calculate what would remain after filtering
                    const newNoiseIdsSet = new Set(filteredNoiseIds);
                    const wouldRemain = flatTree.filter(node => !newNoiseIdsSet.has(node.id) && !this.ignoreList.has(node.id));
                    const remainingCount = wouldRemain.length;

                    // Don't filter if it would leave too few elements
                    if (remainingCount < 30) {
                        console.log(`⚠️ [AI] Filtering would leave only ${remainingCount} elements - skipping to prevent over-filtering`);
                        return;
                    }

                    // Don't filter more than 70% of the current visible tree
                    const currentVisible = flatTree.filter(node => !this.ignoreList.has(node.id)).length;
                    const percentageToFilter = (filteredNoiseIds.length / currentVisible) * 100;
                    if (percentageToFilter > 70) {
                        console.log(`⚠️ [AI] Would filter ${percentageToFilter.toFixed(0)}% of visible tree - skipping to prevent over-filtering`);
                        return;
                    }

                    // Safety check: Ensure minimum interactive elements remain
                    const remainingInteractive = wouldRemain.filter(node => node.i === 1).length;
                    if (remainingInteractive < 3) {
                        console.log(`⚠️ [AI] Filtering would leave only ${remainingInteractive} interactive elements - skipping to prevent over-filtering`);
                        return;
                    }

                    let addedCount = 0;

                    filteredNoiseIds.forEach(id => {
                        if (!this.ignoreList.has(id)) {
                            this.ignoreList.add(id);
                            addedCount++;
                            // Capture full node data for logging
                            const node = flatTree.find(n => n.id === id);
                            if (node) {
                                this.ignoreDetails.set(id, this.uncompressNode(node));
                            } else {
                                this.ignoreDetails.set(id, { id, note: "Node not found in current tree" });
                            }
                        }
                    });

                    if (addedCount > 0) {
                        const totalList = Array.from(this.ignoreDetails.values());
                        console.log(`[AI] Added ${addedCount} elements to ignore list (${totalList.length} total).`);

                        // Log to file
                        const logDir = path.join(process.cwd(), 'logs');
                        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
                        fs.writeFileSync(
                            path.join(logDir, 'ignored_elements.json'),
                            JSON.stringify(totalList, null, 2)
                        );
                        console.log('[AI] Logged detailed ignored elements to logs/ignored_elements.json');
                    }
                }
            }).catch(err => {
                console.warn('[AI] Noise identification failed, skipping.', err.message);
            });
        }

        // 3. Log Results
        console.log(`\n[AI] Plan: ${analysis.planDescription || 'None'}`);
        console.log('\nSuggested Actions:');
        (analysis.actions || []).forEach((n: any, i: number) => {
            console.log(`  ${i + 1}. [${n.type.toUpperCase()}] ${n.description || ''}`);
        });

        // 4. Execute Actions Loop
        const actions = analysis.actions || [];
        if (actions.length > 0) {
            console.log(`\n🚀 QUEUEING ${actions.length} ACTIONS...`);
            const initialFingerprint = await this.getDOMFingerprint(page);
            const initialUrl = page.url(); // Track URL for single-page app navigation detection

            for (let i = 0; i < actions.length; i++) {
                const action = actions[i];


                try {
                    const resolvedSelector = action.selector ? this.resolveSelector(action.selector) : '';

                    if (action.type === 'click') {
                        await withZIndexPromotion(page, resolvedSelector, async () => {
                            await page.click(resolvedSelector, { timeout: this.actionTimeout, force: true });
                        }, { debugMode: this.debugMode });
                    } else if (action.type === 'input') {
                        console.log(`  ⌨️ Typing "${action.value}"...`);
                        await withZIndexPromotion(page, resolvedSelector, async () => {
                            await page.fill(resolvedSelector, action.value || '', { timeout: this.actionTimeout });
                        }, { debugMode: this.debugMode });
                    } else if (action.type === 'scroll') {
                        const amount = action.amount || 500;
                        const direction = action.direction === 'up' ? -amount : amount;
                        if (resolvedSelector) {
                            console.log(`  📜 Scrolling element "${resolvedSelector}"...`);
                            const locator = page.locator(resolvedSelector);
                            try {
                                await locator.scrollIntoViewIfNeeded({ timeout: this.actionTimeout });
                                await locator.evaluate((el, dist) => {
                                    el.scrollBy({ top: dist, behavior: 'smooth' });
                                }, direction);
                            } catch (e) {
                                // Fallback to global scroll if selector fails
                                await page.mouse.wheel(0, direction);
                            }
                        } else {
                            console.log(`  📜 Scrolling page ${action.direction || 'down'}...`);
                            await page.mouse.wheel(0, direction);
                        }
                    } else if (action.type === 'key') {
                        console.log(`  ⌨️ Pressing "${action.value}"...`);
                        await page.keyboard.press(action.value);
                    } else if (action.type === 'drag') {
                        console.log(`  鼠标 Dragging "${this.resolveSelector(action.source)}" to "${this.resolveSelector(action.target)}"...`);
                        const sourceSelector = this.resolveSelector(action.source);
                        const targetSelector = this.resolveSelector(action.target);

                        // Promote source element
                        await withZIndexPromotion(page, sourceSelector, async () => {
                            // Promote target element as well
                            await withZIndexPromotion(page, targetSelector, async () => {
                                const source = await page.locator(sourceSelector).boundingBox();
                                const target = await page.locator(targetSelector).boundingBox();
                                if (source && target) {
                                    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
                                    await page.mouse.down();
                                    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
                                    await page.mouse.up();
                                } else {
                                    throw new Error('Could not find bounding box for source or target');
                                }
                            }, { debugMode: this.debugMode });
                        }, { debugMode: this.debugMode });
                    } else if (action.type === 'draw') {
                        console.log(`  ✏️ Drawing on "${action.selector}" from (${action.startX}, ${action.startY}) to (${action.endX}, ${action.endY})...`);
                        const drawSelector = this.resolveSelector(action.selector);

                        // Promote canvas z-index and then draw
                        await withZIndexPromotion(page, drawSelector, async () => {
                            await page.mouse.move(action.startX, action.startY);
                            await page.mouse.down();
                            await page.mouse.move(action.endX, action.endY, { steps: 10 });
                            await page.mouse.up();
                        }, { debugMode: this.debugMode });
                    } else if (action.type === 'wait') {
                        console.log(`  ⏳ Waiting for ${action.ms}ms...`);
                        await page.waitForTimeout(action.ms);
                    } else if (action.type === 'hover') {
                        console.log(`  🖱️ Hovering over "${resolvedSelector}" for ${action.ms}ms...`);
                        await withZIndexPromotion(page, resolvedSelector, async () => {
                            await page.hover(resolvedSelector);
                            await page.waitForTimeout(action.ms);
                        }, { debugMode: this.debugMode });
                    } else if (action.type === 'clickEverywhere') {
                        console.log(`  🌐 FALLBACK: Click Everywhere Strategy`);
                        console.log(`     Reason: ${action.reason}`);
                        const clickEverywhereStrategy = new ClickEverywhereStrategy(0, this.debugMode);
                        await clickEverywhereStrategy.execute(page);
                    } else if (action.type === 'brute_force_form') {
                        const resolvedOptions = action.optionSelectors.map((s: string) => this.resolveSelector(s));
                        const resolvedSubmits = action.submitSelectors.map((s: string) => this.resolveSelector(s));

                        // Extract text content for all options and submits (for content-based tracking)
                        console.log(`[BruteForce] Extracting text content from form elements...`);
                        const optionTexts = await Promise.all(
                            resolvedOptions.map((s: string) => this.extractElementText(page, s))
                        );
                        const submitTexts = await Promise.all(
                            resolvedSubmits.map((s: string) => this.extractElementText(page, s))
                        );

                        // Form key based on CONTENT (survives shuffles), not IDs
                        const formKey = [...optionTexts, ...submitTexts].sort().join('|');
                        if (!this.formBruteState.has(formKey)) {
                            this.formBruteState.set(formKey, new Set());
                        }
                        const triedSet = this.formBruteState.get(formKey)! as Set<string>;

                        console.log(`\n[BruteForce] 🚀 Starting Content-Based Brute-Force Loop...`);
                        console.log(`   Form identified by content: ${optionTexts.length} options, ${submitTexts.length} submits`);

                        const initialUrl = page.url();
                        let totalCombinations = optionTexts.length * submitTexts.length;

                        while (true) {
                            // 1. Re-extract current selectors (handles shuffles where IDs change)
                            const currentOptions = await page.evaluate(() => {
                                return Array.from(document.querySelectorAll('[data-ai-id]'))
                                    .filter(el => el.getAttribute('role') === 'radio' ||
                                                  el.tagName.toLowerCase() === 'input' ||
                                                  (el.tagName.toLowerCase() === 'button' && el.getAttribute('role') === 'radio'))
                                    .map(el => `[data-ai-id="${el.getAttribute('data-ai-id')}"]`);
                            });

                            const currentSubmits = await page.evaluate(() => {
                                return Array.from(document.querySelectorAll('[data-ai-id]'))
                                    .filter(el => (el.tagName.toLowerCase() === 'button' &&
                                                  !el.getAttribute('role')) ||
                                                  el.getAttribute('type') === 'submit')
                                    .map(el => `[data-ai-id="${el.getAttribute('data-ai-id')}"]`);
                            });

                            if (currentOptions.length === 0 && currentSubmits.length === 0) {
                                console.log(`   ✨ Success! Form is no longer present. Brute-force complete.`);
                                break;
                            }

                            // 2. Build current text-to-selector mapping
                            const currentTextToSelector = new Map<string, string>();
                            for (const selector of [...currentOptions, ...currentSubmits]) {
                                const text = await this.extractElementText(page, selector);
                                if (text) currentTextToSelector.set(text, selector);
                            }

                            // 3. Find the FIRST text pair that hasn't been tried
                            let nextPair: { optText: string, subText: string } | null = null;
                            for (const subText of submitTexts) {
                                for (const optText of optionTexts) {
                                    const combinationKey = `${optText}|${subText}`;
                                    if (!triedSet.has(combinationKey)) {
                                        nextPair = { optText, subText };
                                        break;
                                    }
                                }
                                if (nextPair) break;
                            }

                            if (!nextPair) {
                                console.log(`   ⚠️ All ${totalCombinations} text combinations tried, but form remains. Exiting loop.`);
                                break;
                            }

                            // 4. Find current selectors for this text combination
                            const optSelector = currentTextToSelector.get(nextPair.optText);
                            const subSelector = currentTextToSelector.get(nextPair.subText);

                            if (!optSelector || !subSelector) {
                                console.log(`   ⚠️ Could not find selectors for "${nextPair.optText}" | "${nextPair.subText}". Skipping.`);
                                triedSet.add(`${nextPair.optText}|${nextPair.subText}`);
                                continue;
                            }

                            const optIndex = optionTexts.indexOf(nextPair.optText);
                            const subIndex = submitTexts.indexOf(nextPair.subText);

                            console.log(`   🧪 Combination ${triedSet.size + 1}/${totalCombinations}:`);
                            console.log(`     - [Option ${optIndex + 1}] "${nextPair.optText}"`);
                            console.log(`     - [Submit ${subIndex + 1}] "${nextPair.subText}"`);

                            triedSet.add(`${nextPair.optText}|${nextPair.subText}`);

                            try {
                                // Promote and click option
                                await withZIndexPromotion(page, optSelector, async () => {
                                    await page.click(optSelector, { timeout: this.actionTimeout, force: true });
                                }, { debugMode: this.debugMode });
                                await page.waitForTimeout(50);

                                // Promote and click submit
                                await withZIndexPromotion(page, subSelector, async () => {
                                    await page.click(subSelector, { timeout: this.actionTimeout, force: true });
                                }, { debugMode: this.debugMode });

                                // Small settle delay to let animations/DOM updates run
                                await page.waitForTimeout(300);
                            } catch (err: any) {
                                console.log(`     ❌ Click failed: ${err.message}`);
                            }
                        }
                    }
                    console.log('✅ Success');

                    // If there are more actions, wait a bit for the page to settle
                    // Removed: await page.waitForTimeout(600);
                } catch (err: any) {
                    console.log(`❌ Failed: ${err.message}`);
                    console.log('⚠️ Continuing queue despite failure...');
                }
            } // End of for loop

            // Post-Execution Feedback Loop: Run once after the entire queue is processed
            const finalFingerprint = await this.getDOMFingerprint(page);
            const finalUrl = page.url();

            const removedIds = [...initialFingerprint].filter(id => !finalFingerprint.has(id));
            const addedIds = [...finalFingerprint].filter(id => !initialFingerprint.has(id));

            // Consider it a success if DOM changed OR URL changed (including hash changes for SPAs)
            const urlChanged = initialUrl !== finalUrl;
            const hasChange = removedIds.length > 0 || addedIds.length > 0 || urlChanged;

            if (hasChange) {
                console.log(`\n✨ [AI] Progress detected:`);
                if (urlChanged) console.log(`   - URL Changed: ${initialUrl} → ${finalUrl}`);
                if (removedIds.length > 0) console.log(`   - Removed Elements: ${removedIds.slice(0, 5).join(', ')}${removedIds.length > 5 ? ` (+${removedIds.length - 5} more)` : ''}`);
                if (addedIds.length > 0) console.log(`   - Added Elements: ${addedIds.slice(0, 5).join(', ')}${addedIds.length > 5 ? ` (+${addedIds.length - 5} more)` : ''}`);

                // Persistence Guard: If we were brute-forcing, checking if the form is still there
                const bruteActions = actions.filter((a: any) => a.type === 'brute_force_form');
                const formStillExists = bruteActions.some((a: any) => {
                    // Check both option selectors AND submit selectors
                    const allSelectors = [
                        ...(a.optionSelectors || []).map((s: string) => this.resolveSelector(s)),
                        ...(a.submitSelectors || []).map((s: string) => this.resolveSelector(s))
                    ];
                    // Check if any of the selectors match an ID that still exists in the final fingerprint
                    return allSelectors.some((sel: string) => {
                        const match = sel.match(/\[data-ai-id="(.+?)"\]/);
                        return match && finalFingerprint.has(match[1]);
                    });
                });

                if (formStillExists) {
                    console.log('⚠️ [BruteForce] Form elements still visible. Keeping attempt history to ensure persistence.');
                    this.pastAttempts = actions.map((a: any) => {
                        let details = `[${a.type}] ${a.description}`;
                        if (a.selector) details += ` (Target: ${a.selector})`;
                        if (a.value) details += ` (Value: ${a.value})`;
                        if (a.optionSelectors) details += ` (Options: ${a.optionSelectors.join(', ')})`;
                        if (a.type === 'draw') details += ` (From: ${a.startX},${a.startY} To: ${a.endX},${a.endY})`;
                        return details;
                    });
                } else {
                    console.log('✨ [AI] Progress confirmed. Clearing past attempts.');
                    this.pastAttempts = [];
                }
            } else {
                console.log('⚠️ [AI] No progress detected after action queue (no DOM changes or URL changes).');

                // Build past attempts details
                this.pastAttempts = actions.map((a: any) => {
                    let details = `[${a.type}] ${a.description}`;
                    if (a.selector) details += ` (Target: ${a.selector})`;
                    if (a.value) details += ` (Value: ${a.value})`;
                    if (a.optionSelectors) details += ` (Options: ${a.optionSelectors.join(', ')})`;
                    if (a.type === 'draw') details += ` (From: ${a.startX},${a.startY} To: ${a.endX},${a.endY})`;
                    return details;
                });

                // AUTOMATIC ESCALATION: If we have 8+ failures, clear popups/modals automatically
                const failureAnalysis = this.analyzeFailurePatterns(this.pastAttempts);
                if (failureAnalysis.hasRepeatedFailures && failureAnalysis.repeatedCount >= 8) {
                    console.log(`\n🔥 [ESCALATION] Detected ${failureAnalysis.repeatedCount} repeated failures. Automatically clearing popups/modals...`);

                    // Use SmartButtonClickStrategy to clear popups (clicks high z-index elements)
                    const smartClickStrategy = new SmartButtonClickStrategy(this.debugMode);
                    await smartClickStrategy.execute(page);

                    console.log('✅ [ESCALATION] Popup clearing complete. AI will analyze the new state in next iteration.');
                }
            }
        } else {
            console.log('\n⚠️ No actions returned by AI');
        }

        const timeMs = Date.now() - start;
        return {
            success: true,
            message: `Executed AI action in ${timeMs}ms`,
            timeMs
        };
    }

    private resolveSelector(selector: string): string {
        if (!selector) return selector;
        // If AI returns #ai-123 or #temp-123, convert to [data-ai-id="..."]
        if (selector.startsWith('#') && (selector.startsWith('#ai-') || selector.startsWith('#temp-'))) {
            const id = selector.substring(1);
            return `[data-ai-id="${id}"]`;
        }
        return selector;
    }

    private analyzeFailurePatterns(pastAttempts: string[]): { hasRepeatedFailures: boolean; repeatedCount: number } {
        if (pastAttempts.length < 2) {
            return { hasRepeatedFailures: false, repeatedCount: 0 };
        }

        // Extract action types and selectors from past attempts
        const attempts = pastAttempts.map(attempt => {
            const typeMatch = attempt.match(/\[(\w+)\]/);
            const targetMatch = attempt.match(/Target:\s*([^\)]+)/);
            const optionsMatch = attempt.match(/Options:\s*([^\)]+)/);

            return {
                type: typeMatch ? typeMatch[1] : '',
                target: targetMatch ? targetMatch[1].trim() : '',
                options: optionsMatch ? optionsMatch[1].trim() : ''
            };
        });

        // Count similar attempts (same type and similar target/options)
        const attemptSignatures = new Map<string, number>();

        for (const attempt of attempts) {
            // Create a signature based on action type and target
            let signature = attempt.type;
            if (attempt.target) {
                // Extract just the selector pattern (e.g., #ai-123 -> #ai-*)
                const selectorPattern = attempt.target.replace(/#ai-\d+/g, '#ai-*').replace(/#temp-\d+/g, '#temp-*');
                signature += `|${selectorPattern}`;
            }
            if (attempt.options) {
                signature += `|options`;
            }

            attemptSignatures.set(signature, (attemptSignatures.get(signature) || 0) + 1);
        }

        // Check if any signature appears 2+ times
        const maxRepeats = Math.max(...Array.from(attemptSignatures.values()));

        return {
            hasRepeatedFailures: maxRepeats >= 2,
            repeatedCount: maxRepeats
        };
    }

    private compareFingerprints(a: Set<string>, b: Set<string>): boolean {
        if (a.size !== b.size) return false;
        for (const id of a) {
            if (!b.has(id)) return false;
        }
        return true;
    }

    private async getDOMFingerprint(page: Page): Promise<Set<string>> {
        const ids = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('[data-ai-id]'))
                .map(el => el.getAttribute('data-ai-id') || '')
                .filter(id => id !== '');
        });
        return new Set(ids);
    }

    private async extractElementText(page: Page, selector: string): Promise<string> {
        // Extract text content from an element using multiple strategies
        return await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return '';

            // Strategy 1: Check value attribute (radio buttons, inputs)
            const value = el.getAttribute('value');
            if (value && value.trim()) return value.trim();

            // Strategy 2: Check for associated label (by ID reference)
            const id = el.id || el.getAttribute('id');
            if (id) {
                const label = document.querySelector(`label[for="${id}"]`);
                if (label && label.textContent) return label.textContent.trim();
            }

            // Strategy 3: Check aria-label
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

            // Strategy 4: Direct text content (excluding children)
            let text = '';
            for (const node of Array.from(el.childNodes)) {
                if (node.nodeType === Node.TEXT_NODE) {
                    text += node.textContent;
                }
            }
            if (text.trim()) return text.trim();

            // Strategy 5: All text content (including children)
            return (el.textContent || '').trim();
        }, selector);
    }

    private async checkFormStillExists(page: Page, optionSelectors: string[], submitSelectors: string[], initialUrl: string): Promise<boolean> {
        // Multi-strategy check to determine if the form truly still exists

        // Strategy 1: Check if URL changed (successful navigation is a strong signal)
        const currentUrl = page.url();
        if (currentUrl !== initialUrl) {
            console.log(`   📍 URL changed: ${initialUrl} → ${currentUrl}`);
            return false; // Form is gone, we navigated away
        }

        // Strategy 2: Check if the exact selectors still exist
        const exactSelectorsExist = await page.evaluate((selectors) => {
            return selectors.some(s => document.querySelector(s) !== null);
        }, [...optionSelectors, ...submitSelectors]);

        if (!exactSelectorsExist) {
            // Selectors are gone, but need to verify it's not just new IDs on same form

            // Strategy 3: Check for similar form structure (buttons, inputs, etc.)
            const formStructure = await page.evaluate(() => {
                const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]');
                const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
                const clickableElements = document.querySelectorAll('[onclick], [data-ai-id][style*="cursor: pointer"], [style*="cursor:pointer"]');

                return {
                    buttonCount: buttons.length,
                    inputCount: inputs.length,
                    clickableCount: clickableElements.length,
                    totalInteractive: buttons.length + inputs.length
                };
            });

            // If there are still many interactive elements, the form likely still exists with new IDs
            if (formStructure.totalInteractive > 3) {
                console.log(`   🔄 Selectors gone but ${formStructure.totalInteractive} interactive elements remain (likely new IDs)`);
                return true; // Form still exists, just with new IDs
            }

            console.log(`   ✨ Selectors gone and only ${formStructure.totalInteractive} interactive elements remain`);
            return false; // Form is truly gone
        }

        // Strategy 4: If exact selectors still exist, form definitely still exists
        return true;
    }

    private uncompressNode(node: any): any {
        const { ch, ...meta } = node;
        const mapping: any = {
            t: 'tag',
            id: 'id',
            i: 'interactive',
            z: 'layerZ',
            v: 'visibility',
            s: 'position',
            c: 'cursor',
            x: 'text',
            p: 'placeholder',
            val: 'value',
            bbox: 'boundingBox'
        };

        const result: any = {};
        for (const key in meta) {
            const readableKey = mapping[key] || key;
            result[readableKey] = meta[key];
        }
        return result;
    }

    private flattenTree(nodes: any[]): any[] {
        let result: any[] = [];
        for (const node of nodes) {
            result.push(node);
            if (node.ch) {
                result = result.concat(this.flattenTree(node.ch));
            }
        }
        return result;
    }

    // Copied from HierarchyScanStrategy for stability
    private buildHierarchy(ignoreList: string[]): any[] {
        const ignoreSet = new Set(ignoreList);
        const isInteresting = (el: HTMLElement): boolean => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;

            // Include fixed overlays/backdrops
            if (style.position === 'fixed' && parseFloat(style.width) > window.innerWidth * 0.5 && parseFloat(style.height) > window.innerHeight * 0.5) return true;

            if (el.innerText && el.innerText.trim().length > 0) return true;
            if (['input', 'button', 'select', 'textarea', 'img', 'canvas'].includes(el.tagName.toLowerCase())) return true;
            if (style.cursor === 'pointer') return true;
            return false;
        };

        const isInteractive = (el: HTMLElement): boolean => {
            return ['button', 'a', 'input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) ||
                el.hasAttribute('onclick') ||
                el.getAttribute('role') === 'button';
        };

        // Persistent ID stability on same page
        if (!(window as any).__ai_id_counter) {
            (window as any).__ai_id_counter = 0;
        }

        const processNode = (el: HTMLElement): any | null => {
            const aiIdAttr = el.getAttribute('data-ai-id');
            if (aiIdAttr && ignoreSet.has(aiIdAttr)) return null;

            if (!isInteresting(el)) return null;

            // Assign unique ID for AI targeting (Stable on same-page)
            let aiId = el.getAttribute('data-ai-id');
            if (!aiId) {
                aiId = `ai-${++(window as any).__ai_id_counter}`;
                el.setAttribute('data-ai-id', aiId);
            }

            const style = window.getComputedStyle(el);
            const interactive = isInteractive(el);

            let layerZ = 0;
            let current: HTMLElement | null = el;
            while (current && current !== document.documentElement) {
                const s = window.getComputedStyle(current);
                if (s.position !== 'static' && s.zIndex !== 'auto') {
                    layerZ = parseInt(s.zIndex);
                }
                current = current.parentElement;
            }

            let onTop = true;
            if (interactive) {
                const rect = el.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                if (x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight) {
                    const topEl = document.elementFromPoint(x, y);
                    if (topEl) {
                        onTop = el.contains(topEl) || topEl.contains(el);
                    }
                }
            }

            // --- Aggressive Compression ---
            const node: any = {
                t: el.tagName.toLowerCase(),
                id: aiId
            };

            if (interactive) node.i = 1;
            if (layerZ !== 0) node.z = layerZ;
            if (!onTop) node.v = 0; // v = visibility/onTop. Default is 1.
            if (style.position !== 'static') node.s = style.position;
            if (style.cursor !== 'auto') node.c = style.cursor;

            let text = '';
            for (const child of Array.from(el.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE) text += child.textContent + ' ';
            }
            text = text.trim();
            if (text) node.x = text; // x = text content

            if (el.tagName === 'INPUT') {
                const input = el as HTMLInputElement;
                if (input.placeholder) node.p = input.placeholder;
                if (input.value) node.val = input.value;
                if (input.value || input.placeholder) node.x = input.value || input.placeholder;
            }

            // Add bounding box for canvas elements (needed for draw actions)
            if (el.tagName === 'CANVAS') {
                const rect = el.getBoundingClientRect();
                node.bbox = {
                    x: Math.round(rect.left),
                    y: Math.round(rect.top),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height)
                };
            }

            const children: any[] = [];
            for (const child of Array.from(el.children)) {
                const processed = processNode(child as HTMLElement);
                if (processed) children.push(processed);
            }

            if (!node.i && !node.x && children.length === 1 && !el.id) {
                return children[0];
            }

            if (children.length > 0) node.ch = children; // ch = children
            return node;
        };

        const root = processNode(document.body);
        return root ? [root] : [];
    }
}
