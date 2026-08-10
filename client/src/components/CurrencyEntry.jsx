import { Loader2, TriangleAlert } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/format';
import { currencyOptions, previewConvert } from '@/lib/fx';
import { cn } from '@/lib/utils';

/**
 * Small currency chip beside the amount field. Shows the user's own currency by
 * default, so someone who never leaves the country never thinks about it.
 */
export function CurrencyPicker({ value, base, onChange }) {
  const options = currencyOptions(base);
  const foreign = value !== base;
  return (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">Currency</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'rounded-full border bg-background/40 px-2.5 py-0.5 text-[11px] font-medium transition-colors',
          foreign
            ? 'border-amber-400/50 text-amber-400'
            : 'border-border/70 text-muted-foreground hover:text-foreground',
        )}
      >
        {options.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The "→ £38.52 at 0.85565" line under the amount, with the rate editable.
 *
 * The rate is always editable, not just when the lookup fails: ECB's daily
 * reference rate is not the rate a card actually charges, and Alex may want the
 * real one off his statement.
 */
export function ConversionLine({
  amountStr,
  entryCurrency,
  baseCurrency,
  rate,
  rateState,
  onRateChange,
}) {
  const originalAmount = Number(amountStr);
  const converted = previewConvert({ originalAmount, fxRate: Number(rate), baseCurrency });

  if (rateState === 'loading') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
        Getting today's {entryCurrency}/{baseCurrency} rate…
      </p>
    );
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2">
      {rateState === 'unavailable' ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-400">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>
            No rate available for {entryCurrency}/{baseCurrency} — type the rate you were charged.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-muted-foreground">Rate</span>
        <Input
          type="text"
          inputMode="decimal"
          aria-label={`Exchange rate, ${baseCurrency} per 1 ${entryCurrency}`}
          value={rate}
          onChange={(e) => onRateChange(e.target.value.replace(/[^0-9.]/g, ''))}
          className="h-7 w-28 px-2 text-xs nums"
        />
        <span className="text-muted-foreground">
          {baseCurrency} per 1 {entryCurrency}
        </span>
      </div>

      <p className="text-sm font-semibold">
        {converted === null ? (
          <span className="text-muted-foreground">Enter an amount and a rate</span>
        ) : (
          <>
            <span className="text-muted-foreground">Logs as </span>
            <span className="nums text-foreground">{formatMoney(converted, baseCurrency)}</span>
          </>
        )}
      </p>
    </div>
  );
}
