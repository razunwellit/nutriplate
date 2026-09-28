# Setup guide

How to get NutriPlate running locally, and what to do when something goes wrong.

- [1. Prerequisites](#1-prerequisites)
- [2. Install](#2-install)
- [3. Choose how to supply an API key](#3-choose-how-to-supply-an-api-key)
- [4. Getting a key](#4-getting-a-key)
- [5. Run it](#5-run-it)
- [6. Verify it works](#6-verify-it-works)
- [Troubleshooting](#troubleshooting)
- [Common tasks](#common-tasks)
- [Deploying](#deploying)

---

## 1. Prerequisites

- **Node.js 18 or newer** (uses the built-in `fetch`). Check with:

  ```bash
  node -v
  ```

- An API key from **one** provider (or a local model — see [Ollama](#ollama-local-no-key-needed)).

## 2. Install

```bash
git clone https://github.com/razunwellit/nutriplate.git
cd nutriplate
npm install
```

## 3. Choose how to supply an API key

Both options work; pick one.

**Option A — in the browser (default, no setup).**
Start the app, open **API settings** on the page, and enter your provider, model and key. Saved in that browser only; nothing is written to disk or stored on the server. Best for a shared or public deployment where each person uses their own key.

**Option B — on the server (one key for everyone).**
Copy the template and fill it in:

```bash
cp .env.example .env        # Windows: copy .env.example .env
```

```dotenv
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
AI_MODEL=inclusionai/ling-3.0-flash-sante:free
```

Visitors can still override this from **API settings**; `.env` just provides the default.

`.env` is gitignored — never commit it.

## 4. Getting a key

| Provider | Where | Notes |
|---|---|---|
| **OpenRouter** | <https://openrouter.ai/settings/keys> | One key, many models. Has free models — their ids end in `:free`. Easiest start. |
| **Anthropic** | <https://console.anthropic.com> | Direct Claude access. Requires billing credit. |
| **OpenAI** | <https://platform.openai.com/api-keys> | Direct GPT access. |
| **Ollama** | <https://ollama.com> | Runs locally. No key, no cost. |

### Ollama (local, no key needed)

```bash
ollama pull llama3.3
ollama serve
```

Then in **API settings** pick **Ollama (local)**. The server talks to `http://localhost:11434/v1`. No key is required.

> Note: Ollama must be reachable from wherever the Node server runs. If the app is deployed, `localhost` means the *host machine*, not your laptop.

### A note on free models

Free (`:free`) models on OpenRouter are rate-limited and vary in reliability. A model that works well for forced tool calls:

```
inclusionai/ling-3.0-flash-sante:free
```

If a free model returns errors or truncated replies, switch models in **API settings** (or `AI_MODEL` in `.env`).

## 5. Run it

```bash
npm run dev     # development, restarts on file changes
# or
npm start       # plain run
```

Open <http://localhost:3000>.

## 6. Verify it works

1. The health-condition chips (Diabetes, High cholesterol, …) load — this means the page reached the API.
2. Type `2 rotis, 1 cup dal, 1 cup white rice, mango juice`, select **Diabetes**, click **Analyze meal**.
3. You should get a plate score, nutrient totals, and per-food advice.

If the bottom of the **API settings** panel says *"Using this site's … key"*, the server key is in use. *"Using your … key"* means your browser key is in use.

---

## Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| **"Can't reach the server. Make sure it's running, then reload the page."** | The browser couldn't connect — no server at that URL. | Start it with `npm run dev` and open <http://localhost:3000>. Don't open `public/index.html` directly as a file. |
| **"Add your \<provider\> API key in API settings to analyze a meal."** | No key was sent and the server has none either. | Enter a key in **API settings**, or set the matching key in `.env`. |
| **"That API key was rejected. Check it in API settings."** | The provider returned 401/403 — the key is wrong, expired, or for a different provider. | Re-paste the key, and make sure the selected provider matches it. |
| **"The AI service is busy. Please try again in a minute."** | The provider rate-limited the request (429/529). Common on free models. | Wait and retry, or switch to a different model. |
| **"Model returned no structured result. The model ran out of tokens mid-reply…"** | The model produced unusable output (degenerated or truncated). | Pick another model in **API settings**, or raise `AI_MAX_TOKENS` in `.env`. |
| **"That provider is not available. Pick one in API settings."** | The request named an unknown provider. | Choose one of the listed providers. |
| **`EADDRINUSE` on startup** | Port 3000 is already taken. | Stop the other process, or set `PORT=3001` in `.env`. |
| Everything works but numbers look off | These are AI estimates. | Have a dietitian review `config.js`, and consider grounding values against [USDA FoodData Central](https://fdc.nal.usda.gov/api-guide). |

Useful checks:

```bash
curl http://localhost:3000/api/config      # should list the providers
curl http://localhost:3000/api/conditions  # should list the conditions
```

---

## Common tasks

**Change the port**

```dotenv
PORT=4000
```

**Add or edit a health condition** — `config.js`, the `CONDITIONS` object. Each entry has a `label` and a `guidance` sentence passed to the model.

**Add or remove a tracked nutrient** — `config.js`, the `NUTRIENTS` array. The tool schema and the server-side totals both follow from it; the UI needs a matching label in `public/app.js` (`LABELS`).

**Add a provider preset** — `config.js`, the `PROVIDER_PRESETS` object: give it a `label`, `wire`, `baseUrl`, `keyEnv` (or `null` for keyless) and a default `model`.

**Change the tone or scoring** — `config.js`, `SYSTEM_PROMPT`.

**Protect your bill** — `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MIN` in `.env` (defaults: 20 analyses per IP per hour).

## Deploying

1. Set `NODE_ENV=production` on the host.
2. Run `npm start`.
3. Serve over **HTTPS** — a key entered in the browser crosses the wire to your server.
4. Set the provider env vars in the host's dashboard if you want a server-side default; otherwise visitors bring their own key.

Any Node host works (Render, Railway, Fly.io, a VPS). The app needs no database and no build step.
