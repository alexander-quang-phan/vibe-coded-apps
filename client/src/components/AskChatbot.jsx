import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, Sparkles, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AskMessage } from '@/components/AskMessage';
import { cn } from '@/lib/utils';

const API_BASE = import.meta.env.VITE_API_URL ?? '';

const SUGGESTIONS = [
  'How much did I spend on food last month?',
  'Where am I overspending most?',
  'How long until my emergency fund hits its target?',
  'Can I afford a £200 weekend trip?',
];

function ChatSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className={'flex ' + (i % 2 === 0 ? 'justify-start' : 'justify-end')}
        >
          <div className="h-10 w-2/3 animate-pulse rounded-2xl bg-muted/60" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onPick }) {
  return (
    <div className="space-y-3 pt-2 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground shadow-md shadow-primary/30">
        <Sparkles className="h-4 w-4 animate-float-slow" />
      </div>
      <div className="space-y-0.5">
        <p className="text-sm font-semibold">Ask Trim anything</p>
        <p className="text-xs text-muted-foreground">
          I can see your last 90 days. Plain answers — no judgement.
        </p>
      </div>
      <div className="grid gap-1.5 pt-1">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-lg border border-border/60 bg-card/70 px-3 py-1.5 text-left text-xs transition-all hover:border-primary/50 hover:bg-card/90 hover:shadow-sm hover:shadow-primary/10 backdrop-blur"
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

export function AskChatbot() {
  const api = useApi();
  const { session } = useAuth();
  const token = session?.access_token;

  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const abortRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Lazy-load history only after the user opens the panel once.
  const { data: history, isLoading, isError } = useQuery({
    queryKey: ['ask', 'history'],
    queryFn: () => api.get('/api/ask/history'),
    enabled: isOpen,
  });

  useEffect(() => {
    if (history && !hydrated) {
      setMessages(history.messages || []);
      setHydrated(true);
    }
  }, [history, hydrated]);

  useEffect(() => {
    if (!isOpen) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isOpen, messages, streamingText, streaming]);

  useEffect(() => {
    if (isOpen) {
      // Focus the input shortly after the panel mounts.
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
  }, [isOpen]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !streaming) setIsOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, streaming]);

  // Abort the stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const canSend = useMemo(
    () => input.trim().length > 0 && !streaming && !!token,
    [input, streaming, token],
  );

  async function handleSend(text) {
    const message = (text ?? input).trim();
    if (!message || streaming || !token) return;

    setInput('');
    setStreaming(true);
    setStreamingText('');

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
        setMessages((m) => m.map((x) => (x.id === tempId ? row : x)));
      },
      onDelta: (delta) => {
        assistantText += delta;
        setStreamingText((t) => t + delta);
      },
      onDone: (payload) => {
        if (assistantText.trim().length > 0) {
          const row =
            payload?.message?.role === 'assistant'
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
    if (!confirm("Clear your Ask Trim history? This can't be undone.")) return;
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
    <>
      {/* Floating action button — opens the panel. */}
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-label={isOpen ? 'Close Ask Trim' : 'Open Ask Trim'}
        aria-expanded={isOpen}
        className={cn(
          'fixed bottom-6 left-4 z-40 safe-bottom sm:bottom-8 sm:left-8',
          'group relative flex h-14 w-14 items-center justify-center rounded-full sm:h-16 sm:w-16',
          'bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground',
          'shadow-xl shadow-primary/40 ring-1 ring-white/15 transition-all',
          'hover:scale-[1.06] hover:shadow-2xl hover:shadow-primary/50 active:scale-95',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        {isOpen ? (
          <X className="h-6 w-6 transition-transform" strokeWidth={2.6} />
        ) : (
          <Sparkles
            className="h-6 w-6 transition-transform group-hover:rotate-12"
            strokeWidth={2.4}
          />
        )}
      </button>

      {/* Chat panel — slides up from the bottom-left. */}
      <div
        role="dialog"
        aria-label="Ask Trim chat"
        aria-hidden={!isOpen}
        className={cn(
          'fixed z-40 flex flex-col rounded-2xl border border-border/60 bg-card/95 shadow-2xl shadow-primary/10 backdrop-blur-xl',
          'transition-all duration-200 ease-out',
          // Position: bottom-left on desktop, near-fullscreen on mobile.
          'left-2 right-2 bottom-24 top-20 sm:right-auto sm:top-auto sm:left-8 sm:bottom-28 sm:w-[400px] sm:h-[600px] sm:max-h-[calc(100vh-12rem)]',
          isOpen
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-2 opacity-0',
        )}
      >
        <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground shadow-sm shadow-primary/30">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold">
                <span className="text-gradient">Ask Trim</span>
              </p>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Grounded · answers only
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {messages.length > 0 ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleClear}
                aria-label="Clear chat history"
                className="h-7 w-7 text-muted-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsOpen(false)}
              aria-label="Close Ask Trim"
              className="h-7 w-7"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-3 py-3"
        >
          {isLoading ? (
            <ChatSkeleton />
          ) : isError ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-center text-xs">
              Couldn't load history. The chat still works — try sending something.
            </div>
          ) : isEmpty ? (
            <EmptyState onPick={(s) => handleSend(s)} />
          ) : (
            <div className="space-y-3">
              {messages.map((m) => (
                <AskMessage key={m.id} role={m.role} content={m.content} />
              ))}
              {streaming ? (
                <AskMessage role="assistant" content={streamingText || '…'} pending />
              ) : null}
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-end gap-2 border-t border-border/60 p-3"
        >
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your money…"
            disabled={streaming}
            rows={1}
            className="min-h-[40px] resize-none rounded-xl bg-background/60 text-sm backdrop-blur"
            maxLength={2000}
          />
          <Button
            type="submit"
            size="icon"
            disabled={!canSend}
            aria-label="Send"
            className="h-10 w-10 shrink-0 rounded-xl"
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </>
  );
}
