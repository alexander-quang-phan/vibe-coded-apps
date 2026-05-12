import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, Sparkles, Trash2 } from 'lucide-react';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AskMessage } from '@/components/AskMessage';
import { toast } from 'sonner';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

const SUGGESTIONS = [
  'How much did I spend on food last month?',
  'Where am I overspending most?',
  'How long until my emergency fund hits its target?',
  "Can I afford a £200 weekend trip?",
];

function ChatSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className={'flex ' + (i % 2 === 0 ? 'justify-start' : 'justify-end')}
        >
          <div className="h-12 w-2/3 animate-pulse rounded-2xl bg-muted/60" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onPick }) {
  return (
    <div className="space-y-4 pt-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground shadow-lg shadow-primary/30">
        <Sparkles className="h-5 w-5 animate-float-slow" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Ask Trim anything</h2>
        <p className="text-sm text-muted-foreground">
          I can see your last 90 days. I'll answer in plain language — no judgement.
        </p>
      </div>
      <div className="mx-auto grid max-w-md gap-2 pt-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-xl border border-border/60 bg-card/70 px-3 py-2 text-left text-sm transition-all hover:border-primary/50 hover:bg-card/90 hover:shadow-sm hover:shadow-primary/10 backdrop-blur"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

async function streamAsk({ token, message, onUserMessage, onDelta, onDone, onError, signal }) {
  let res;
  try {
    res = await fetch(`${API_BASE}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ message }),
      signal,
    });
  } catch (err) {
    if (err.name !== 'AbortError') onError(err.message || 'Network error');
    return;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    onError(body.error || `Ask Trim is unavailable (${res.status})`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    onError('Streaming is not supported in this browser');
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let eol;
      while ((eol = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          let payload;
          try {
            payload = JSON.parse(json);
          } catch {
            continue;
          }
          if (payload.type === 'user_message') onUserMessage(payload.message);
          else if (payload.type === 'delta') onDelta(payload.text);
          else if (payload.type === 'done') onDone(payload);
          else if (payload.type === 'error') onError('Ask Trim hit a snag — try again?');
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') onError(err.message || 'Stream error');
  }
}

export default function Ask() {
  const api = useApi();
  const { session } = useAuth();
  const token = session?.access_token;

  const [messages, setMessages] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  const { data: history, isLoading, isError } = useQuery({
    queryKey: ['ask', 'history'],
    queryFn: () => api.get('/api/ask/history'),
  });

  useEffect(() => {
    if (history && !hydrated) {
      setMessages(history.messages || []);
      setHydrated(true);
    }
  }, [history, hydrated]);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, streaming]);

  // Focus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Abort the stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const canSend = useMemo(() => input.trim().length > 0 && !streaming && !!token, [input, streaming, token]);

  async function handleSend(text) {
    const message = (text ?? input).trim();
    if (!message || streaming || !token) return;

    setInput('');
    setStreaming(true);
    setStreamingText('');

    // Optimistic user bubble — server returns the canonical row on user_message.
    const tempId = `local-${Date.now()}`;
    setMessages((m) => [...m, { id: tempId, role: 'user', content: message, _pending: true }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let assistantText = '';

    await streamAsk({
      token,
      message,
      signal: controller.signal,
      onUserMessage: (row) => {
        // Swap the optimistic bubble for the canonical row from the server.
        setMessages((m) => m.map((x) => (x.id === tempId ? row : x)));
      },
      onDelta: (delta) => {
        assistantText += delta;
        setStreamingText((t) => t + delta);
      },
      onDone: (payload) => {
        if (assistantText.trim().length > 0) {
          const row = payload?.message?.role === 'assistant'
            ? payload.message
            : {
                id: `local-assistant-${Date.now()}`,
                role: 'assistant',
                content: assistantText,
              };
          setMessages((m) => [...m, row]);
        }
        setStreamingText('');
        setStreaming(false);
        abortRef.current = null;
      },
      onError: (msg) => {
        toast.error(msg);
        // Leave the user bubble in place so they can retry; drop the partial assistant text.
        setStreamingText('');
        setStreaming(false);
        abortRef.current = null;
      },
    });
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleClear() {
    if (!confirm('Clear your Ask Trim history? This can\'t be undone.')) return;
    try {
      await api.del('/api/ask/history');
      setMessages([]);
      toast.success('Chat cleared');
    } catch (err) {
      toast.error(err.message || 'Could not clear chat');
    }
  }

  const isEmpty = hydrated && messages.length === 0 && !streaming;

  return (
    <div className="mx-auto flex h-[calc(100vh-9rem)] max-w-2xl flex-col gap-4 pb-2 sm:h-[calc(100vh-11rem)]">
      <header className="flex items-center justify-between gap-3 pt-1">
        <div className="space-y-0.5">
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <span className="text-gradient">Ask Trim</span>
          </h1>
          <p className="text-xs text-muted-foreground">
            Grounded in your last 90 days. Answers only — I won't move money around.
          </p>
        </div>
        {messages.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            aria-label="Clear chat"
            className="text-muted-foreground"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Clear</span>
          </Button>
        ) : null}
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-2xl border border-border/60 bg-background/30 p-4 backdrop-blur"
      >
        {isLoading ? (
          <ChatSkeleton />
        ) : isError ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-center text-sm">
            Couldn't load your chat history. The chat still works — try sending a message.
          </div>
        ) : isEmpty ? (
          <EmptyState onPick={(s) => handleSend(s)} />
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <AskMessage key={m.id} role={m.role} content={m.content} />
            ))}
            {streaming ? (
              <AskMessage
                role="assistant"
                content={streamingText || '…'}
                pending
              />
            ) : null}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
        className="flex items-end gap-2"
      >
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your spending, budgets, or savings goals…"
          disabled={streaming}
          rows={1}
          className="min-h-[44px] resize-none rounded-xl bg-background/60 backdrop-blur"
          maxLength={2000}
        />
        <Button
          type="submit"
          size="icon"
          disabled={!canSend}
          aria-label="Send"
          className="h-11 w-11 rounded-xl"
        >
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}
