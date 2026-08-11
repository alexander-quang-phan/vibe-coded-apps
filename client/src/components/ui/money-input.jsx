import { forwardRef } from 'react';
import { Input } from '@/components/ui/input';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { decimalsFor } from '@/lib/fx';

// Phase 10 (A1). Money used to be entered through <input type="number">, which
// silently ate decimals: a number input reports '' from .value for any string
// that isn't a complete valid number, so the moment you typed "12." React set
// the state back to "" and the separator vanished. Worse for PLN — the iOS
// decimal key in a pl-PL locale is a COMMA, which type="number" rejects
// outright, making decimals impossible on Alex's phone.
//
// text + inputMode="decimal" gives the same numeric keypad without any of the
// browser's value-coercion, so we own the sanitising and nothing disappears
// mid-keystroke.

// Currencies with no minor unit — formatMoney renders these with
// maximumFractionDigits: 0, so accepting decimals would show a number the user
// can't actually see.
// Imported, not redeclared. This file used to carry its own Set containing only
// VND, while lib/fx.js listed six zero-decimal currencies — so Quick Add would
// happily accept "100.50" in JPY while every conversion downstream rounded JPY
// to whole units. One list, one behaviour.

/**
 * Keep only what can grow into a valid amount. Returns the cleaned string —
 * never a number — so partial input like "12." survives long enough to become
 * "12.5".
 */
export function sanitizeMoneyInput(raw, currency = 'GBP') {
  if (raw === null || raw === undefined) return '';
  // Strip spaces (incl. the non-breaking ones Intl uses as group separators,
  // which show up when a value is pasted straight out of a formatted figure).
  let s = String(raw).replace(/[\s  ]/g, '');
  // One decimal separator, always stored as a dot.
  s = s.replace(/,/g, '.');
  // Drop everything that isn't a digit or a dot.
  s = s.replace(/[^0-9.]/g, '');

  const decimals = decimalsFor(currency);
  if (decimals === 0) return s.replace(/\./g, '');

  // Keep the first dot, drop any later ones ("1.2.3" → "1.23").
  const firstDot = s.indexOf('.');
  if (firstDot !== -1) {
    s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
    const [whole, frac = ''] = s.split('.');
    s = `${whole}.${frac.slice(0, decimals)}`;
  }
  return s;
}

/** The number the rest of the app works with. NaN for anything unusable. */
export function parseMoney(str) {
  if (str === '' || str === null || str === undefined) return NaN;
  return Number(str);
}

/** True when `str` is a positive amount worth submitting. */
export function isValidMoney(str) {
  const n = parseMoney(str);
  return str !== '' && Number.isFinite(n) && n > 0;
}

/** The bare currency symbol, e.g. "£" / "zł" — no digits, no separators. */
export function currencySymbol(currency = 'GBP') {
  return formatMoney(0, currency).replace(/\d|[.,\s  ]/g, '').trim() || '$';
}

/**
 * Money field. Controlled on a STRING, not a number — see the note above.
 *
 *   <MoneyInput value={amountStr} onValueChange={setAmountStr} currency={currency} showSymbol />
 */
export const MoneyInput = forwardRef(function MoneyInput(
  {
    value,
    onValueChange,
    currency = 'GBP',
    showSymbol = false,
    className,
    symbolClassName,
    containerClassName,
    ...props
  },
  ref,
) {
  const field = (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      placeholder={decimalsFor(currency) === 0 ? '0' : '0.00'}
      {...props}
      value={value ?? ''}
      onChange={(e) => onValueChange(sanitizeMoneyInput(e.target.value, currency))}
      className={cn(showSymbol && 'pl-8', className)}
    />
  );

  if (!showSymbol) return field;

  return (
    <div className={cn('relative', containerClassName)}>
      <span
        className={cn(
          'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-base font-semibold text-muted-foreground',
          symbolClassName,
        )}
      >
        {currencySymbol(currency)}
      </span>
      {field}
    </div>
  );
});
