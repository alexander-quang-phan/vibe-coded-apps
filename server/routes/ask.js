import { Router } from 'express';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';
import { loadAskContext } from '../lib/askContext.js';
import {
  buildAskSystem,
  ASK_MODEL,
  ASK_MAX_TOKENS,
  ASK_HISTORY_VISIBLE,
  ASK_HISTORY_TO_MODEL,
} from '../lib/askPrompt.js';

const router = Router();

const askSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function sseWrite(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

router.get('/history', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('ask_messages')
      .select('id, role, content, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(ASK_HISTORY_VISIBLE);
    if (error) throw error;
    // Return oldest-first so the client can append in render order.
    res.json({ messages: (data || []).reverse() });
  } catch (err) {
    next(err);
  }
});

router.delete('/history', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('ask_messages')
      .delete()
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Ask Trim is unavailable' });
    }

    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid input', details: parsed.error.flatten() });
    }
    const { message } = parsed.data;

    // Persist the user message first so a crash during streaming still leaves
    // the question in the transcript.
    const { data: userRow, error: userInsErr } = await supabase
      .from('ask_messages')
      .insert({ user_id: req.user.id, role: 'user', content: message })
      .select('id, role, content, created_at')
      .single();
    if (userInsErr) throw userInsErr;

    // Load prior history to send to the model (oldest first, excluding the
    // message we just inserted).
    const { data: priorRows, error: priorErr } = await supabase
      .from('ask_messages')
      .select('role, content, created_at')
      .eq('user_id', req.user.id)
      .lt('created_at', userRow.created_at)
      .order('created_at', { ascending: false })
      .limit(ASK_HISTORY_TO_MODEL);
    if (priorErr) throw priorErr;
    const history = (priorRows || []).reverse();

    const context = await loadAskContext({
      supabase,
      userId: req.user.id,
      today: todayISO(),
    });

    const variant = process.env.ASK_PROMPT_VARIANT === 'cold-open' ? 'cold-open' : 'one-shot';
    const system = buildAskSystem({ context, variant });

    const anthropicMessages = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    sseWrite(res, { type: 'user_message', message: userRow });

    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on('close', onClose);

    const client = new Anthropic({ apiKey });
    let assistantText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreateTokens = 0;

    try {
      const stream = client.messages.stream(
        {
          model: ASK_MODEL,
          max_tokens: ASK_MAX_TOKENS,
          system,
          messages: anthropicMessages,
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          typeof event.delta.text === 'string'
        ) {
          assistantText += event.delta.text;
          sseWrite(res, { type: 'delta', text: event.delta.text });
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? outputTokens;
        } else if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens ?? 0;
          cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
          cacheCreateTokens = event.message.usage.cache_creation_input_tokens ?? 0;
        }
      }
    } catch (streamErr) {
      // Client aborted (page navigated away, tab closed) — quietly stop.
      if (controller.signal.aborted) {
        req.off('close', onClose);
        return;
      }
      console.error('[ask] stream error', streamErr.message);
      sseWrite(res, { type: 'error', message: 'stream_failed' });
      res.end();
      req.off('close', onClose);
      return;
    }

    req.off('close', onClose);

    // Persist the assistant message if we got anything back.
    let assistantRow = null;
    if (assistantText.trim().length > 0) {
      const { data, error } = await supabase
        .from('ask_messages')
        .insert({
          user_id: req.user.id,
          role: 'assistant',
          content: assistantText.slice(0, 8000),
        })
        .select('id, role, content, created_at')
        .single();
      if (error) {
        console.error('[ask] failed to persist assistant message', error.message);
      } else {
        assistantRow = data;
      }
    }

    console.log('[ask]', {
      userId: req.user.id,
      inputTokens,
      cacheReadTokens,
      cacheCreateTokens,
      outputTokens,
      chars: assistantText.length,
    });

    sseWrite(res, {
      type: 'done',
      message: assistantRow,
      usage: { inputTokens, cacheReadTokens, cacheCreateTokens, outputTokens },
    });
    res.end();
  } catch (err) {
    if (res.headersSent) {
      try {
        sseWrite(res, { type: 'error', message: 'request_failed' });
      } catch {
        /* swallow */
      }
      res.end();
      console.error('[ask] handler error', err.message);
    } else {
      next(err);
    }
  }
});

export default router;
