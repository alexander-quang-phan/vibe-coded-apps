import { useState } from 'react';
import { Plus } from 'lucide-react';
import { QuickAddDialog } from '@/components/QuickAddDialog';
import { cn } from '@/lib/utils';

export function QuickAddButton({ currency, simpleMode = false, className }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        className={cn(
          'fixed bottom-6 right-4 z-40 safe-bottom sm:bottom-8 sm:right-8',
          className,
        )}
      >
        {/* Pulsing ring sits beneath the button to draw the eye without nagging */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-primary/40 animate-ring-pulse"
        />
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Quick add transaction"
          className={cn(
            'group relative flex h-14 w-14 items-center justify-center rounded-full sm:h-16 sm:w-16',
            'bg-gradient-to-br from-primary to-emerald-700 text-primary-foreground',
            'shadow-xl shadow-primary/40 ring-1 ring-white/15 transition-all',
            'hover:scale-[1.06] hover:shadow-2xl hover:shadow-primary/50 active:scale-95',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
        >
          <Plus
            className="h-7 w-7 transition-transform duration-300 group-hover:rotate-90"
            strokeWidth={2.6}
          />
        </button>
      </div>
      <QuickAddDialog open={open} onOpenChange={setOpen} currency={currency} simpleMode={simpleMode} />
    </>
  );
}
