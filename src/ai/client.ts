import Groq from 'groq-sdk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

export class AIClient {
    private client: Groq;
    private model = 'openai/gpt-oss-120b'; // Fast, good at JSON
    private callCounter = 0;
    private lastAnalyzeDOMLogPath: string | null = null;
    private logAICalls: boolean;

    // Cumulative token usage tracking
    private totalInputTokens = 0;
    private totalOutputTokens = 0;
    private static readonly INPUT_COST_PER_MILLION = 0.15;
    private static readonly OUTPUT_COST_PER_MILLION = 0.60;

    constructor(logAICalls: boolean = false) {
        if (!process.env.GROQ_API_KEY) {
            console.warn('⚠️ GROQ_API_KEY not found in .env');
        }
        this.client = new Groq({
            apiKey: process.env.GROQ_API_KEY
        });

        this.logAICalls = logAICalls;

        // Ensure logs directory exists for token usage tracking
        const logsDir = path.join(process.cwd(), 'logs');
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }
        if (this.logAICalls) {
            const aiCallsDir = path.join(logsDir, 'ai-calls');
            if (!fs.existsSync(aiCallsDir)) {
                fs.mkdirSync(aiCallsDir, { recursive: true });
            }
        }
    }

    getTokenUsageSummary(): { totalInputTokens: number; totalOutputTokens: number; totalTokens: number; totalCalls: number; cost: string } {
        const inputCost = (this.totalInputTokens / 1_000_000) * AIClient.INPUT_COST_PER_MILLION;
        const outputCost = (this.totalOutputTokens / 1_000_000) * AIClient.OUTPUT_COST_PER_MILLION;
        return {
            totalInputTokens: this.totalInputTokens,
            totalOutputTokens: this.totalOutputTokens,
            totalTokens: this.totalInputTokens + this.totalOutputTokens,
            totalCalls: this.callCounter,
            cost: `$${(inputCost + outputCost).toFixed(4)}`
        };
    }

    private logAICall(type: string, prompt: string, input: any, response: any, timing: { durationMs: number }, tokenUsage?: any): string | null {
        this.callCounter++;

        // Always track token usage, even if file logging is disabled
        if (tokenUsage) {
            this.totalInputTokens += tokenUsage.prompt_tokens || 0;
            this.totalOutputTokens += tokenUsage.completion_tokens || 0;
        }

        const inputCost = (this.totalInputTokens / 1_000_000) * AIClient.INPUT_COST_PER_MILLION;
        const outputCost = (this.totalOutputTokens / 1_000_000) * AIClient.OUTPUT_COST_PER_MILLION;
        const totalCost = inputCost + outputCost;

        console.log(`[AI] Token usage — this call: ${tokenUsage?.prompt_tokens || 0} in / ${tokenUsage?.completion_tokens || 0} out | cumulative: ${this.totalInputTokens} in / ${this.totalOutputTokens} out | cost: $${totalCost.toFixed(4)}`);

        // Write cumulative summary to logs/token_usage.json
        try {
            const summaryPath = path.join(process.cwd(), 'logs', 'token_usage.json');
            const summaryData = {
                totalInputTokens: this.totalInputTokens,
                totalOutputTokens: this.totalOutputTokens,
                totalTokens: this.totalInputTokens + this.totalOutputTokens,
                totalCalls: this.callCounter,
                cost: {
                    input: `$${inputCost.toFixed(4)}`,
                    output: `$${outputCost.toFixed(4)}`,
                    total: `$${totalCost.toFixed(4)}`
                },
                rates: {
                    inputPerMillion: `$${AIClient.INPUT_COST_PER_MILLION}`,
                    outputPerMillion: `$${AIClient.OUTPUT_COST_PER_MILLION}`
                },
                lastUpdated: new Date().toISOString()
            };
            fs.writeFileSync(summaryPath, JSON.stringify(summaryData, null, 2));
        } catch (error) {
            console.error('[AI] Failed to write token usage summary:', error);
        }

        if (!this.logAICalls) {
            return null;
        }

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `${timestamp}_${this.callCounter}_${type}.json`;
            const logsDir = path.join(process.cwd(), 'logs', 'ai-calls');
            const filepath = path.join(logsDir, filename);

            const logData = {
                timestamp: new Date().toISOString(),
                callNumber: this.callCounter,
                type,
                model: this.model,
                durationMs: timing.durationMs,
                tokenUsage,
                cumulativeUsage: {
                    totalInputTokens: this.totalInputTokens,
                    totalOutputTokens: this.totalOutputTokens,
                    totalTokens: this.totalInputTokens + this.totalOutputTokens,
                    cost: {
                        input: `$${inputCost.toFixed(4)}`,
                        output: `$${outputCost.toFixed(4)}`,
                        total: `$${totalCost.toFixed(4)}`
                    }
                },
                prompt,
                input,
                response
            };

            fs.writeFileSync(filepath, JSON.stringify(logData, null, 2));
            console.log(`[AI] Logged call to: logs/ai-calls/${filename} (${timing.durationMs}ms, tokens: ${tokenUsage?.total_tokens || 'unknown'})`);
            return filepath;
        } catch (error) {
            console.error('[AI] Failed to log AI call:', error);
            return null;
        }
    }

    updateLogWithActionResults(filepath: string, actionResults: any[]): void {
        try {
            if (!filepath || !fs.existsSync(filepath)) return;

            const logData = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
            logData.actionResults = actionResults;
            fs.writeFileSync(filepath, JSON.stringify(logData, null, 2));
        } catch (error) {
            console.error('[AI] Failed to update log with action results:', error);
        }
    }

    updateLastAnalyzeDOMWithResults(actionResults: any[]): void {
        if (this.lastAnalyzeDOMLogPath) {
            this.updateLogWithActionResults(this.lastAnalyzeDOMLogPath, actionResults);
        }
    }

    async analyzeDOM(domTree: any, pastAttempts?: string): Promise<any> {
        const prompt = `
    You are a browser automation agent.

    Task:
    1. Receive a COMPRESSED DOM Tree.
    2. Analyze the compressed nodes to find the goal.
    3. Generate a sequence of EXECUTABLE actions (minimal output - no descriptions needed).
    
    KEY MAPPING:
    - t: Tag Name (e.g., "button")
    - id: Unique ID (Matches [data-ai-id] attribute) - USE THIS as the selector value (e.g., "#ai-123")
    - i: Interactive (1 = yes; missing = no)
    - z: LayerZ / Stacking tier (missing = 0)
    - v: Visibility (0 = BLOCKED; missing/1 = Visible) - NOTE: The system can click through overlays, so blocked elements are still actionable
    - s: CSS Position (missing = "static")
    - c: CSS Cursor (missing = "auto")
    - x: Text / Value / Label
    - ch: Children array (nested elements) - USE THIS to understand DOM hierarchy
    - bbox: Bounding box {x, y, w, h} for canvas elements - viewport coordinates where x,y is top-left corner, w is width, h is height

    ELEMENT SELECTION:
    - Pay attention to CSS Cursor, if c is "pointer", regardless of the tag, this element can likely be treated like a button and clicked.

    DATA ACCURACY RULES:
    - Don't make up information that should be provided by the page, Only enter info into inputs if you know what the value should be based on available information.
    - Before commiting to an action carefully consider if you cave already completed that action based on the data you have.

    ACTION SCHEMES:
    - click: { selector: string } (Single click)
    - input: { selector: string, value: string } (Type into input)
    - scroll: { selector?: string, direction: "up" | "down", amount: number } (Scroll)
    - key: { value: string } (Keyboard press)
    - drag: { source: string, target: string } (Drag/Drop elements - IMPORTANT: For target, select the MOST SPECIFIC element (deepest child), NOT the container. Carefully find the correct target.)
    - draw: { selector: string, startX: number, startY: number, endX: number, endY: number } (Mouse drag by coordinates on a specific element - REQUIRED for: drawing on canvas, tracing paths, creating signatures, dragging sliders. MUST specify the selector of the canvas/drawing element. IMPORTANT: Coordinates are RELATIVE to the element's top-left corner (0,0 = element origin). For a canvas with bbox: {x: 100, y: 200, w: 400, h: 200}, valid draw coordinates are startX/endX between 0-400 and startY/endY between 0-200, NOT absolute viewport coordinates.)
    - hover: { selector: string, ms: number } (Hover)
    - wait: { ms: number } (Wait)

    INTERACTION GUIDELINES:
    1. Focus on the main goal - the system can click through overlays and popups automatically
    2. Use wait sparingly, only when the content of the page explicitly requires a delay (e.g., "Please wait for something", countdown timers, or specific timed instructions visible in the DOM)
    3. If there are text inputs that you have the information available to fill, this is likely a high priority.
    4. Prefer direct action over complex strategies - if you see a button or input that advances your goal, interact with it
    5. FORM SUBMISSION PRIORITY: If you filled an input field in a previous action, IMMEDIATELY prioritize clicking its associated submit button in the next action. Don't leave forms incomplete - complete the submission sequence before moving to other tasks. Look for nearby buttons with text like "Submit", "Continue", "Next", "Send", etc.

    - Use "drag": When moving UI elements (dragging something to a drop zone, reordering list items, drag-and-drop interactions)
    - Use "draw": When the task requires mouse movement itself (drawing on canvas, creating signatures, tracing shapes, painting, moving sliders precisely)
    
    PAST ATTEMPTS:
    ${pastAttempts || "None."}
    - If past attempts are listed and DID NOT result in a DOM change:
        - Check the information available, especially the changes to the dom above, it a change to the dom indicates that a new option or piece of information is available, that is likely related to the next required action
        - Selector Audit: Look at the Target selectors used in the failed actions. Were they correct? Re-examine the DOM hierarchy and consider if you targeted the wrong element (e.g., a parent instead of a child element).
        - Form Completion Check: If you filled an input but didn't submit the form, look for submit buttons nearby and click them before trying other actions.
        - Maybe you chose the wrong action, try something different, the next most likely thing you think you need to do to proceed
        - If you tried to click an element many times and failed, or if you know an element needs to be clciked but you can't target it directly, USE THE clickEverywhere action.
        

    Response Format:
    Return a JSON object with:
    - actions: Sequence of 1-20 actions
    `;

        try {
            const startTime = Date.now();
            const completion = await this.client.chat.completions.create({
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: JSON.stringify(domTree) }
                ],
                model: this.model,
                temperature: 0.1,
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "action_plan",
                        schema: {
                            type: "object",
                            properties: {
                                actions: {
                                    type: "array",
                                    items: {
                                        anyOf: [
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "click" },
                                                    selector: { type: "string" }
                                                },
                                                required: ["type", "selector"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "input" },
                                                    selector: { type: "string" },
                                                    value: { type: "string" }
                                                },
                                                required: ["type", "selector", "value"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "scroll" },
                                                    selector: { type: "string" },
                                                    direction: { enum: ["up", "down"] },
                                                    amount: { type: "integer" }
                                                },
                                                required: ["type"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "key" },
                                                    value: { type: "string" }
                                                },
                                                required: ["type", "value"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "drag" },
                                                    source: { type: "string" },
                                                    target: { type: "string" }
                                                },
                                                required: ["type", "source", "target"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "draw" },
                                                    selector: { type: "string" },
                                                    startX: { type: "number" },
                                                    startY: { type: "number" },
                                                    endX: { type: "number" },
                                                    endY: { type: "number" }
                                                },
                                                required: ["type", "selector", "startX", "startY", "endX", "endY"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "hover" },
                                                    selector: { type: "string" },
                                                    ms: { type: "integer" }
                                                },
                                                required: ["type", "selector", "ms"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "wait" },
                                                    ms: { type: "integer" }
                                                },
                                                required: ["type", "ms"]
                                            }
                                        ]
                                    }
                                }
                            },
                            required: ["actions"]
                        }
                    }
                } as any
            });

            const durationMs = Date.now() - startTime;
            const rawResponse = completion.choices[0]?.message?.content || '{}';
            console.log('\n[AI] RAW RESPONSE:');
            console.log(rawResponse);

            const parsedResponse = JSON.parse(rawResponse);

            // Log the AI call with timing, token usage, and raw response
            // Pass the raw response as well for complete logging
            this.lastAnalyzeDOMLogPath = this.logAICall(
                'analyzeDOM',
                prompt,
                domTree,
                { parsed: parsedResponse, raw: rawResponse },
                { durationMs },
                completion.usage
            );

            return parsedResponse;
        } catch (error) {
            console.error('AI Analysis failed:', error);
            return { error: 'Failed to analyze DOM' };
        }
    }

    async identifyNoisePatterns(domTree: any, textExamples?: Array<{tag: string; text: string}>): Promise<Array<{tag: string; contentPattern?: string; exactMatch?: string; reason: string}>> {
        const examplesText = textExamples
            ? `\n\nACTUAL TEXT EXAMPLES FROM DOM (use these to create accurate patterns):\n${textExamples.map(ex => `<${ex.tag}>: "${ex.text}"`).join('\n')}`
            : '';

        const prompt = `
    Task: Aggressively identify and filter non-essential, repeated elements in the DOM to minimize tokens.

    GOAL: Create filters (regex patterns OR exact text matches) that will remove filler content from future LLM calls.

    YOUR MISSION: Be AGGRESSIVE. Filter out everything that doesn't help the AI understand what to do or how to interact with the page.

    SAFE TO FILTER (BE AGGRESSIVE):
    1. Lorem Ipsum text, placeholder text, sample text (e.g., "Nemo enim ipsam voluptatem...", "Lorem ipsum dolor...")
    2. Repeated decorative text (headers, footers, taglines)
    3. Generic labels without actionable value ("Loading...", "Please wait", "Welcome")
    4. Redundant navigation breadcrumbs
    5. Marketing copy, descriptions, explanations that don't instruct
    6. Status indicators, badges, labels that don't change behavior
    7. Any text that appears multiple times and doesn't provide unique information

    NEVER FILTER:
    - Interactive elements (i: 1) like buttons, inputs, links
    - Elements with cursor: pointer (clickable)
    - Elements with draggable attribute (drag sources/targets)
    - Unique instructional text explaining what to do
    - Codes, passwords, unique identifiers
    - Form elements and their labels
    - Short labels for interactive areas ("Slot", "Zone", "Area")

    FILTER TYPES (use BOTH):
    1. EXACT MATCH (preferred for specific repeated text):
       { tag, exactMatch, reason }
       - Use for specific text that appears multiple times
       - Example: { tag: "p", exactMatch: "Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit.", reason: "Lorem ipsum filler text" }

    2. REGEX PATTERN (for pattern-based filtering):
       { tag, contentPattern, reason }
       - Use for text that follows a pattern
       - contentPattern: JavaScript regex pattern (will be used with new RegExp(pattern))
       - IMPORTANT: Create patterns that match the ACTUAL text format shown in examples
       - Examples:
         * "^Loading\\\\.\\\\.\\\\.$" matches "Loading..."
         * "^Section\\\\s+\\\\d+$" matches "Section  4" or "Section 123"
         * "^Step \\\\d+ of \\\\d+$" matches "Step 1 of 5"

    KEY RULES:
    - Study the text examples provided - create patterns that ACTUALLY MATCH them
    - For Latin/Lorem Ipsum style text, use exactMatch for specific instances
    - Be AGGRESSIVE - when in doubt about filler text, FILTER IT
    - Return 10-20 filters to maximize noise reduction${examplesText}

    KEY MAPPING:
    - t: Tag Name
    - x: Text content
    - i: Interactive (1 = yes, missing = no)

    Response Format: Return JSON with "patterns" array. Be AGGRESSIVE - filter everything that looks like noise.
    `;

        try {
            const startTime = Date.now();
            const completion = await this.client.chat.completions.create({
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: JSON.stringify(domTree) }
                ],
                model: this.model,
                temperature: 0,
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "noise_patterns",
                        schema: {
                            type: "object",
                            properties: {
                                patterns: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            tag: { type: "string" },
                                            contentPattern: { type: "string" },
                                            exactMatch: { type: "string" },
                                            reason: { type: "string" }
                                        },
                                        required: ["tag", "reason"]
                                    }
                                }
                            },
                            required: ["patterns"]
                        }
                    }
                } as any
            });

            const durationMs = Date.now() - startTime;
            const rawResponse = completion.choices[0]?.message?.content || '{"patterns": []}';
            const result = JSON.parse(rawResponse);

            // Log the AI call with raw response
            this.logAICall(
                'identifyNoisePatterns',
                prompt,
                domTree,
                { parsed: result, raw: rawResponse },
                { durationMs },
                completion.usage
            );

            return result.patterns || [];
        } catch (error) {
            console.error('Noise pattern identification failed:', error);
            return [];
        }
    }

    async identifyNoise(domTree: any): Promise<string[]> {
        const prompt = `
    Task: Identify ALL non-essential nodes in the provided DOM tree.

    KEEP ONLY:
    1. Interactive elements that can be acted upon (i: 1, buttons, inputs, canvas, etc.)
    2. Text that provides instructions, directions, or information about what to interact with or how to proceed
    3. Text that contains unique identifiable data (codes, passwords, specific values)
    4. Form elements and their labels

    MARK AS NOISE (remove everything else):
    - Decorative text without instructional value
    - Repeated headings or labels that don't provide unique direction
    - Filler content, placeholder text, or generic copy
    - Blocked/hidden elements (v: 0)
    - Redundant navigation elements (when many similar buttons exist, they're likely decoys)
    - Empty containers with no interactive children
    - Generic divs with vague labels that provide no actionable information

    KEY MAPPING:
    - t: Tag Name
    - id: Unique ID
    - x: Text / Value / Label
    - i: Interactive (1 = yes)
    - v: Visibility (0 = blocked)
    - c: Cursor style
    - ch: Children

    Evaluation approach:
    - Ask: "Does this element help me know WHAT to do or HOW to do it?"
    - Ask: "Can I interact with this element?"
    - If both answers are NO → mark as noise

    Response Format: Return a JSON object with "ids" as an array of strings. Be aggressive - prefer removing over keeping.
    `;

        try {
            const startTime = Date.now();
            const completion = await this.client.chat.completions.create({
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: JSON.stringify(domTree) }
                ],
                model: this.model,
                temperature: 0,
                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "noise_reduction",
                        schema: {
                            type: "object",
                            properties: {
                                ids: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "List of data-ai-id strings to ignore"
                                }
                            },
                            required: ["ids"]
                        }
                    }
                } as any
            });

            const durationMs = Date.now() - startTime;
            const rawResponse = completion.choices[0]?.message?.content || '{"ids": []}';
            const result = JSON.parse(rawResponse);

            // Log the AI call with timing, token usage, and raw response
            this.logAICall(
                'identifyNoise',
                prompt,
                domTree,
                { parsed: result, raw: rawResponse },
                { durationMs },
                completion.usage
            );

            return result.ids || [];
        } catch (error) {
            console.error('Noise identification failed:', error);
            return [];
        }
    }
}
