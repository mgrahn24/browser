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
    private noisePatterns: Array<{tag: string; contentPattern?: string; reason: string; regex?: RegExp; exactMatch?: string}> = [];
    private roundCounter = 0;
    private roundsSinceNoiseClean = 0;
    private lastFingerprint: string | null = null;
    private lastUrl: string | null = null;
    private pastAttempts: string[] = [];
    private lastChanges: any = null; // Store last DOM changes for AI feedback
    private actionTimeout: number;
    private formBruteState: Map<string, Set<string>> = new Map();
    private debugMode: boolean;
    private usePatternFiltering: boolean;
    private logAICalls: boolean;
    private autoMode: boolean = false;

    constructor(actionTimeout: number = 200, debugMode: boolean = false, usePatternFiltering: boolean = true, logAICalls: boolean = false) {
        this.hierarchyStrategy = new HierarchyScanStrategy();
        this.ai = new AIClient(logAICalls);
        this.actionTimeout = actionTimeout;
        this.debugMode = debugMode;
        this.usePatternFiltering = usePatternFiltering;
        this.logAICalls = logAICalls;
        console.log(`[AI] Pattern filtering: ${usePatternFiltering ? 'ENABLED' : 'DISABLED'}`);
        console.log(`[AI] Call logging: ${logAICalls ? 'ENABLED' : 'DISABLED'}`);
    }

    setDebugMode(enabled: boolean): void {
        this.debugMode = enabled;
    }

    setAutoMode(enabled: boolean): void {
        this.autoMode = enabled;
    }

    getTokenUsageSummary() {
        return this.ai.getTokenUsageSummary();
    }

    async execute(page: Page): Promise<StrategyResult> {
        const start = Date.now();
        this.roundCounter++; // Increment round counter

        // Check if URL changed - clear ignore list, past attempts, and patterns on navigation
        const currentUrl = page.url();
        if (this.lastUrl && currentUrl !== this.lastUrl) {
            console.log(`🔄 [AI] URL changed (${this.lastUrl} → ${currentUrl}) - clearing ignore list, patterns, past attempts, and changes`);
            this.ignoreList.clear();
            this.ignoreDetails.clear();
            this.noisePatterns = []; // Clear patterns on navigation
            this.roundCounter = 1; // Reset round counter
            this.pastAttempts = []; // Clear past attempts on successful navigation
            this.lastChanges = null; // Clear change history on new page
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

        const patternsToSend = this.usePatternFiltering
            ? this.noisePatterns.map(p => ({
                tag: p.tag,
                contentPattern: p.contentPattern,
                exactMatch: p.exactMatch
            }))
            : [];
        console.log(`[AI] Building DOM tree with ${this.ignoreList.size} ignored IDs and ${patternsToSend.length} noise patterns...`);
        if (patternsToSend.length > 0) {
            console.log(`[AI] Patterns being applied: ${JSON.stringify(patternsToSend, null, 2)}`);
        }

        const result = await page.evaluate(this.buildHierarchy, {
            ignoreList: Array.from(this.ignoreList),
            noisePatterns: patternsToSend
        });
        let tree = result.tree;
        const filterStats = result.stats;

        console.log(`[AI] DOM Tree built (${JSON.stringify(tree).length} chars). Filtered: ${filterStats.filteredByIgnoreList} by ignore list, ${filterStats.filteredByPattern} by patterns`);
        if (filterStats.patternMatches.length > 0) {
            console.log(`[AI] Pattern match examples:`);
            filterStats.patternMatches.forEach((match: any) => {
                console.log(`   ✓ <${match.tag}> "${match.text}" matched /${match.pattern}/`);
            });
        }
        if (filterStats.nearMisses && filterStats.nearMisses.length > 0) {
            console.log(`[AI] ⚠️ Near-miss patterns (tag matched but text didn't):`);
            filterStats.nearMisses.forEach((miss: any) => {
                console.log(`   ✗ <${miss.tag}> "${miss.text}" did NOT match /${miss.pattern}/`);
            });
        }
        console.log(`[AI] Sending to Groq...`);

        // Log the tree to a file for validation
        if (this.logAICalls) {
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
        }

        // Pattern-based noise reduction (first on round 3, then every 20 rounds)
        if (this.usePatternFiltering && (this.roundCounter === 3 || (this.roundCounter > 3 && (this.roundCounter - 3) % 20 === 0))) {
            console.log(`[AI] Round ${this.roundCounter}: Identifying noise patterns to reduce token usage...`);

            // Extract text examples to help AI create accurate patterns
            const flatTree = this.flattenTree(tree);
            const textExamples = flatTree
                .filter(node => node.x && !node.i) // Non-interactive text elements
                .map(node => ({ tag: node.t, text: node.x }))
                .slice(0, 50); // Send up to 50 examples

            const patterns = await this.ai.identifyNoisePatterns(tree, textExamples);

            if (patterns && patterns.length > 0) {
                // Add new patterns (avoiding duplicates)
                let addedCount = 0;
                for (const pattern of patterns) {
                    const exists = this.noisePatterns.some(p =>
                        p.tag === pattern.tag &&
                        (p.contentPattern === pattern.contentPattern || p.exactMatch === pattern.exactMatch)
                    );
                    if (!exists) {
                        // Check if this is an exact match or regex pattern
                        if (pattern.exactMatch) {
                            // Exact text match
                            this.noisePatterns.push({ ...pattern, exactMatch: pattern.exactMatch });
                            addedCount++;
                            console.log(`   ✓ Exact Match: <${pattern.tag}> text="${pattern.exactMatch.substring(0, 60)}..." - ${pattern.reason}`);
                        } else if (pattern.contentPattern) {
                            // Regex pattern
                            try {
                                const regex = new RegExp(pattern.contentPattern);

                                // Validate against actual DOM content (informational only)
                                const flatTree = this.flattenTree(tree);
                                const matchingElements = flatTree.filter(node =>
                                    node.t === pattern.tag.toLowerCase() && node.x
                                );
                                const matchCount = matchingElements.filter(node =>
                                    regex.test(node.x)
                                ).length;

                                this.noisePatterns.push({ ...pattern, regex });
                                addedCount++;
                                console.log(`   ✓ Pattern: <${pattern.tag}> /${pattern.contentPattern}/ (${matchCount} matches) - ${pattern.reason}`);

                                if (matchCount === 0 && matchingElements.length > 0) {
                                    // Pattern doesn't match anything - log examples for debugging
                                    const examples = matchingElements.slice(0, 2).map(n => `"${n.x.substring(0, 50)}"`);
                                    console.log(`     ⚠️ Pattern matches 0 elements. Examples in DOM: ${examples.join(', ')}`);
                                }
                            } catch (e) {
                                console.warn(`   ✗ Invalid regex pattern: ${pattern.contentPattern}`);
                            }
                        } else {
                            console.warn(`   ✗ Pattern has neither exactMatch nor contentPattern: ${JSON.stringify(pattern)}`);
                        }
                    }
                }
                console.log(`[AI] Added ${addedCount} new noise patterns (${this.noisePatterns.length} total)`);

                // Rebuild the tree with newly identified patterns so they're applied immediately
                if (addedCount > 0) {
                    console.log('[AI] Rebuilding DOM tree with newly identified patterns...');
                    const patternsToSend = this.noisePatterns.map(p => ({
                        tag: p.tag,
                        contentPattern: p.contentPattern,
                        exactMatch: p.exactMatch
                    }));
                    const result = await page.evaluate(this.buildHierarchy, {
                        ignoreList: Array.from(this.ignoreList),
                        noisePatterns: patternsToSend
                    });
                    tree = result.tree;
                    const filterStats = result.stats;

                    console.log(`[AI] Rebuilt DOM Tree (${JSON.stringify(tree).length} chars). Filtered: ${filterStats.filteredByIgnoreList} by ignore list, ${filterStats.filteredByPattern} by patterns`);
                    if (filterStats.patternMatches.length > 0) {
                        console.log(`[AI] Pattern match examples:`);
                        filterStats.patternMatches.forEach((match: any) => {
                            console.log(`   ✓ <${match.tag}> "${match.text}" matched /${match.pattern}/`);
                        });
                    }
                    if (filterStats.nearMisses && filterStats.nearMisses.length > 0) {
                        console.log(`[AI] ⚠️ Near-miss patterns (tag matched but text didn't):`);
                        filterStats.nearMisses.forEach((miss: any) => {
                            console.log(`   ✗ <${miss.tag}> "${miss.text}" did NOT match /${miss.pattern}/`);
                        });
                    }
                }
            } else {
                console.log('[AI] No new noise patterns identified');
            }
        } else if (this.usePatternFiltering && this.noisePatterns.length > 0) {
            console.log(`[AI] Using ${this.noisePatterns.length} noise patterns to filter DOM`);
        }

        // 2. Send to AI (with background clicking)
        let pastAttemptsContext: string | undefined;
        if (this.pastAttempts.length > 0 || this.lastChanges) {
            if (this.pastAttempts.length > 0) {
                console.log(`\n🔄 [AI] FEEDBACK LOOP ACTIVE: Informing AI of ${this.pastAttempts.length} previously failed attempts:`);
                this.pastAttempts.forEach((attempt, i) => console.log(`   ${i + 1}. "${attempt}"`));

                // Detect repeated failures
                const failureAnalysis = this.analyzeFailurePatterns(this.pastAttempts);
                pastAttemptsContext = this.pastAttempts.join('\n');

                // if (failureAnalysis.hasRepeatedFailures) {
                //     console.log(`   ⚠️ REPEATED FAILURES: ${failureAnalysis.repeatedCount} similar attempts detected`);

                //     // Give escalation hints when we have 6+ failures (automatic escalation at 8)
                //     if (failureAnalysis.repeatedCount >= 6) {
                //         const escalationHint = `\n\n⚠️ REPEATED FAILURE DETECTED: ${failureAnalysis.repeatedCount} similar attempts have failed.` +
                //             (failureAnalysis.repeatedCount >= 8
                //                 ? ` System will automatically clear popups next iteration. Consider:\n`
                //                 : ` Consider escalating:\n`) +
                //             `- If overlays/popups might be blocking: Look for close buttons (×, "Close", etc.) to click, or press "Escape" key to dismiss them, then retry your action\n` +
                //             `- If it's a modal form that reappears: Use "brute_force_form" action\n` +
                //             `- Otherwise: Try a completely different approach`;
                //         pastAttemptsContext += escalationHint;
                //     }
                // }
            }

            // Include last detected changes as feedback
            if (this.lastChanges && this.lastChanges.hasChanges) {
                const changesSummary = this.buildChangesSummary(this.lastChanges);
                if (changesSummary) {
                    if (!pastAttemptsContext) pastAttemptsContext = '';
                    if (pastAttemptsContext) pastAttemptsContext += '\n\n';
                    pastAttemptsContext += `📊 LAST ACTION RESULTS:\n${changesSummary}`;
                    console.log(`\n📊 [AI] Including feedback about last action's DOM changes`);
                }
            }
        }
        let analysis: any;

        console.log('[AI] Requesting analysis...');
        analysis = await this.ai.analyzeDOM(tree, pastAttemptsContext);

        // 3. Log Results
        console.log(`\n[AI] Plan: ${analysis.planDescription || 'None'}`);
        console.log('\nSuggested Actions:');
        (analysis.actions || []).forEach((n: any, i: number) => {
            console.log(`  ${i + 1}. [${n.type.toUpperCase()}] ${n.description || ''}`);
        });

        // 4. Execute Actions Loop
        const actions = analysis.actions || [];
        // Track action results for logging
        const actionResults: Array<{action: any; success: boolean; error?: string}> = [];

        if (actions.length > 0) {
            console.log(`\n🚀 QUEUEING ${actions.length} ACTIONS...`);
            const initialFingerprint = await this.getDOMFingerprint(page);
            const initialSnapshot = await this.getDOMSnapshot(page);
            const initialUrl = page.url(); // Track URL for single-page app navigation detection

            for (let i = 0; i < actions.length; i++) {
                const action = actions[i];


                try {
                    const resolvedSelector = action.selector ? this.resolveSelector(action.selector) : '';

                    if (action.type === 'click') {
                        await withZIndexPromotion(page, resolvedSelector, async () => {
                            await page.click(resolvedSelector, { timeout: this.actionTimeout, force: true });
                        }, { showOverlay: true, waitForUser: !this.autoMode });
                    } else if (action.type === 'input') {
                        console.log(`  ⌨️ Typing "${action.value}"...`);
                        await withZIndexPromotion(page, resolvedSelector, async () => {
                            await page.fill(resolvedSelector, action.value || '', { timeout: this.actionTimeout });
                        }, { showOverlay: true, waitForUser: !this.autoMode });
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
                        console.log(` Dragging "${this.resolveSelector(action.source)}" to "${this.resolveSelector(action.target)}"...`);
                        const sourceSelector = this.resolveSelector(action.source);
                        const targetSelector = this.resolveSelector(action.target);

                        // Promote source element
                        await withZIndexPromotion(page, sourceSelector, async () => {
                            // Promote target element as well
                            await withZIndexPromotion(page, targetSelector, async () => {
                                // Extended delay for drag actions to ensure z-index promotion fully takes effect
                                // This prevents the first drag from failing due to incomplete promotion
                                await page.waitForTimeout(1000);
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
                            }, { showOverlay: true, waitForUser: !this.autoMode });
                        }, { showOverlay: true, waitForUser: !this.autoMode });
                    } else if (action.type === 'draw') {
                        console.log(`  ✏️ Drawing on "${action.selector}" from (${action.startX}, ${action.startY}) to (${action.endX}, ${action.endY})...`);
                        const drawSelector = this.resolveSelector(action.selector);

                        // Promote canvas z-index and then draw
                        await withZIndexPromotion(page, drawSelector, async () => {
                            // Scroll element into view first to ensure accurate bounding box
                            const locator = page.locator(drawSelector);
                            await locator.scrollIntoViewIfNeeded({ timeout: this.actionTimeout });

                            // Longer delay for draw actions to ensure z-index promotion and scroll complete
                            await page.waitForTimeout(500);

                            // Get current bounding box to handle page scroll correctly
                            const bbox = await locator.boundingBox();
                            if (!bbox) {
                                throw new Error('Could not find bounding box for draw element');
                            }

                            // Coordinates from AI are relative to element's top-left corner
                            // Convert to absolute viewport coordinates
                            const absStartX = bbox.x + action.startX;
                            const absStartY = bbox.y + action.startY;
                            const absEndX = bbox.x + action.endX;
                            const absEndY = bbox.y + action.endY;

                            await page.mouse.move(absStartX, absStartY);
                            await page.mouse.down();
                            await page.mouse.move(absEndX, absEndY, { steps: 10 });
                            await page.mouse.up();
                        }, { showOverlay: true, waitForUser: !this.autoMode });
                    } else if (action.type === 'wait') {
                        console.log(`  ⏳ Waiting for ${action.ms}ms...`);
                        await page.waitForTimeout(action.ms);
                    } else if (action.type === 'hover') {
                        console.log(`  🖱️ Hovering over "${resolvedSelector}" for ${action.ms}ms...`);
                        await withZIndexPromotion(page, resolvedSelector, async () => {
                            await page.hover(resolvedSelector);
                            await page.waitForTimeout(action.ms);
                        }, { showOverlay: true, waitForUser: !this.autoMode });
                    } else if (action.type === 'clickEverywhere') {
                        console.log(`  🌐 FALLBACK: Click Everywhere Strategy`);
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
                                }, { showOverlay: true, waitForUser: !this.autoMode });
                                await page.waitForTimeout(50);

                                // Promote and click submit
                                await withZIndexPromotion(page, subSelector, async () => {
                                    await page.click(subSelector, { timeout: this.actionTimeout, force: true });
                                }, { showOverlay: true, waitForUser: !this.autoMode });

                                // Small settle delay to let animations/DOM updates run
                                await page.waitForTimeout(300);
                            } catch (err: any) {
                                console.log(`     ❌ Click failed: ${err.message}`);
                            }
                        }
                    }
                    console.log('✅ Success');
                    actionResults.push({ action, success: true });

                    // If there are more actions, wait a bit for the page to settle
                    // Removed: await page.waitForTimeout(600);
                } catch (err: any) {
                    console.log(`❌ Failed: ${err.message}`);
                    console.log('⚠️ Continuing queue despite failure...');
                    actionResults.push({ action, success: false, error: err.message });
                }
            } // End of for loop

            // Post-Execution Feedback Loop: Run once after the entire queue is processed
            const finalFingerprint = await this.getDOMFingerprint(page);
            const finalSnapshot = await this.getDOMSnapshot(page);
            const finalUrl = page.url();

            const removedIds = [...initialFingerprint].filter(id => !finalFingerprint.has(id));
            const addedIds = [...finalFingerprint].filter(id => !initialFingerprint.has(id));

            // Compare detailed snapshots
            const changes = this.compareDOMSnapshots(initialSnapshot, finalSnapshot);

            // Store changes for next AI prompt
            this.lastChanges = {
                ...changes,
                urlChanged: initialUrl !== finalUrl ? { from: initialUrl, to: finalUrl } : null
            };

            // Consider it a success if DOM changed OR URL changed (including hash changes for SPAs)
            const urlChanged = initialUrl !== finalUrl;
            const hasChange = removedIds.length > 0 || addedIds.length > 0 || urlChanged || changes.hasChanges;

            if (hasChange) {
                console.log(`\n✨ [AI] Progress detected:`);
                if (urlChanged) console.log(`   - URL Changed: ${initialUrl} → ${finalUrl}`);
                if (removedIds.length > 0) console.log(`   - Removed Elements: ${removedIds.slice(0, 5).join(', ')}${removedIds.length > 5 ? ` (+${removedIds.length - 5} more)` : ''}`);
                if (addedIds.length > 0) console.log(`   - Added Elements: ${addedIds.slice(0, 5).join(', ')}${addedIds.length > 5 ? ` (+${addedIds.length - 5} more)` : ''}`);

                // Log detailed changes
                if (changes.textChanged.length > 0) {
                    console.log(`   - Text Changed (${changes.textChanged.length} elements):`);
                    changes.textChanged.slice(0, 3).forEach((change: any) => {
                        console.log(`     • ${change.id}: "${change.before}" → "${change.after}"`);
                    });
                    if (changes.textChanged.length > 3) console.log(`     ... and ${changes.textChanged.length - 3} more`);
                }

                if (changes.valueChanged.length > 0) {
                    console.log(`   - Values Changed (${changes.valueChanged.length} elements):`);
                    changes.valueChanged.slice(0, 3).forEach((change: any) => {
                        console.log(`     • ${change.id} <${change.tag}>: "${change.before}" → "${change.after}"`);
                    });
                    if (changes.valueChanged.length > 3) console.log(`     ... and ${changes.valueChanged.length - 3} more`);
                }

                if (changes.checkedChanged.length > 0) {
                    console.log(`   - Checked State Changed (${changes.checkedChanged.length} elements):`);
                    changes.checkedChanged.slice(0, 3).forEach((change: any) => {
                        console.log(`     • ${change.id}: ${change.before} → ${change.after}`);
                    });
                    if (changes.checkedChanged.length > 3) console.log(`     ... and ${changes.checkedChanged.length - 3} more`);
                }

                // Log changes to file
                if (this.logAICalls) {
                    try {
                        const fs = await import('fs');
                        const path = await import('path');
                        const logsDir = path.join(process.cwd(), 'logs');
                        if (!fs.existsSync(logsDir)) {
                            fs.mkdirSync(logsDir, { recursive: true });
                        }

                        const changeLog = {
                            timestamp: new Date().toISOString(),
                            round: this.roundCounter,
                            urlChanged: urlChanged ? { from: initialUrl, to: finalUrl } : null,
                            structuralChanges: {
                                removed: removedIds,
                                added: addedIds
                            },
                            contentChanges: {
                                textChanged: changes.textChanged,
                                valueChanged: changes.valueChanged,
                                checkedChanged: changes.checkedChanged
                            },
                            actions: actions
                        };

                        fs.writeFileSync(
                            path.join(logsDir, 'dom_changes_latest.json'),
                            JSON.stringify(changeLog, null, 2)
                        );
                        console.log('   📝 Detailed changes logged to logs/dom_changes_latest.json');
                    } catch (err) {
                        console.error('   ⚠️ Failed to write change log:', err);
                    }
                }

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
                    const newAttempts = actions.map((a: any) => {
                        let details = `[${a.type.toUpperCase()}]`;
                        if (a.selector) details += ` Target: ${a.selector}`;
                        if (a.source && a.target) details += ` Source: ${a.source}, Target: ${a.target}`;
                        if (a.value) details += ` Value: "${a.value}"`;
                        if (a.direction) details += ` Direction: ${a.direction}`;
                        if (a.amount) details += ` Amount: ${a.amount}`;
                        if (a.ms) details += ` Duration: ${a.ms}ms`;
                        if (a.optionSelectors) details += ` Options: ${a.optionSelectors.join(', ')}`;
                        if (a.submitSelectors) details += ` Submits: ${a.submitSelectors.join(', ')}`;
                        if (a.type === 'draw') details += ` Coords: (${a.startX},${a.startY}) → (${a.endX},${a.endY})`;
                        if (a.reason) details += ` Reason: ${a.reason}`;
                        return details;
                    });
                    // Append new attempts to history and keep last 20 attempts max
                    this.pastAttempts.push(...newAttempts);
                    if (this.pastAttempts.length > 20) {
                        this.pastAttempts = this.pastAttempts.slice(-20);
                    }
                } else {
                    console.log('✨ [AI] Progress confirmed. Clearing past attempts.');
                    this.pastAttempts = [];
                }
            } else {
                console.log('⚠️ [AI] No progress detected after action queue (no DOM changes or URL changes).');

                // Build past attempts details and append to history
                const newAttempts = actions.map((a: any) => {
                    let details = `[${a.type.toUpperCase()}]`;
                    if (a.selector) details += ` Target: ${a.selector}`;
                    if (a.source && a.target) details += ` Source: ${a.source}, Target: ${a.target}`;
                    if (a.value) details += ` Value: "${a.value}"`;
                    if (a.direction) details += ` Direction: ${a.direction}`;
                    if (a.amount) details += ` Amount: ${a.amount}`;
                    if (a.ms) details += ` Duration: ${a.ms}ms`;
                    if (a.optionSelectors) details += ` Options: ${a.optionSelectors.join(', ')}`;
                    if (a.submitSelectors) details += ` Submits: ${a.submitSelectors.join(', ')}`;
                    if (a.type === 'draw') details += ` Coords: (${a.startX},${a.startY}) → (${a.endX},${a.endY})`;
                    if (a.reason) details += ` Reason: ${a.reason}`;
                    return details;
                });
                // Append new attempts to history and keep last 20 attempts max
                this.pastAttempts.push(...newAttempts);
                if (this.pastAttempts.length > 20) {
                    this.pastAttempts = this.pastAttempts.slice(-20);
                }

            }
        } else {
            console.log('\n⚠️ No actions returned by AI');
        }

        // Update log file with action execution results
        this.ai.updateLastAnalyzeDOMWithResults(actionResults);

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

    private async getDOMSnapshot(page: Page): Promise<Map<string, any>> {
        const snapshot = await page.evaluate(() => {
            const elements: Array<{id: string; tag: string; text: string; value: string; checked: boolean; selected: boolean}> = [];

            document.querySelectorAll('[data-ai-id]').forEach(el => {
                const htmlEl = el as HTMLElement;
                const id = htmlEl.getAttribute('data-ai-id') || '';
                if (!id) return;

                // Get text content (first 100 chars)
                const text = htmlEl.innerText?.substring(0, 100) || '';

                // Get value for inputs
                let value = '';
                let checked = false;
                let selected = false;

                if (htmlEl instanceof HTMLInputElement) {
                    value = htmlEl.value;
                    checked = htmlEl.checked;
                } else if (htmlEl instanceof HTMLTextAreaElement) {
                    value = htmlEl.value;
                } else if (htmlEl instanceof HTMLSelectElement) {
                    value = htmlEl.value;
                    selected = htmlEl.selectedIndex >= 0;
                }

                elements.push({
                    id,
                    tag: htmlEl.tagName.toLowerCase(),
                    text,
                    value,
                    checked,
                    selected
                });
            });

            return elements;
        });

        const map = new Map();
        snapshot.forEach(item => {
            map.set(item.id, item);
        });
        return map;
    }

    private compareDOMSnapshots(before: Map<string, any>, after: Map<string, any>): any {
        const changes = {
            added: [] as string[],
            removed: [] as string[],
            textChanged: [] as Array<{id: string; before: string; after: string}>,
            valueChanged: [] as Array<{id: string; tag: string; before: string; after: string}>,
            checkedChanged: [] as Array<{id: string; before: boolean; after: boolean}>,
            hasChanges: false
        };

        // Find removed elements
        before.forEach((_, id) => {
            if (!after.has(id)) {
                changes.removed.push(id);
            }
        });

        // Find added elements and changes
        after.forEach((afterData, id) => {
            if (!before.has(id)) {
                changes.added.push(id);
            } else {
                const beforeData = before.get(id);

                // Check text changes
                if (beforeData.text !== afterData.text && (beforeData.text || afterData.text)) {
                    changes.textChanged.push({
                        id,
                        before: beforeData.text,
                        after: afterData.text
                    });
                }

                // Check value changes
                if (beforeData.value !== afterData.value && (beforeData.value || afterData.value)) {
                    changes.valueChanged.push({
                        id,
                        tag: afterData.tag,
                        before: beforeData.value,
                        after: afterData.value
                    });
                }

                // Check checked state changes
                if (beforeData.checked !== afterData.checked) {
                    changes.checkedChanged.push({
                        id,
                        before: beforeData.checked,
                        after: afterData.checked
                    });
                }
            }
        });

        changes.hasChanges = changes.added.length > 0 ||
                            changes.removed.length > 0 ||
                            changes.textChanged.length > 0 ||
                            changes.valueChanged.length > 0 ||
                            changes.checkedChanged.length > 0;

        return changes;
    }

    private buildChangesSummary(changes: any): string {
        const lines: string[] = [];

        if (changes.urlChanged) {
            lines.push(`✓ Navigation occurred: ${changes.urlChanged.from} → ${changes.urlChanged.to}`);
        }

        if (changes.added.length > 0) {
            lines.push(`✓ Added ${changes.added.length} new element(s) to DOM`);
        }

        if (changes.removed.length > 0) {
            lines.push(`✓ Removed ${changes.removed.length} element(s) from DOM`);
        }

        if (changes.valueChanged.length > 0) {
            lines.push(`✓ Updated ${changes.valueChanged.length} form value(s):`);
            changes.valueChanged.slice(0, 3).forEach((change: any) => {
                const oldVal = change.before ? `"${change.before.substring(0, 30)}"` : '(empty)';
                const newVal = change.after ? `"${change.after.substring(0, 30)}"` : '(empty)';
                lines.push(`  - ${change.id} <${change.tag}>: ${oldVal} → ${newVal}`);
            });
            if (changes.valueChanged.length > 3) {
                lines.push(`  ... and ${changes.valueChanged.length - 3} more`);
            }
        }

        if (changes.textChanged.length > 0) {
            lines.push(`✓ Text content changed in ${changes.textChanged.length} element(s):`);
            changes.textChanged.slice(0, 3).forEach((change: any) => {
                const oldText = change.before ? `"${change.before.substring(0, 30)}..."` : '(empty)';
                const newText = change.after ? `"${change.after.substring(0, 30)}..."` : '(empty)';
                lines.push(`  - ${change.id}: ${oldText} → ${newText}`);
            });
            if (changes.textChanged.length > 3) {
                lines.push(`  ... and ${changes.textChanged.length - 3} more`);
            }
        }

        if (changes.checkedChanged.length > 0) {
            lines.push(`✓ Checked state changed in ${changes.checkedChanged.length} element(s)`);
        }

        return lines.join('\n');
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
    private buildHierarchy(params: {ignoreList: string[]; noisePatterns: Array<{tag: string; contentPattern?: string; exactMatch?: string}>}): any {
        const ignoreSet = new Set(params.ignoreList);

        // Compile noise patterns to regexes and exact matches
        const compiledPatterns = params.noisePatterns.map(p => ({
            tag: p.tag.toLowerCase(),
            regex: p.contentPattern ? new RegExp(p.contentPattern) : null,
            exactMatch: p.exactMatch || null
        }));

        // Track filtering stats
        const stats = {
            filteredByIgnoreList: 0,
            filteredByPattern: 0,
            patternMatches: [] as Array<{tag: string; text: string; pattern: string}>,
            nearMisses: [] as Array<{tag: string; text: string; pattern: string; reason: string}>
        };

        // Extract direct text content (same logic as node.x extraction)
        const getDirectText = (el: HTMLElement): string => {
            let text = '';
            for (const child of Array.from(el.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE) {
                    text += child.textContent + ' ';
                }
            }
            return text.trim();
        };

        const matchesNoisePattern = (el: HTMLElement): boolean => {
            const tagName = el.tagName.toLowerCase();
            // Use direct text content to match what will be in node.x
            const text = getDirectText(el);

            if (!text) return false; // Skip empty elements

            for (const pattern of compiledPatterns) {
                if (pattern.tag === tagName) {
                    // Check exact match first (faster)
                    if (pattern.exactMatch && text === pattern.exactMatch) {
                        stats.filteredByPattern++;
                        if (stats.patternMatches.length < 10) {
                            stats.patternMatches.push({
                                tag: tagName,
                                text: text.substring(0, 80),
                                pattern: `[exact:"${pattern.exactMatch.substring(0, 30)}..."]`
                            });
                        }
                        return true;
                    }

                    // Then check regex pattern
                    if (pattern.regex) {
                        if (pattern.regex.test(text)) {
                            stats.filteredByPattern++;
                            // Only track first 10 matches to avoid bloat
                            if (stats.patternMatches.length < 10) {
                                stats.patternMatches.push({
                                    tag: tagName,
                                    text: text.substring(0, 80),
                                    pattern: pattern.regex.source
                                });
                            }
                            return true;
                        } else if (stats.nearMisses.length < 5) {
                            // Track near misses for debugging (tag matches but text doesn't)
                            stats.nearMisses.push({
                                tag: tagName,
                                text: text.substring(0, 80),
                                pattern: pattern.regex.source,
                                reason: 'Tag matched but text pattern did not match'
                            });
                        }
                    }
                }
            }
            return false;
        };

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
            if (aiIdAttr && ignoreSet.has(aiIdAttr)) {
                stats.filteredByIgnoreList++;
                return null;
            }

            // Check interactivity FIRST - interactive elements must NEVER be filtered
            const interactive = isInteractive(el);
            const style = window.getComputedStyle(el);
            const hasPointerCursor = style.cursor === 'pointer';
            const mightBeInteractive = interactive || hasPointerCursor || el.hasAttribute('draggable');

            // Filter by noise patterns - BUT NEVER filter potentially interactive elements
            if (!mightBeInteractive && matchesNoisePattern(el)) return null;

            if (!isInteresting(el)) return null;

            // Assign unique ID for AI targeting (Stable on same-page)
            let aiId = el.getAttribute('data-ai-id');
            if (!aiId) {
                aiId = `ai-${++(window as any).__ai_id_counter}`;
                el.setAttribute('data-ai-id', aiId);
            }

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

            // Filter out empty non-interactive containers (after children are filtered)
            // Keep special elements like canvas/img even if empty
            const specialTags = ['canvas', 'img'];
            const isEmptyContainer = !node.i && !node.x && children.length === 0 && !specialTags.includes(node.t);
            if (isEmptyContainer) {
                return null;
            }

            if (!node.i && !node.x && children.length === 1 && !el.id) {
                return children[0];
            }

            if (children.length > 0) node.ch = children; // ch = children
            return node;
        };

        const root = processNode(document.body);
        const tree = root ? [root] : [];
        return {
            tree,
            stats
        };
    }
}
