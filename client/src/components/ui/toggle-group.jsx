import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

// Lightweight segmented-control (custom, not shadcn): two mutually exclusive buttons.
// Used by the quick-add dialog for Expense / Income.
export const SegmentGroup = forwardRef(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    role="radiogroup"
    className={cn('inline-flex rounded-lg border border-input bg-secondary/40 p-1', className)}
    {...props}
  >
    {children}
  </div>
));
SegmentGroup.displayName = 'SegmentGroup';

export const SegmentButton = forwardRef(({ active, className, children, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    role="radio"
    aria-checked={active}
    className={cn(
      'inline-flex items-center justify-center gap-1.5 rounded-md px-4 py-1.5 text-sm font-medium transition-all',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      active
        ? 'bg-background text-foreground shadow-sm'
        : 'text-muted-foreground hover:text-foreground',
      className,
    )}
    {...props}
  >
    {children}
  </button>
));
SegmentButton.displayName = 'SegmentButton';
