import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 200;

const responseSchema = z.object({
  amount: z.number().finite().nonnegative().max(100_000_000_000),
  currency: z.enum(['GBP', 'USD', 'AUD', 'VND']),
  categoryId: z.string().uuid().nullable(),
  description: z.string().trim().min(1).max(200),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confidence: z.enum(['high', 'medium', 'low']),
});

function buildSystemPrompt({ categories, currency, today }) {
  const list = categories
    .map((c) => `- ${c.id}: ${c.name} (${c.type})`)
    .join('\n');

  return `You convert one natural-language transaction into JSON. Output ONE JSON object and nothing else — no markdown fences, no commentary.

Schema (all keys required):
{
  "amount": number — amount in MINOR units. "12 quid" → 1200, "£4.50" → 450, "12000 dong" → 12000 (VND has no minor units).
  "currency": "GBP" | "USD" | "AUD" | "VND"
  "categoryId": string (UUID from the list below) OR null
  "description": short string (1–5 words) capturing what was bought / received. Lowercase unless it's a proper noun.
  "occurredAt": "YYYY-MM-DD"
  "confidence": "high" | "medium" | "low"
}

Today is ${today}. The user's default currency is ${currency}.

Date resolution — resolve relative phrases against today:
- "today" / "this morning" / "tonight" / no date mentioned → ${today}
- "yesterday" / "last night" → ${today} minus 1 day
- "last Monday" / "last Friday" → most recent past weekday
- explicit dates → that date
If a parsed date would be in the future, fall back to ${today}.

Currency cues:
- "quid", "£", "pence", "p" → GBP
- "$", "bucks", "dollars" → use the user's default (${currency}) unless USD or AUD is explicit
- "₫", "vnd", "dong" → VND
- Any currency outside GBP/USD/AUD/VND, or no cue at all → use the user's default (${currency}).

Categories (use one of these UUIDs, or null if nothing matches well):
${list || '(no categories — return null for categoryId)'}

Confidence:
- "high": the amount is clear, a category clearly matches, description is unambiguous.
- "medium": some ambiguity in category or description, but the amount is clear.
- "low": amount could not be parsed reliably, or the text is too vague / gibberish. When "low", set categoryId to null.

Return ONLY the JSON object.`;
}

function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function parseTransactionText({ text, categories, currency, today }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'unavailable' };
  }

  const client = new Anthropic({ apiKey });

  let raw;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt({ categories, currency, today }),
      messages: [{ role: 'user', content: text }],
    });
    const block = Array.isArray(resp.content) ? resp.content.find((b) => b.type === 'text') : null;
    raw = block?.text ?? '';
  } catch (err) {
    console.error('[parser] anthropic call failed', err.message);
    return { ok: false, reason: 'api_error' };
  }

  const json = extractJson(raw);
  if (!json) return { ok: false, reason: 'parse_error' };

  const validated = responseSchema.safeParse(json);
  if (!validated.success) return { ok: false, reason: 'parse_error' };

  const data = { ...validated.data, amount: Math.round(validated.data.amount) };

  const ownedIds = new Set(categories.map((c) => c.id));
  if (data.categoryId && !ownedIds.has(data.categoryId)) {
    data.categoryId = null;
  }

  if (data.confidence === 'low') {
    data.categoryId = null;
  }

  return { ok: true, data };
}
