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
  --groq-model <model>      Groq model
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

