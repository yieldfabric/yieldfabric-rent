/**
 * Small display + unit helpers. The first-party app pulls these from a
 * shared `utils/formatters`; the sample inlines the few it needs so it
 * stays self-contained.
 */

/** Human-readable amount with thousands grouping + 2 decimals.
 *  Returns the em-dash sentinel for nullish / non-numeric input (which
 *  `formatHuman` in rentalModel translates to `null`). */
export function formatAmountOnly(value: string | number | null | undefined): string {
  if (value == null) return '—';
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** How many decimal places a `10^n` divisor encodes. Handles the
 *  `'1000000000000000000'` (wei) string form and a numeric `1e18`. */
function decimalsOf(divisor: string | number | null | undefined): number {
  const s = String(divisor ?? '');
  if (/^10*$/.test(s)) return s.length - 1; // '1' → 0, '1000…0' (18 zeros) → 18
  const n = Number(divisor);
  return Number.isFinite(n) && n > 0 ? Math.round(Math.log10(n)) : 18;
}

/** Raw integer (string) scaled down by `decimals` places → human
 *  decimal string. Pure string math (no BigInt) so it works at the
 *  project's ES5 target and never loses precision on large wei values. */
function scaleDown(intStr: string, decimals: number): string {
  const digits = (intStr || '0').replace(/[^0-9]/g, '') || '0';
  if (decimals <= 0) return digits.replace(/^0+(?=\d)/, '');
  const padded = digits.padStart(decimals + 1, '0');
  const cut = padded.length - decimals;
  const intPart = padded.slice(0, cut).replace(/^0+(?=\d)/, '');
  const fracPart = padded.slice(cut).replace(/0+$/, '');
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** A raw on-chain balance (integer string) ÷ its `10^decimals` divisor
 *  → human decimal string. */
export function convertBalanceWithDecimals(
  raw: string | number | null | undefined,
  divisor: string | number | null | undefined
): string {
  return scaleDown(String(raw ?? '0'), decimalsOf(divisor));
}

/** A raw 18-decimal on-chain amount → grouped human string with 2
 *  decimals (e.g. payment amounts, position quantities). */
export function formatRawAmount(raw: string | number | null | undefined): string {
  return formatAmountOnly(convertBalanceWithDecimals(raw, '1000000000000000000'));
}

/** UTC-ISO instant → a LOCAL date string ("1 Jul 2026"). `'N/A'` for
 *  unparseable input. */
export function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'N/A';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}
