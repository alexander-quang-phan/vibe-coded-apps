import { useState } from 'react';
import { Plus } from 'lucide-react';
import { QuickAddDialog } from '@/components/QuickAddDialog';
import { cn } from '@/lib/utils';

export function QuickAddButton({ currency, className }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Quick add transaction"
        className={cn(
          'fixed bottom-6 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full',
          'bg-primary text-primary-foreground shadow-lg shadow-primary/30 transition-all',
          'hover:scale-105 hover:shadow-xl active:scale-95',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          'safe-bottom sm:bottom-8 sm:right-8 sm:h-16 sm:w-16',
          className,
        )}
      >
        <Plus className="h-7 w-7" strokeWidth={2.5} />
      </button>
      <QuickAddDialog open={open} onOpenChange={setOpen} currency={currency} />
    </>
  );
}
