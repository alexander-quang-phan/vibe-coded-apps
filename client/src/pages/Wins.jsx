import { WinsFeed } from '@/components/WinsFeed';

export default function Wins() {
  return (
    <div className="space-y-5 pb-12 animate-fade-up">
      <header className="space-y-1">
        <p className="text-sm text-muted-foreground">Every good money moment, collected.</p>
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Wins</h1>
      </header>
      <WinsFeed variant="full" />
    </div>
  );
}
