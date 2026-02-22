# Browser Challenge Runner

Fast browser automation for navigating challenge screens with Groq AI assistance.

# Design and Architecture
Key ideas/goals:

- Wrong actions have low cost, prioritise speed and progress (changing the DOM state)

- Represent the DOM as compactly as possible for LLM but retain the useful information. Use a JSON as LLMS tend to handle well.

- Find the cheapest, fastest LLM that can still be accurate enough

- Have the LLM return a compact, well-defined structure, a list of primitive actions (click, input, drag etc) with all the parameters to execute derived from the DOM state. 

- Use the dom changing as an indicator of progress, feed back history of actions that were tried but didn’t cause change into prompt to prevent repetition. Feed in DOM changes to draw attention to new info and potential actions

- Prioritise a small LLM response as this is a key determinant of response speed

- Tried filtering simplified DOM periodically, disabled by default as this saves tokens at the cost of speed (With more optimisation might improve both).

- Prompt instructions to guide translation of State into actions, whilst not containing anything specific to the challenge

High level design:
<img width="1011" height="381" alt="BrowserChallenge" src="https://github.com/user-attachments/assets/5175f12e-f574-4dce-b85d-c4dd449620c8" />

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

