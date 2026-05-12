import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AskMessage({ role, content, pending = false }) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex w-full gap-2', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser ? (
        <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground shadow-sm shadow-primary/30">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
      ) : null}
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'rounded-br-sm bg-primary text-primary-foreground shadow-sm shadow-primary/20'
            : 'rounded-bl-sm border border-border/60 bg-card/70 backdrop-blur',
        )}
      >
        {content}
        {pending ? (
          <span className="ml-1 inline-block h-3 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-current opacity-50" />
        ) : null}
      </div>
    </div>
  );
}
