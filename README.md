# Open Dot

OpenAI launched Dots on September 29, personal agents that keep working in the background on their own computers, but you need ChatGPT Pro or Business Premium to use them. Open Dot is an open source version that runs on your own Mac with your own OpenAI key, or with open models like Kimi, DeepSeek and Qwen through OpenRouter.

## What your dots can do

- Each dot has its own browser that stays logged in. You can watch it work from the Computer tab, and when it needs you to log in or get past a captcha you can take over right there and hand it back after.
- You can save passwords for sites. They're encrypted with a key in your macOS Keychain and typed straight into the page, so the model never sees them.
- It connects to Gmail, Calendar, Slack, Notion, GitHub and 1,500 other apps through [Composio](https://composio.dev). It reads on its own and asks you before it sends, posts, pays for or changes anything.
- You decide what it can do without asking, with rules like "when it wants to reply to an email, ask first". A small model checks each risky action against your rules, and you approve or deny it from a card in the chat.
- You can call it and talk. Anything you ask for on the call keeps running after you hang up, and the whole call shows up in the chat so you can carry on in text.
- You can put it on a schedule, like a brief of your inbox and calendar every weekday at 8, and it posts each run to its own chat and sends you a notification.
- Triggers wake a dot when something happens in your apps, like an email from your bank or a new issue on your repo, and it does what you told it to for that trigger. They're optional and need a Composio API key.
- You can make a few dots with different jobs, and they can pass work to each other. Each one remembers things about you and saves skills for tasks it repeats.
- It can run code in its own workspace, either on an E2B cloud computer, in a local Docker container or in a folder on your Mac.

## Get it running on your Mac

Open Dot is a desktop app. The window runs its own local server, and closing the window keeps your dots working in the background until you quit with ⌘Q.

```bash
pnpm install
pnpm desktop:build           # makes dist/Open Dot-<version>-arm64.dmg
```

The build isn't notarized yet, so the first time you open it, right-click the app and choose **Open**.

Then in **Settings**:

1. Paste your OpenAI API key, an [OpenRouter](https://openrouter.ai) key, or both. Keys are stored encrypted on your Mac. An OpenRouter key adds open models like Kimi, DeepSeek, Qwen and GLM to the model picker.
2. Sign in with Composio to connect your apps. The sign-in opens in your normal browser.
3. If you want dots to keep working while your Mac sleeps, paste an [E2B](https://e2b.dev) key too, and each dot gets a cloud computer.
4. For triggers, paste the API key of a project from [platform.composio.dev](https://platform.composio.dev), then add triggers from a dot's Setup page. You connect the apps for triggers again there, because they run in your own Composio project and not through the sign-in from step 2.

Your data stays in `~/Library/Application Support/Open Dot`.

## Run it from source

You'll need Node 22 or newer, pnpm and Google Chrome (Playwright's Chromium works if Chrome isn't installed).

```bash
cp .env.example .env.local   # add OPENAI_API_KEY, or paste it in Settings later
pnpm install
npx playwright install chromium
pnpm dev                     # http://localhost:3100
pnpm desktop:dev             # optional, opens the desktop window on top of pnpm dev
```

In development everything is stored in `.data/` in the project folder.

| Env var | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | none | Your OpenAI key, unless you paste it in Settings |
| `OPENROUTER_API_KEY` | none | Open models through OpenRouter, unless you paste the key in Settings |
| `OPENCODE_API_KEY` | none | OpenCode Go/Zen fallback key; `OPENCODE_GO_API_KEY` and `OPENCODE_ZEN_API_KEY` are also supported |
| `COMPOSIO_API_KEY` | none | A Composio project key for triggers, unless you paste it in Settings |
| `DOTS_MODEL` | best one your key can use, e.g. `gpt-5.5` | Main model for the dots (Responses API) |
| `DOTS_REVIEW_MODEL` | `gpt-5.4-mini` | Checks actions against your rules and names chats |
| `DOTS_VOICE_MODEL` | `gpt-realtime-2.1` | Voice calls |
| `DOTS_COMPUTER_TOOL` | `computer` | `computer` lets the model see and click the screen, `off` limits it to opening pages and reading them |
| `E2B_API_KEY` | none | Cloud computers, unless you paste the key in Settings |
| `DOTS_COMPUTER` | picked automatically | Force `cloud`, `docker` or `local` |
| `DOTS_BOX_IMAGE` | `node:22-bookworm` | Container image when dots run in Docker |
| `DOTS_PUBLIC_URL` | `http://localhost:3100` | Where the app is served, used for the Composio sign-in redirect |
| `DOTS_DATA_DIR` | `.data/` | Where chats, the password vault, browser profiles and workspaces are kept |

## Good to know

- It's made to run on your own Mac. There's no login screen, so don't put it on a public server as it is.
- Routines and triggers only run while the app is open. A routine that comes due while your Mac is asleep gets skipped, and so do trigger events that arrive then.
- Most triggers fire within seconds. Ones with an Interval setting, like Gmail's, can take up to that many minutes.
- Open models don't get OpenAI's computer tool. They click and type by the text on the page instead, which works on most sites but not on things drawn on a canvas. Voice calls still need an OpenAI key.
- For bookings and purchases, the site needs a card saved in your account there, or you take over for the payment step.
- Open Dot isn't affiliated with OpenAI.

## How it's put together

```
electron/main.mjs      the Mac app: starts the server, opens the window, sends links to your browser
scripts/desktop-*.mjs  packs the Next.js server into the app
src/server/
  agent/runtime.ts     the agent loop: streaming Responses API, a thread per chat,
                       approval cards that pause and resume a run, pause and stop
  agent/tools.ts       the dot's tools and how risky each one is
  agent/review.ts      checks an action against your rules
  agent/prompt.ts      the system prompt, rebuilt every turn from rules, memory, skills and routines
  agent/openrouter.ts  open models through OpenRouter, which keeps no history, so the app keeps it per chat
  agent/opencode.ts    OpenCode Go/Zen discovery plus Responses/Chat Completions adapters
  computer/            one interface over E2B cloud computers, Docker and local folders
  computer/browser.ts  each dot's Chrome profile, computer-use actions, the live view you can take over
  composio.ts          Composio sign-in and app connections
  triggers.ts          Composio triggers and the live stream of their events
  voice.ts             voice calls (OpenAI Realtime)
  vault.ts             the encrypted password store
  scheduler.ts         routines
  repo.ts, db.ts       SQLite (node:sqlite)
src/app/api/events     one stream of live updates to the window
src/lib/store.ts       the window's state, read with useSyncExternalStore
```

The dots use OpenAI's built-in `web_search` and `computer` tools, or OpenRouter's web search on open models. Everything else is a function tool, so any action can go through your rules first.

## Built with

[OpenAI](https://platform.openai.com) (GPT-5.5 through the Responses API, Realtime for voice, computer use), [OpenRouter](https://openrouter.ai) for open models, [Composio](https://composio.dev), [Next.js](https://nextjs.org), [Electron](https://www.electronjs.org), [Playwright](https://playwright.dev) with your installed Chrome, [E2B](https://e2b.dev) and SQLite.
