import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="top-center"
      richColors
      closeButton
      theme="system"
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
