import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { AI, LIMITS, CONDITIONS, NUTRIENTS } from './config.js';
import { analyzeMeal, clientProviders, configRequiresKey, describeProvider, resolveRequestConfig } from './providers.js';

// The site runs even with nothing in .env: visitors can pick a provider, model
// and key in the page's "API settings". Server-side config just provides defaults.
if (AI.hasKey === false && configRequiresKey({ provider: AI.provider, baseUrl: AI.baseUrl })) {
  console.warn(`No server-side API key for "${AI.provider}" (${AI.keyEnv || 'AI_API_KEY'}). Visitors must add their own key in "API settings" on the page.`);
}
if (!AI.baseUrl) {
  console.warn(`No server-side endpoint for "${AI.provider}". Set AI_BASE_URL in .env, or visitors can pick a provider on the page.`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny in-memory cache (swap for Redis if you run several servers).
const cache = new Map();
const cacheGet = (k) => {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.t > LIMITS.cacheTtlMs) { cache.delete(k); return null; }
  return hit.v;
};
const cacheSet = (k, v) => {
  if (cache.size >= LIMITS.cacheMax) cache.delete(cache.keys().next().value);
  cache.set(k, { t: Date.now(), v });
};

const app = express();
app.set('trust proxy', 1); // needed behind Render/Railway/Nginx so rate limits see real IPs
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        // Safari blocks http://localhost when this is on, so only enforce it in production.
        ...(process.env.NODE_ENV === 'production' ? {} : { upgradeInsecureRequests: null }),
      },
    },
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/conditions', (_req, res) => {
  res.json(Object.entries(CONDITIONS).map(([id, c]) => ({ id, label: c.label })));
});

// What the page needs to render its API settings. Never includes a key.
app.get('/api/config', (_req, res) => {
  res.json({ providers: clientProviders(), defaultProvider: AI.provider, defaultModel: AI.model });
});

const limiter = rateLimit({
  windowMs: LIMITS.rateWindowMin * 60 * 1000,
  max: LIMITS.rateMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analyses from your network. Please try again later.' },
});

app.post('/api/analyze', limiter, async (req, res) => {
  const foods = String(req.body?.foods ?? '').trim();
  const ids = [...new Set(Array.isArray(req.body?.conditions) ? req.body.conditions : [])]
    .filter((id) => typeof id === 'string' && Object.hasOwn(CONDITIONS, id))
    .slice(0, LIMITS.maxConditions);

  if (!foods) return res.status(400).json({ error: 'Enter at least one food.' });
  if (foods.length > LIMITS.maxChars) {
    return res.status(400).json({ error: `Keep the food list under ${LIMITS.maxChars} characters.` });
  }

  const cfg = resolveRequestConfig(req.body);
  if (!cfg) return res.status(400).json({ error: 'That provider is not available. Pick one in API settings.' });
  if (!cfg.baseUrl) return res.status(400).json({ error: 'No endpoint is configured for this provider.' });
  if (!cfg.model) return res.status(400).json({ error: 'Choose a model in API settings.' });
  if (!cfg.apiKey && configRequiresKey(cfg)) {
    return res.status(400).json({ error: `Add your ${cfg.provider} API key in API settings to analyze a meal.` });
  }

  // Keyed by provider+model so different models don't reuse each other's answers.
  const key = crypto.createHash('sha256').update(JSON.stringify([cfg.provider, cfg.model, foods.toLowerCase(), [...ids].sort()])).digest('hex');
  const cached = cacheGet(key);
  if (cached) return res.json(cached);

  const conditionText = ids.length
    ? ids.map((id) => `- ${CONDITIONS[id].label}: ${CONDITIONS[id].guidance}`).join('\n')
    : '- None selected: judge against general healthy eating.';

  try {
    const r = await analyzeMeal(cfg, conditionText, foods);

    // Compute totals ourselves so the numbers always add up.
    const totals = Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
    for (const f of r.foods ?? []) for (const k of NUTRIENTS) totals[k] += Number(f[k]) || 0;
    for (const k of NUTRIENTS) totals[k] = Math.round(totals[k] * 10) / 10;

    const result = { ...r, totals, conditions: ids };
    cacheSet(key, result);
    res.json(result);
  } catch (err) {
    console.error('Analyze failed:', err?.status, err?.message);
    if (err?.status === 429 || err?.status === 529) {
      return res.status(503).json({ error: 'The AI service is busy. Please try again in a minute.' });
    }
    if (err?.status === 401 || err?.status === 403) {
      return res.status(401).json({ error: 'That API key was rejected. Check it in API settings.' });
    }
    res.status(502).json({ error: 'Could not analyze this meal right now. Please try again.' });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`NutriPlate running on http://localhost:${port} (${describeProvider()})`));
