/**
 * Document metadata: the author, and an XMP packet derived from it.
 *
 * Chromium writes an information dictionary holding Title, Creator, Producer and
 * two timestamps, and nothing else. Measured on this engine's own output:
 *
 *   /Title        (Ahammed Sahad - Resume)
 *   /Creator      (Mozilla/5.0 ... HeadlessChrome/154.0.0.0 ...)
 *   /Producer     (Skia/PDF m154)
 *   /CreationDate (D:20261005041656+00'00')
 *   /ModDate      (D:20261005041656+00'00')
 *
 * No /Author, no /Subject, and the catalog carries no /Metadata at all, so the
 * file has no XMP packet either. A reader's properties panel shows the document
 * half-populated, and an author the HTML named is lost on the way to PDF.
 *
 * A reader decides where the author has to land. Poppler's pdfinfo reads Author
 * from the information dictionary only: a file whose XMP packet carries
 * `dc:creator` while the dictionary has no /Author reports no author at all. So
 * the dictionary is where it goes, and the packet is a mirror of the dictionary
 * rather than a second source of truth. Generating one from the other is what
 * keeps them from disagreeing, which they do the moment either is written by
 * hand.
 *
 * Nothing here is invented. Title, Creator, Producer and both dates are read back
 * out of the dictionary Chromium wrote. An author is a fact the document states,
 * or a fact the caller supplies; when neither does, none is written.
 */

import { insertIntoDict, join, LATIN1, streamRange, trySplit, type Obj } from "./pdfparts.ts";

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

/**
 * Escape a string for a PDF literal string, `(...)`.
 *
 * The delimiter and the escape character itself come first, because escaping them
 * is what stops the value closing the string early. Then the non-printing range,
 * which a literal string cannot carry raw: the bytes are taken from the octal
 * escape rather than from the document, so they are all below 256.
 */
export function pdfString(value: string): string {
  // Printable ASCII stays a literal string: what Chromium writes, and what every
  // reader handles most directly.
  //
  // Anything else becomes a hex string in UTF-16BE with a byte order mark, and
  // the hex replaces the parentheses rather than going inside them. Three ways
  // this was measured going wrong, each producing a file that opened and a name
  // that was wrong:
  //
  // Octal escapes do not carry the text. Each escape is one PDFDocEncoding byte,
  // so "東京" arrived as four unrelated Latin letters. Measured: `‡0hammed
  // Ç0É6È7 Lanzón š61:54`.
  //
  // Written as `/Author (<FEFF...>)` the angle brackets are literal characters of
  // a literal string, so pdfinfo printed the whole hex out as the author's name.
  //
  // And a hex string with no byte order mark is read as PDFDocEncoding bytes
  // rather than as UTF-8, so "東京" came back as `æš±äº¬`. The mark is what says
  // which encoding the rest of the string is in. Measured against poppler 26.01.
  if ([...value].some((ch) => ch.codePointAt(0)! < 32 || ch.codePointAt(0)! > 126)) {
    // One code unit per iteration, so a character outside the basic plane is
    // written as its surrogate pair rather than half a character.
    let hex = "FEFF";
    for (let i = 0; i < value.length; i++) {
      hex += value.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
    }
    return `<${hex}>`;
  }
  let out = "";
  for (const ch of value) {
    // The delimiter and the escape character come first, because escaping them
    // is what stops the value closing the string early.
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * Escape a string for XML character data or an attribute value.
 *
 * The five entities are the requirement; the control characters matter just as
 * much, because XML 1.0 has no representation for them at all and a bare one
 * makes the packet unparseable rather than merely wrong. They are dropped, since
 * no character in a name is a control character worth keeping.
 */
export function xmlText(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&apos;";
    // Tab, newline and carriage return are legal in XML character data.
    else if (code === 9 || code === 10 || code === 13) out += ch;
    else if (code < 32) continue;
    else out += ch;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading the dictionary Chromium wrote
 * ------------------------------------------------------------------ */

/** The fields of a PDF document information dictionary, as written. */
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

/**
 * Read one `/Key` value from a dictionary body, in either string form.
 *
 * Both forms exist because both are written: Chromium's values are literal
 * strings, and anything needing a character outside PDFDocEncoding is written as
 * a hex string in UTF-16BE with a byte order mark.
 */
function readString(body: string, key: string): string | undefined {
  const asHex = body.match(new RegExp(`/${key}\\s*<([0-9A-Fa-f]+)>`));
  if (asHex) {
    let hex = asHex[1]!;
    // The byte order mark is what distinguishes a UTF-16BE string from a plain
    // byte string, and the name says which encoding the rest is in.
    if (hex.length >= 4 && /^FEFF/i.test(hex)) {
      hex = hex.slice(4);
      let out = "";
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    }
    // Without one it is PDFDocEncoding bytes, which is what Chromium writes.
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
      // Up to three octal digits, which is what the syntax allows.
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? "")) oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else out += next ?? "";
  }
  return out;
}

/** The document information dictionary of a PDF, by following trailer /Info. */
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

/* ------------------------------------------------------------------ *
 * The XMP packet
 * ------------------------------------------------------------------ */

/**
 * Build an XMP packet from the dictionary values.
 *
 * Every field is read out of `info`, so the packet and the dictionary state the
 * same things. The alternative is writing each by hand, and the two drift.
 *
 * `dc:title` and `dc:description` are language alternatives and `dc:creator` is
 * an ordered list, because that is how Dublin Core models them: a title is one
 * value per language rather than a plain string, and an author is a person whose
 * position carries meaning.
 */
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
  // An ISO 8601 date, which is what XMP wants; a PDF date is D:yyyyMMddHHmmSS.
  const iso = (pdfDate?: string) => {
    const m = pdfDate?.match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
    if (!m) return undefined;
    const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = m;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  };

  // The begin marker carries a byte order mark, which is part of the packet's own
// syntax. It has to be written as the actual character and encoded as UTF-8:
// written as the escape `\\ufeff` it is five literal characters, and encoded as
// latin1 it becomes a question mark, since U+FEFF has no latin1 representation.
return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="letterpress">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
${alt("title", info.title)}${alt("description", info.subject)}${bag("creator", info.author)}${bag("subject", info.keywords)}${simple("xmp", "CreatorTool", info.creator)}${simple("pdf", "Producer", info.producer)}${simple("xmp", "CreateDate", iso(info.created))}${simple("xmp", "ModifyDate", iso(info.modified))}</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

/**
 * Replace `/Key` when it is there, add it when it is not.
 *
 * Both string forms are matched, and the replacement uses whichever one
 * `pdfString` produced, so a value that needs hex is not written as a literal.
 */
/**
 * A complete PDF value for `value`, delimiters included.
 *
 * `pdfString` returns the body only, because the two forms differ in where the
 * delimiters go: a hex string's angle brackets are part of the value, while a
 * literal string's parentheses are not. Getting this wrong writes a bare token where
 * a value belongs -- `/Alt fig-1` instead of `/Alt (fig-1)` -- which no structural
 * check objects to and no reader necessarily recovers from, so the rule lives here
 * rather than at each call site.
 */
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

/** Attach `/Metadata N 0 R` to the catalog, or replace the reference it has. */
function setMetadataRef(body: string, num: number): string {
  if (/\/Metadata\s+\d+\s+0\s+R/.test(body)) {
    return body.replace(/\/Metadata\s+\d+\s+0\s+R/, `/Metadata ${num} 0 R`);
  }
  return insertIntoDict(body, `/Metadata ${num} 0 R`);
}

/**
 * Write the author into the dictionary and attach an XMP packet generated from
 * it.
 *
 * Returns the input byte for byte when there is nothing to add: no author was
 * supplied and no packet exists, or the document already carries an author and a
 * packet, which means the caller had a say in both.
 */
export function addMetadata(
  pdf: Uint8Array,
  declared: { author?: string; subject?: string; keywords?: string } = {},
): Uint8Array {
  // Only facts that are actually stated. A document that names no author gets no
  // /Author, rather than one filled in from the title or the file name, because a
  // guessed author is worse than a missing one: it is wrong and it looks right.
  const wanted = {
    Author: declared.author?.trim() || undefined,
    Subject: declared.subject?.trim() || undefined,
    Keywords: declared.keywords?.trim() || undefined,
  };
  const any = Object.values(wanted).some(Boolean);
  const parts = trySplit(pdf);
  if (!parts) return pdf;
  if (!any) return pdf;

  // The keys above are named for the dictionary, where they are /Author and
  // /Subject. The packet names the same two facts differently — dc:creator and
  // dc:description — so they are mapped rather than passed through under the
  // dictionary's spelling. Passing them straight through wrote a packet with no
  // dc:creator in it at all, and pdfinfo reported an author the packet did not
  // contain.
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

  // Chromium's dictionary is one line ending in `>>`; the packet object is
  // numbered after the highest object in the file.
  const next = Math.max(...parts.objs.map((o) => o.num)) + 1;
  const rootRef = trailer.match(/\/Root\s+(\d+)\s+0\s+R/);
  const root = rootRef ? byNum.get(Number(rootRef[1])) : undefined;
  if (!root) return pdf;

  // UTF-8, not latin1. An XMP packet is XML and XML is UTF-8, and the begin
  // marker's byte order mark has no latin1 representation — encoded that way it
  // became a question mark, which is a malformed packet rather than a wrong one.
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

/** Whether a file carries an XMP packet, and what its dc:creator says. */
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
  // Decoded as UTF-8, since that is what the packet is written in. Read as
  // latin1 the same bytes are three characters per code point and the creator
  // name comes back mangled.
  const payload = Buffer.from(stream.bytes.subarray(range.start, range.end)).toString("utf8");
  const creator = payload.match(/<dc:creator>[\s\S]*?<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/)?.[1];
  return { present: true, creator: creator ? unescapeXml(creator) : undefined };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}