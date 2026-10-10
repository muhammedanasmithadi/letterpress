export type TemplateData = Record<string, string | number | string[] | null | undefined>;

export class TemplateError extends Error {
  readonly missing: string[];

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

export class TemplateMissingError extends TemplateError {
  constructor(missing: string[]) {
    super(missing, { missing: true });
    this.name = "TemplateMissingError";
  }
}

const PATTERN = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}|\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g;

export function render(template: string, data: TemplateData, { strict = true } = {}): string {
  const missing = new Set<string>();
  const out = substitute(template, data, missing);
  if (strict && missing.size) throw new TemplateMissingError([...missing]);
  return out;
}

function substitute(template: string, data: TemplateData, missing: Set<string>): string {
  return template.replace(
    PATTERN,
    (whole, blockKey?: string, body?: string, rawKey?: string, textKey?: string) => {
      if (blockKey !== undefined) return data[blockKey] ? substitute(body!, data, missing) : "";
      if (rawKey !== undefined) {
        const raw = data[rawKey];
        if (raw === undefined || raw === null) { missing.add(rawKey); return whole; }

        if (Array.isArray(raw)) return raw.map((v) => String(v)).join("\n    ");
        return String(raw);
      }
      const value = data[textKey!];
      if (value === undefined || value === null) { missing.add(textKey!); return whole; }
      return escapeHtml(String(value));
    },
  );
}

export function money(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export type LineItem = { description: string; qty: number; unit: number };

const UNSAFE_ROW = /<\s*(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b/i;

export class UnsafeRowError extends Error {
  constructor(what: string) {
    super(`line item ${what} contains markup that cannot be rendered safely inside a table row. ` +
      "item fields are inserted as built markup, so a description must be plain text. " +
      "remove the tags, or render your own document instead of using a template.");
    this.name = "UnsafeRowError";
  }
}

export function invoiceTotals(
  items: LineItem[],
  { vatRate = 0.2, currency = "EUR" }: { vatRate?: number; currency?: string } = {},
) {
  if (!Array.isArray(items)) {
    throw new TemplateError(["items"]);
  }
  if (items.length === 0) {

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

export function escapeCss(s: string): string {
  return s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/\n/g, " ");
}

export function lines(items: string[]): string {
  return items.filter(Boolean).map(escapeHtml).join("<br>\n    ");
}
