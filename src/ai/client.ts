import Groq from 'groq-sdk';
import * as dotenv from 'dotenv';

dotenv.config();

export class AIClient {
    private client: Groq;
    private model = 'openai/gpt-oss-120b'; // Fast, good at JSON

    constructor() {
        if (!process.env.GROQ_API_KEY) {
            console.warn('⚠️ GROQ_API_KEY not found in .env');
        }
        this.client = new Groq({
            apiKey: process.env.GROQ_API_KEY
        });
    }

    async analyzeDOM(domTree: any, pastAttempts?: string): Promise<any> {
        const prompt = `
    You are a browser automation agent.
    
    Task:
    1. Receive a COMPRESSED DOM Tree.
    2. Analyze the compressed nodes to find the goal.
    3. Generate a sequence of EXECUTABLE actions.
    
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

    ELEMENT SELECTION SPECIFICITY:
    - ALWAYS prefer the MOST SPECIFIC element (deepest in hierarchy) over containers
    - If a parent element has "ch" (children), and one child is the actual target, select the CHILD not the parent
    - Example: Container with text "Available slots" has children "Slot 1", "Slot 2" → select specific slot, not container
    - For drag targets: If you see a container holding multiple slots/zones, target the specific empty slot element
    - General rule: When in doubt, prefer leaf nodes (elements without "ch" or with minimal children) over branch nodes
    
    DATA ACCURACY RULES:
    - NEVER GUESS CODES: Do not invent or guess codes (like "ABC123").
    - ONLY USE REVEALED DATA: Only enter codes into inputs if you can see the code text in an "x" field.
    - TAKE CARE NOT TO FOLLOW DIRECTIONS THAT MAY HAVE ALREADY BEEN COMPLETED

    ACTION SCHEMES:
    - click: { selector: string, description: string } (Single click)
    - input: { selector: string, value: string, description: string } (Type into input)
    - scroll: { selector?: string, direction: "up" | "down", amount: number, description: string } (Scroll)
    - key: { value: string, description: string } (Keyboard press - use "Escape" to dismiss popups/modals)
    - drag: { source: string, target: string, description: string } (Drag/Drop elements - IMPORTANT: For target, select the MOST SPECIFIC element (deepest child), NOT the container. Carefully find the correct target.)
    - draw: { selector: string, startX: number, startY: number, endX: number, endY: number, description: string } (Mouse drag by coordinates on a specific element - REQUIRED for: drawing on canvas, tracing paths, creating signatures, dragging sliders. MUST specify the selector of the canvas/drawing element. Use bbox field to determine valid coordinates. For a canvas with bbox: {x: 100, y: 200, w: 400, h: 200}, valid draw coordinates are startX/endX between 100-500 and startY/endY between 200-400.)
    - hover: { selector: string, ms: number, description: string } (Hover)
    - wait: { ms: number, description: string } (Wait)
    - clickEverywhere: { reason: string, description: string } (Grid-based click spam across entire viewport to unstick situations where direct element targeting is impossible. useful if you know you need to click something but can't seem to find it in the dom)
    - brute_force_form: { optionSelectors: string[], submitSelectors: string[], description: string } (Systematically try all combinations of form options and submit buttons. Use for forms where you need to try multiple combinations to find the right one, such as modal forms that reappear with shuffled options.)

    INTERACTION GUIDELINES:
    1. Focus on the main goal - the system can click through overlays and popups automatically
    2. BEWARE OF DECEPTIVE UI: Avoid buttons where "c" is "not-allowed". Look for "c": "pointer"
    3. HOVER/WAIT: Use "hover" to reveal hidden content if needed. CRITICAL: Do NOT use "wait" unless the page content EXPLICITLY requires a delay (e.g., "Please wait 5 seconds", countdown timers, or specific timed instructions visible in the DOM)
    4. Prefer direct action over complex strategies - if you see a button or input that advances your goal, interact with it
    5. CANVAS DRAWING: When you see a canvas element with a bbox field, use multiple "draw" actions to create strokes. Each stroke should have coordinates within the canvas bounds (bbox.x to bbox.x+bbox.w for X, bbox.y to bbox.y+bbox.h for Y). Vary the strokes to cover different areas of the canvas.
    6. FORM SUBMISSION PRIORITY: If you filled an input field in a previous action, IMMEDIATELY prioritize clicking its associated submit button in the next action. Don't leave forms incomplete - complete the submission sequence before moving to other tasks. Look for nearby buttons with text like "Submit", "Continue", "Next", "Send", etc.

    - Use "drag": When moving UI elements (dragging a card to a drop zone, reordering list items, drag-and-drop interactions)
    - Use "draw": When the task requires mouse movement itself (drawing on canvas, creating signatures, tracing shapes, painting, sketching, moving sliders precisely, any instruction to "draw", "trace", "paint", or "sketch")
    
    PAST ATTEMPTS:
    ${pastAttempts || "None."}
    - If past attempts are listed and DID NOT result in a DOM change:
        - Selector Audit: Look at the Target selectors used in the failed actions. Were they correct? Re-examine the DOM hierarchy and consider if you targeted the wrong element (e.g., a div instead of its child button, or a hidden element).
        - Form Completion Check: If you filled an input but didn't submit the form, look for submit buttons nearby and click them before trying other actions.
        - Try a different approach: scroll to reveal content, hover to show hidden elements, or click different interactive elements that might advance the goal.

    RETRY ESCALATION STRATEGY:
    When you have a clear action to perform but repeated attempts fail, escalate your strategy:
    1. FIRST ATTEMPTS (1-5): Try direct interaction (click, input, etc.) - the system automatically promotes z-index to bypass overlays. Be patient and try multiple times.
    2. IF 6-7 ATTEMPTS FAIL on similar actions: Look for close buttons or press Escape to clear popups, then retry
    3. AFTER 8+ FAILURES: System will automatically clear all popups/modals for you
    4. IF facing a modal form that persists: Use "brute_force_form" to systematically try all combinations

    IMPORTANT: Be very patient - try the same action many times before escalating. Actions may work even without visible DOM changes. Don't preemptively close popups.

    Response Format:
    Return a JSON object with:
    - planDescription: High-level summary of what you are trying to achieve.
    - actions: Sequence of 1-20 actions, each with a short "description" field.
    `;

        try {
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
                                planDescription: { type: "string" },
                                actions: {
                                    type: "array",
                                    items: {
                                        anyOf: [
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "click" },
                                                    selector: { type: "string" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "selector", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "input" },
                                                    selector: { type: "string" },
                                                    value: { type: "string" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "selector", "value", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "scroll" },
                                                    selector: { type: "string" },
                                                    direction: { enum: ["up", "down"] },
                                                    amount: { type: "integer" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "key" },
                                                    value: { type: "string" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "value", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "drag" },
                                                    source: { type: "string" },
                                                    target: { type: "string" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "source", "target", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "draw" },
                                                    selector: { type: "string" },
                                                    startX: { type: "number" },
                                                    startY: { type: "number" },
                                                    endX: { type: "number" },
                                                    endY: { type: "number" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "selector", "startX", "startY", "endX", "endY", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "hover" },
                                                    selector: { type: "string" },
                                                    ms: { type: "integer" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "selector", "ms", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "wait" },
                                                    ms: { type: "integer" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "ms", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "clickEverywhere" },
                                                    reason: { type: "string" },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "reason", "description"]
                                            },
                                            {
                                                type: "object",
                                                properties: {
                                                    type: { const: "brute_force_form" },
                                                    optionSelectors: {
                                                        type: "array",
                                                        items: { type: "string" }
                                                    },
                                                    submitSelectors: {
                                                        type: "array",
                                                        items: { type: "string" }
                                                    },
                                                    description: { type: "string" }
                                                },
                                                required: ["type", "optionSelectors", "submitSelectors", "description"]
                                            }
                                        ]
                                    }
                                }
                            },
                            required: ["planDescription", "actions"]
                        }
                    }
                } as any
            });

            const rawResponse = completion.choices[0]?.message?.content || '{}';
            console.log('\n[AI] RAW RESPONSE:');
            console.log(rawResponse);

            return JSON.parse(rawResponse);
        } catch (error) {
            console.error('AI Analysis failed:', error);
            return { error: 'Failed to analyze DOM' };
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

            const result = JSON.parse(completion.choices[0]?.message?.content || '{"ids": []}');
            return result.ids || [];
        } catch (error) {
            console.error('Noise identification failed:', error);
            return [];
        }
    }
}
