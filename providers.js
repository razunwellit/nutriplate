// Talks to whichever provider a request resolved to. Both wires return the same
// shape, so the rest of the app never needs to know which one is in use.
import Anthropic from '@anthropic-ai/sdk';
import { AI, NUTRIENTS, PROVIDER_PRESETS, SYSTEM_PROMPT } from './config.js';

const TOOL_NAME = 'report_meal_analysis';
const TOOL_DESCRIPTION = 'Report the nutrient analysis and condition-specific advice for the meal.';

const num = { type: 'number' };
const nutrientProps = Object.fromEntries(NUTRIENTS.map((k) => [k, num]));

// Neutral schema, adapted per wire below.
const parameters = {
  type: 'object',
  properties: {
    foods: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amount: { type: 'string', description: 'Amount analyzed, e.g. "1 cup (180 g)"' },
          ...nutrientProps,
          advice: { type: 'string', enum: ['ok', 'reduce', 'avoid'] },
          suggested_portion: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['name', 'amount', ...NUTRIENTS, 'advice', 'suggested_portion', 'note'],
      },
    },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string' },
    tips: { type: 'array', items: { type: 'string' } },
    swaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['foods', 'score', 'verdict', 'tips', 'swaps'],
};

const userMessage = (conditionText, foods) =>
  `Health conditions and guidance:\n${conditionText}\n\n<meal>\n${foods}\n</meal>`;

// Skip temperature entirely when it is unset/blank, since some models reject it.
const withTemperature = (body) =>
  AI.temperature !== undefined && !Number.isNaN(AI.temperature) ? { ...body, temperature: AI.temperature } : body;

const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url || '');
const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

async function viaAnthropicMessages(cfg, conditionText, foods) {
  // The SDK appends /v1/messages, so the base URL must not already carry /v1.
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl.replace(/\/v1$/, '') });
  const msg = await client.messages.create(
    withTemperature({
      model: cfg.model,
      max_tokens: AI.maxTokens,
      system: SYSTEM_PROMPT,
      tools: [{ name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: parameters }],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: userMessage(conditionText, foods) }],
    })
  );
  const block = msg.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('Model returned no structured result');
  return block.input;
}

// Not every OpenAI-compatible endpoint honors forced tool calls, so fall back to
// reading JSON out of the message content. Some models wrap the object in code
// fences or add a stray brace, so scan for the first balanced object that looks
// like an analysis rather than trusting the whole string.
const tryParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const looksLikeResult = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && ('foods' in v || 'verdict' in v || 'score' in v);

function parseJsonLoose(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();

  const direct = tryParse(cleaned);
  if (looksLikeResult(direct)) return direct;

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const parsed = tryParse(cleaned.slice(start, i + 1));
        if (looksLikeResult(parsed)) return parsed;
        break;
      }
    }
  }
  return null;
}

async function viaOpenAICompatible(cfg, conditionText, foods) {
  const url = /\/chat\/completions$/.test(cfg.baseUrl) ? cfg.baseUrl : `${cfg.baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...cfg.headers };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      withTemperature({
        model: cfg.model,
        max_tokens: AI.maxTokens,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage(conditionText, foods) },
        ],
        tools: [{ type: 'function', function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters } }],
        tool_choice: { type: 'function', function: { name: TOOL_NAME } },
      })
    ),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    const err = new Error(`${cfg.provider} responded ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  // Some gateways answer 200 with an error body instead of a failed status.
  if (data.error) {
    const err = new Error(`${cfg.provider} error: ${data.error.message || JSON.stringify(data.error)}`);
    err.status = Number(data.error.code) || res.status;
    throw err;
  }
  const choice = data.choices?.[0];
  const message = choice?.message;
  if (!message) throw new Error(`Provider returned no choices (${JSON.stringify(data).slice(0, 300)})`);

  const args = message.tool_calls?.[0]?.function?.arguments;
  const content = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((p) => p?.text ?? '').join('') : '';
  const parsed = parseJsonLoose(args || content);
  if (!parsed) {
    const truncated = choice.finish_reason === 'length' ? ' The model ran out of tokens mid-reply — try another model (or raise AI_MAX_TOKENS).' : '';
    throw new Error(`Model returned no structured result.${truncated} (${JSON.stringify(message).slice(0, 300)})`);
  }
  return parsed;
}

export function analyzeMeal(cfg, conditionText, foods) {
  return cfg.wire === 'anthropic-messages'
    ? viaAnthropicMessages(cfg, conditionText, foods)
    : viaOpenAICompatible(cfg, conditionText, foods);
}

// Providers a visitor may choose on the page. 'custom' only shows up when the
// operator pointed the server at one, so the browser can never name an endpoint.
export function clientProviders() {
  const list = [];
  for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
    if (id === 'custom' || !p.baseUrl) continue;
    list.push({ id, label: p.label, model: p.model, needsKey: Boolean(p.keyEnv) && !isLocalUrl(p.baseUrl), serverKey: id === AI.provider && AI.hasKey });
  }
  if (AI.provider === 'custom' && AI.baseUrl) {
    list.push({ id: 'custom', label: PROVIDER_PRESETS.custom.label, model: AI.model, needsKey: !isLocalUrl(AI.baseUrl), serverKey: AI.hasKey });
  }
  return list;
}

// A request may carry its own provider/model/key (bring-your-own-key from the
// page). Anything it omits falls back to the server's .env defaults.
export function resolveRequestConfig(body) {
  const reqId = clean(body?.provider);
  const clientKey = clean(body?.apiKey);
  const clientModel = clean(body?.model);

  if (!reqId || reqId === AI.provider) {
    return {
      provider: AI.provider,
      wire: AI.wire,
      baseUrl: AI.baseUrl,
      apiKey: clientKey || AI.apiKey,
      model: clientModel || AI.model,
      headers: AI.headers,
    };
  }

  if (reqId === 'custom') {
    if (AI.provider !== 'custom' || !AI.baseUrl) return null;
    return { provider: 'custom', wire: AI.wire, baseUrl: AI.baseUrl, apiKey: clientKey || AI.apiKey, model: clientModel || AI.model, headers: AI.headers };
  }

  const preset = PROVIDER_PRESETS[reqId];
  if (!preset || !preset.baseUrl) return null;
  return { provider: reqId, wire: preset.wire, baseUrl: preset.baseUrl, apiKey: clientKey, model: clientModel || preset.model, headers: {} };
}

export function configRequiresKey(cfg) {
  return Boolean(PROVIDER_PRESETS[cfg.provider]?.keyEnv) && !isLocalUrl(cfg.baseUrl);
}

export const describeProvider = () => `${AI.provider} · ${AI.wire} · ${AI.model || 'no model'}`;
