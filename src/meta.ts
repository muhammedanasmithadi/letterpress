import { insertIntoDict, join, LATIN1, streamRange, trySplit, type Obj } from "./pdfparts.ts";

export function pdfString(value: string): string {

  if ([...value].some((ch) => ch.codePointAt(0)! < 32 || ch.codePointAt(0)! > 126)) {

    let hex = "FEFF";
    for (let i = 0; i < value.length; i++) {
      hex += value.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
    }
    return `<${hex}>`;
  }
  let out = "";
  for (const ch of value) {

    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

export function xmlText(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&apos;";

    else if (code === 9 || code === 10 || code === 13) out += ch;
    else if (code < 32) continue;
    else out += ch;
  }
  return out;
}

export type DocInfo = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  created?: string;
  modified?: string;
};

function readString(body: string, key: string): string | undefined {
  const asHex = body.match(new RegExp(`/${key}\\s*<([0-9A-Fa-f]+)>`));
  if (asHex) {
    let hex = asHex[1]!;

    if (hex.length >= 4 && /^FEFF/i.test(hex)) {
      hex = hex.slice(4);
      let out = "";
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    }

    let out = "";
    for (let i = 0; i + 2 <= hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  }
  const m = body.match(new RegExp(`/${key}\\s*\\(((?:[^()\\\\]|\\\\.)*)\\)`));
  if (!m) return undefined;
  let out = "";
  const raw = m[1]!;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") { out += raw[i]; continue; }
    const next = raw[++i];
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b") out += "\b";
    else if (next === "f") out += "\f";
    else if (next && /[0-7]/.test(next)) {

      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? "")) oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next ?? "";
  }
  return out;
}

export function readDocInfo(pdf: Uint8Array): DocInfo {
  const empty: DocInfo = {};
  const parts = trySplit(pdf);
  if (!parts) return empty;
  const trailer = parts.trailer.toString(LATIN1);
  const ref = trailer.match(/\/Info\s+(\d+)\s+0\s+R/);
  if (!ref) return empty;
  const obj = parts.objs.find((o) => o.num === Number(ref[1]));
  if (!obj) return empty;
  const body = obj.bytes.toString(LATIN1);
  return {
    title: readString(body, "Title"),
    author: readString(body, "Author"),
    subject: readString(body, "Subject"),
    keywords: readString(body, "Keywords"),
    creator: readString(body, "Creator"),
    producer: readString(body, "Producer"),
    created: readString(body, "CreationDate"),
    modified: readString(body, "ModDate"),
  };
}

export function setDocTitle(pdf: Uint8Array, title: string): Uint8Array {
  const parts = trySplit(pdf);
  if (!parts) return pdf;
  const ref = parts.trailer.toString(LATIN1).match(/\/Info\s+(\d+)\s+0\s+R/);
  if (!ref) return pdf;
  const obj = parts.objs.find((o) => o.num === Number(ref[1]));
  if (!obj) return pdf;
  const current = obj.bytes.toString(LATIN1);
  if (readString(current, "Title") === title) return pdf;
  obj.bytes = Buffer.from(setKey(current, "Title", title), LATIN1);
  return new Uint8Array(join(parts.head, parts.objs, parts.trailer));
}

export function isVolatileTitle(title: string): boolean {
  return /^(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\S*|^about:blank$/i.test(title);
}

export function buildXmp(info: DocInfo): string {
  const alt = (tag: string, value?: string) =>
    value === undefined
      ? ""
      : `<dc:${tag}><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(value)}</rdf:li></rdf:Alt></dc:${tag}>\n`;
  const bag = (tag: string, value?: string) =>
    value === undefined
      ? ""
      : `<dc:${tag}><rdf:Bag><rdf:li>${xmlText(value)}</rdf:li></rdf:Bag></dc:${tag}>\n`;
  const simple = (ns: string, tag: string, value?: string) =>
    value === undefined ? "" : `<${ns}:${tag}>${xmlText(value)}</${ns}:${tag}>\n`;

  const iso = (pdfDate?: string) => {
    const m = pdfDate?.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
    if (!m) return undefined;
    const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  };

return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="letterpress">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
${alt("title", info.title)}${alt("description", info.subject)}${bag("creator", info.author)}${bag("subject", info.keywords)}${simple("xmp", "CreatorTool", info.creator)}${simple("pdf", "Producer", info.producer)}${simple("xmp", "CreateDate", iso(info.created))}${simple("xmp", "ModifyDate", iso(info.modified))}</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export function pdfValue(value: string): string {
  const escaped = pdfString(value);
  return escaped.startsWith("<") ? `<${escaped.slice(1, -1)}>` : `(${escaped})`;
}

function setKey(body: string, key: string, value: string): string {
  const asValue = pdfValue(value);
  const either = new RegExp(`/${key}\\s*(?:\\((?:[^()\\\\]|\\\\.)*\\)|<[0-9A-Fa-f]*>)`);
  if (either.test(body)) return body.replace(either, `/${key} ${asValue}`);
  return insertIntoDict(body, `/${key} ${asValue}`);
}

function setMetadataRef(body: string, num: number): string {
  if (/\/Metadata\s+\d+\s+0\s+R/.test(body)) {
    return body.replace(/\/Metadata\s+\d+\s+0\s+R/, `/Metadata ${num} 0 R`);
  }
  return insertIntoDict(body, `/Metadata ${num} 0 R`);
}

export function addMetadata(
  pdf: Uint8Array,
  declared: { author?: string; subject?: string; keywords?: string } = {},
): Uint8Array {

  const wanted = {
    Author: declared.author?.trim() || undefined,
    Subject: declared.subject?.trim() || undefined,
    Keywords: declared.keywords?.trim() || undefined,
  };
  const any = Object.values(wanted).some(Boolean);
  const parts = trySplit(pdf);
  if (!parts) return pdf;
  if (!any) return pdf;

  const packetInfo: DocInfo = {
    ...readDocInfo(pdf),
    author: wanted.Author,
    subject: wanted.Subject,
    keywords: wanted.Keywords,
  };

  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  const trailer = parts.trailer.toString(LATIN1);
  const infoRef = trailer.match(/\/Info\s+(\d+)\s+0\s+R/);
  if (!infoRef) return pdf;
  const infoObj = byNum.get(Number(infoRef[1]));
  if (!infoObj) return pdf;

  const next = Math.max(...parts.objs.map((o) => o.num)) + 1;
  const rootRef = trailer.match(/\/Root\s+(\d+)\s+0\s+R/);
  const root = rootRef ? byNum.get(Number(rootRef[1])) : undefined;
  if (!root) return pdf;

  const packet = Buffer.from(buildXmp(packetInfo), "utf8");
  const metadataObj: Obj = {
    num: next,
    bytes: Buffer.concat([
      Buffer.from(`${next} 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${packet.length} >>\nstream\n`, LATIN1),
      packet,
      Buffer.from("\nendstream\nendobj\n", LATIN1),
    ]),
  };

  const objs = parts.objs.map((o) => {
    if (o.num === infoObj.num) {
      let body = o.bytes.toString(LATIN1);
      for (const [key, value] of Object.entries(wanted)) {
        if (value !== undefined) body = setKey(body, key, value);
      }
      return { num: o.num, bytes: Buffer.from(body, LATIN1) };
    }
    if (o.num === root.num) {
      const body = o.bytes.toString(LATIN1);
      return { num: o.num, bytes: Buffer.from(setMetadataRef(body, next), LATIN1) };
    }
    return o;
  });
  objs.push(metadataObj);
  return join(parts.head, objs, parts.trailer);
}

export function readXmp(pdf: Uint8Array): { present: boolean; creator?: string } {
  const parts = trySplit(pdf);
  if (!parts) return { present: false };
  const byNum = new Map(parts.objs.map((o) => [o.num, o]));
  const rootRef = parts.trailer.toString(LATIN1).match(/\/Root\s+(\d+)\s+0\s+R/);
  const root = rootRef ? byNum.get(Number(rootRef[1])) : undefined;
  if (!root) return { present: false };
  const ref = root.bytes.toString(LATIN1).match(/\/Metadata\s+(\d+)\s+0\s+R/);
  if (!ref) return { present: false };
  const stream = byNum.get(Number(ref[1]));
  if (!stream) return { present: false };
  const range = streamRange(stream.bytes);
  if (!range) return { present: false };

  const payload = Buffer.from(stream.bytes.subarray(range.start, range.end)).toString("utf8");
  const creator = payload.match(/<dc:creator>[\s\S]*?<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/)?.[1];
  return { present: true, creator: creator ? unescapeXml(creator) : undefined };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
