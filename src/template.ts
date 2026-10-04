/**
 * Minimal token substitution for templates. No dependency, no logic language:
 * `{{key}}` is replaced, `{{#key}}...{{/key}}` keeps a block only when the value
 * is present, and a token with no value is an error rather than an empty hole.
 * A missing price on an invoice should fail loudly, not print a blank.
 */

export type TemplateData = Record<string, string | number | string[] | null | undefined>;

export class TemplateError extends Error {
  readonly missing: string[];
  /**
   * `problems` are complaints about values that are present but wrong, so they
   * are not all "missing". Prefixing every one of them with "missing values for"
   * produced messages that contradicted themselves, such as
   * "template is missing values for: vat_rate must be a number between 0 and 1".
   */
  constructor(problems: string[], { missing = false } = {}) {
    super(
      problems.length === 1 && !missing
        ? problems[0]
        : `${missing ? "template is missing values for" : "template rejected the data"}: ${problems.join(", ")}`,
    );
    this.name = "TemplateError";
    this.missing = problems;
  }
}

/** A value the template asked for and the data file does not have. */
export class TemplateMissingError extends TemplateError {
  constructor(missing: string[]) {
    super(missing, { missing: true });
    this.name = "TemplateMissingError";
  }
}

/** Matches an optional block first, then a raw token, then an escaped token. */
const PATTERN = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}|\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g;

export function render(template: string, data: TemplateData, { strict = true } = {}): string {
  const missing = new Set<string>();
  const out = substitute(template, data, missing);
  if (strict && missing.size) throw new TemplateMissingError([...missing]);
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
        // A JSON array is the natural way to write "these are my rows", and
        // String() on one joins the elements with commas. That reached the page
        // as a visible "," printed above the table header, on a customer-facing
        // invoice, for every multi-row document.
        if (Array.isArray(raw)) return raw.map((v) => String(v)).join("\n    ");
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

/**
 * Characters that must never survive into a row cell. A description is
 * customer-supplied text, and rows are inserted as built markup because they
 * carry table structure. Without this, a description of
 * `<style>body{display:none}</style>` produces a blank invoice that still
 * reports success, and one containing a script tag hangs the render on the
 * modal dialog the script opens.
 */
const UNSAFE_ROW = /<\s*(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b/i;

export class UnsafeRowError extends Error {
  constructor(what: string) {
    super(`line item ${what} contains markup that cannot be rendered safely inside a table row. ` +
      "item fields are inserted as built markup, so a description must be plain text. " +
      "remove the tags, or render your own document instead of using a template.");
    this.name = "UnsafeRowError";
  }
}

/** Build the table rows and the totals from line items, so callers never hand-add numbers. */
export function invoiceTotals(
  items: LineItem[],
  { vatRate = 0.2, currency = "EUR" }: { vatRate?: number; currency?: string } = {},
) {
  if (!Array.isArray(items)) {
    throw new TemplateError(["items"]);
  }
  if (items.length === 0) {
    // An empty invoice that still prints a total is worse than no invoice: the
    // totals below would be carried over from data rather than computed, and the
    // result looks legitimate.
    throw new TemplateError(["items (the array is empty, so there is nothing to total)"]);
  }
  const rows = items.map((item, i) => {
    if (item.description && UNSAFE_ROW.test(item.description)) {
      throw new UnsafeRowError(`#${i + 1} ("${item.description.slice(0, 40)}")`);
    }
    if (!Number.isFinite(item.qty) || !Number.isFinite(item.unit)) {
      throw new TemplateError([`items[${i}].qty and items[${i}].unit must be numbers`]);
    }
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
  if (!Number.isFinite(vatRate) || vatRate < 0) {
    throw new TemplateError(["vat_rate must be a number, for example 0.21"]);
  }
  return {
    rows: rows.map((r) => r.html).join("\n    "),
    // Raw numbers alongside the formatted strings. A caller comparing a
    // supplied total against a formatted "3,383,428.75" gets NaN, and every
    // NaN comparison is false, so the check silently never fires.
    subtotalValue: subtotal,
    vatValue: vat,
    totalValue: subtotal + vat,
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

/**
 * Escape for a CSS string, which does not decode HTML entities. Using the HTML
 * escaper here printed a literal "&amp;" in the running header of every page,
 * because the entity arrived inside a @page margin box where nothing decodes it.
 */
export function escapeCss(s: string): string {
  return s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, " ");
}

/** Join address lines into HTML, escaping each one. */
export function lines(items: string[]): string {
  return items.filter(Boolean).map(escapeHtml).join("<br>\n    ");
}