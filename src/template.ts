/**
 * Minimal token substitution for templates. No dependency, no logic language:
 * `{{key}}` is replaced, `{{#key}}...{{/key}}` keeps a block only when the value
 * is present, and a token with no value is an error rather than an empty hole.
 * A missing price on an invoice should fail loudly, not print a blank.
 */

export type TemplateData = Record<string, string | number | null | undefined>;

export class TemplateError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`template is missing values for: ${missing.join(", ")}`);
    this.name = "TemplateError";
    this.missing = missing;
  }
}

/** Matches an optional block first, then a raw token, then an escaped token. */
const PATTERN = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}|\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g;

export function render(template: string, data: TemplateData, { strict = true } = {}): string {
  const missing = new Set<string>();
  const out = substitute(template, data, missing);
  if (strict && missing.size) throw new TemplateError([...missing]);
  return out;
}

/**
 * A kept block's body is substituted recursively. String.replace does not
 * rescan the text it just inserted, so a single pass would leave tokens inside
 * a surviving block as literal braces.
 *
 * `{{name}}` escapes, because most values are text somebody typed. `{{{name}}}`
 * passes through untouched, for the few values that are built HTML such as
 * table rows. Escaping everything would print the markup as visible text;
 * escaping nothing would let a customer name close the tag and inject script.
 */
function substitute(template: string, data: TemplateData, missing: Set<string>): string {
  return template.replace(
    PATTERN,
    (whole, blockKey?: string, body?: string, rawKey?: string, textKey?: string) => {
      if (blockKey !== undefined) return data[blockKey] ? substitute(body!, data, missing) : "";
      if (rawKey !== undefined) {
        const raw = data[rawKey];
        if (raw === undefined || raw === null) { missing.add(rawKey); return whole; }
        return String(raw);
      }
      const value = data[textKey!];
      if (value === undefined || value === null) { missing.add(textKey!); return whole; }
      return escapeHtml(String(value));
    },
  );
}

/** Money with thousands separators and fixed decimals, for tabular columns. */
export function money(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export type LineItem = { description: string; qty: number; unit: number };

/** Build the table rows and the totals from line items, so callers never hand-add numbers. */
export function invoiceTotals(
  items: LineItem[],
  { vatRate = 0.2, currency = "EUR" }: { vatRate?: number; currency?: string } = {},
) {
  const rows = items.map((item) => {
    const amount = item.qty * item.unit;
    return {
      ...item,
      amount,
      html: `<tr><td>${escapeHtml(item.description)}</td>` +
        `<td class="num">${item.qty}</td>` +
        `<td class="num">${money(item.unit)}</td>` +
        `<td class="num">${money(amount)}</td></tr>`,
    };
  });
  const subtotal = rows.reduce((sum, r) => sum + r.amount, 0);
  const vat = subtotal * vatRate;
  return {
    rows: rows.map((r) => r.html).join("\n    "),
    subtotal: money(subtotal),
    vat: money(vat),
    total: money(subtotal + vat),
    vat_rate: `${Math.round(vatRate * 100)}%`,
    currency,
    count: rows.length,
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Join address lines into HTML, escaping each one. */
export function lines(items: string[]): string {
  return items.filter(Boolean).map(escapeHtml).join("<br>\n    ");
}