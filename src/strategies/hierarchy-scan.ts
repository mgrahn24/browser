import { Page } from 'playwright';
import { Strategy, StrategyResult } from './base';

interface SimplifiedNode {
    type: string;
    text?: string;
    attributes?: Record<string, string>;
    children?: SimplifiedNode[];
    interactive?: boolean;
}

/**
 * Scans the DOM to build a simplified hierarchy tree.
 * Groups related elements (containers) and identifies interactive leaf nodes.
 * Used to understand the structural context of the page.
 */
export class HierarchyScanStrategy implements Strategy {
    name = 'hierarchy-scan';

    async execute(page: Page): Promise<StrategyResult> {
        const start = Date.now();

        const tree = await page.evaluate(this.buildHierarchy);

        console.log(`[HierarchyScan] Simplified DOM Tree:`);
        this.printTree(tree);

        const timeMs = Date.now() - start;
        return {
            success: true,
            message: `Built hierarchy tree in ${timeMs}ms`,
            timeMs
        };
    }

    private printTree(nodes: SimplifiedNode[], depth: number = 0) {
        const indent = '  '.repeat(depth);
        for (const node of nodes) {
            let line = `${indent}${node.type}`;
            if (node.attributes?.id) line += `#${node.attributes.id}`;
            if (node.text) line += ` "${node.text.substring(0, 30)}${node.text.length > 30 ? '...' : ''}"`;
            if (node.interactive) line += ` [INTERACTIVE]`;

            console.log(line);

            if (node.children) {
                this.printTree(node.children, depth + 1);
            }
        }
    }

    /**
     * Browser-side hierarchy builder.
     * Returns a list of root SimplifiedNodes.
     */
    private buildHierarchy(): SimplifiedNode[] {

        // Helper to check if a node is "interesting" enough to keep
        const isInteresting = (el: HTMLElement): boolean => {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;

            // Keep if it has text content
            if (el.innerText && el.innerText.trim().length > 0) return true;

            // Keep if it has interactive attributes
            if (['input', 'button', 'select', 'textarea', 'img'].includes(el.tagName.toLowerCase())) return true;
            if (style.cursor === 'pointer') return true;

            // Keep if it's a structural container with dimensions (roughly)
            const rect = el.getBoundingClientRect();
            if (rect.width > 50 && rect.height > 50) return true;

            return false;
        };

        // Helper to determine if element is interactive
        const isInteractive = (el: HTMLElement): boolean => {
            const tag = el.tagName.toLowerCase();
            const style = window.getComputedStyle(el);
            return ['button', 'a', 'input', 'select', 'textarea'].includes(tag) ||
                el.hasAttribute('onclick') ||
                el.getAttribute('role') === 'button' ||
                style.cursor === 'pointer';
        };

        const processNode = (el: HTMLElement): SimplifiedNode | null => {
            if (!isInteresting(el)) return null;

            const node: SimplifiedNode = {
                type: el.tagName.toLowerCase(),
                attributes: {},
                interactive: isInteractive(el)
            };

            if (el.id) node.attributes!['id'] = el.id;

            // Get direct text content
            let text = '';
            for (const child of Array.from(el.childNodes)) {
                if (child.nodeType === Node.TEXT_NODE) {
                    text += child.textContent?.trim() + ' ';
                }
            }
            text = text.trim();
            if (text) node.text = text;

            // Special handling for inputs
            if (el.tagName === 'INPUT') {
                node.text = (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder || '';
                node.attributes!['type'] = (el as HTMLInputElement).type;
            }

            // Process children
            const children: SimplifiedNode[] = [];
            for (const child of Array.from(el.children)) {
                const processed = processNode(child as HTMLElement);
                if (processed) {
                    children.push(processed);
                }
            }

            // Flatten logic: If this node has only 1 child and no text/interesting attrs itself, 
            // return the child instead (skip unnecessary wrappers)
            // Exception: If this node is interactive, keep it.
            if (!node.interactive && !node.text && children.length === 1 && !node.attributes!.id) {
                return children[0];
            }

            if (children.length > 0) {
                node.children = children;
            }

            return node;
        };

        // Start with body
        const root = processNode(document.body);
        return root ? [root] : [];
    }
}
