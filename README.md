# Browser Challenge Runner

Fast browser automation for navigating challenge screens with Groq AI assistance.

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   npx playwright install chromium
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env and add your GROQ_API_KEY
   ```

3. **Run the challenge**:
   ```bash
   # With visible browser
   npm run dev -- --url "https://your-challenge-site.com"

   # Headless (faster)
   npm start -- --url "https://your-challenge-site.com"
   ```

## Usage

```bash
npx ts-node src/index.ts [options]

Options:
  -u, --url <url>           Target URL to start from (required)
  -m, --max-screens <n>     Maximum screens to attempt (default: 30)
  --headless                Run without visible browser (default)
  --no-headless             Show the browser window
  --disable-images          Block images for speed (default)
  --disable-fonts           Block fonts for speed (default)
  -t, --timeout <ms>        Page timeout in ms (default: 30000)
  --groq-key <key>          Groq API key
  --groq-model <model>      Groq model (default: llama3-70b-8192)
```

## Examples

```bash
# Full speed, headless
npm start -- -u "https://serene-frangipane-7fd25b.netlify.app/" --headless

# Debug mode with visible browser
npm start -- -u "https://serene-frangipane-7fd25b.netlify.app/" --no-headless

# With custom Groq settings
npm start -- -u "https://serene-frangipane-7fd25b.netlify.app/" --groq-key "your-key" --groq-model "llama3-8b-8192"
```

## Architecture

```
src/
├── core/           # Browser and page controllers
├── strategies/     # Challenge-solving strategies
├── ai/             # Groq AI integration
├── runner/         # Main orchestration
└── index.ts        # CLI entry point
```

## Strategies

The runner tries strategies in priority order:
1. **TargetedClick** (90) - Specific selectors you define
2. **ConfiguredForm** (80) - Forms with known fields
3. **Form** (60) - Auto-detect and fill forms
4. **Click** (50) - Find obvious action buttons
5. **Navigation** (40) - Follow links
6. **Wait** (30) - Handle loading states
7. **AIPuzzle** (25) - Solve puzzles with Groq
8. **AI** (10) - Fallback AI analysis

## Adding Custom Strategies

```typescript
import { ChallengeRunner, BaseStrategy } from './runner';

class MyCustomStrategy extends BaseStrategy {
  name = 'custom';
  priority = 100; // High priority

  async canHandle(context) {
    return context.url.includes('my-pattern');
  }

  async execute(context) {
    // Your logic here
    return { success: true, message: 'Done', timeMs: 100 };
  }
}

const runner = new ChallengeRunner({
  targetUrl: 'https://...',
  customStrategies: [new MyCustomStrategy()],
});
```

## Speed Optimizations

- **Resource blocking**: Images, fonts blocked by default
- **Headless mode**: No GUI rendering overhead
- **Smart waiting**: Wait for specific elements, not fixed delays
- **Strategy prioritization**: Fast strategies tried first
- **Connection reuse**: Persistent browser context
