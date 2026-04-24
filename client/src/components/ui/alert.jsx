import { forwardRef } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-lg border p-4 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        info: 'border-primary/40 bg-primary/10 text-foreground',
        warn: 'border-amber-500/40 bg-amber-500/10 text-foreground',
        destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

const Alert = forwardRef(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant, className }))} {...props} />
));
Alert.displayName = 'Alert';

const AlertTitle = forwardRef(({ className, ...props }, ref) => (
  <h5 ref={ref} className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('text-sm text-muted-foreground [&_p]:leading-relaxed', className)} {...props} />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
