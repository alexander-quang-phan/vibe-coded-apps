import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="top-center"
      richColors
      closeButton
      theme="system"
      // Radix dialogs set pointer-events:none on <body> while open, and sonner
      // renders inside it — without this, a toast's buttons (Quick Add's "Is this
      // your Netflix subscription?") cannot be tapped while any dialog is open.
      style={{ pointerEvents: 'auto' }}
      toastOptions={{
        classNames: {
          toast:
            'group rounded-xl border border-border bg-card text-card-foreground shadow-lg',
          title: 'text-sm font-semibold',
          description: 'text-xs text-muted-foreground',
        },
      }}
    />
  );
}
