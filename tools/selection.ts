import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Browser } from '../src/browser.ts';
import { wideGaps, type WideGap } from '../src/pageside.ts';
import { render } from '../src/render.ts';
import { textFlow } from '../src/selection.ts';

function collect(target: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let st;
  try {
    st = statSync(target);
  } catch {
    console.error(`no such file or directory: ${target}`);
    return out;
  }
  if (st.isFile()) {
    if (/\.html?$/i.test(target)) out.push(target);
    return out;
  }
  for (const name of readdirSync(target)) {
    if (/^(node_modules|\.git|dist|build)$/.test(name)) continue;
    collect(join(target, name), out, depth + 1);
  }
  return out;
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: bun tools/selection.ts <dir-or-file> ...');
  process.exit(2);
}
const files = targets.flatMap((t) => collect(t.replace(/^~(?=$|\/)/, process.env.HOME!))).sort();

const profile = await mkdtemp(join(tmpdir(), 'letterpress-selection-'));
const browser = await Browser.launch({ profile });

console.log(`\n  ${files.length} document(s)\n`);
let any = false;
for (const file of files) {
  let r;
  try {
    r = await render(browser, {
      path: file,
      author: 'selection',
      allowNetwork: false,
      timeoutMs: 120_000,
      pageProbe: wideGaps,
    });
  } catch (e) {
    console.log(`  ${file}\n       render threw ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  const flow = textFlow(r.pdf);
  const name = file.replace(`${process.env.HOME}/`, '~/');

  if (!flow) {
    console.log(`  ${name}\n       no measurement: nothing in the file has readable advances`);
    any = true;
    continue;
  }

  const html = readFileSync(file, 'utf8');
  const has = (what: string): boolean => new RegExp(`${what}\\s*:`, 'i').test(html);

  const advice: string[] = [];
  if (flow.tooWide > 0) {
    const widest = flow.widest.toFixed(2);
    if (has('text-align') && /text-align\s*:\s*justify/i.test(html)) {
      advice.push(
        `${flow.tooWide} word spaces stretched by text-align:justify, the widest to ` +
          `${widest} em against a browser's 0.6 limit. left, or a longer measure, fixes it.`,
      );
    } else {
      advice.push(
        `${flow.tooWide} gaps over 0.6 em between pieces of text, the widest ${widest} em, ` +
          `and this document does not set text-align:justify -- so these are gaps between ` +
          `blocks or inline items (a flex or grid gap, a margin, a table cell), not a ` +
          `stretched word space.`,
      );
      const gaps = (r.probe as WideGap[] | undefined) ?? [];
      if (gaps.length) {
        for (const g of gaps) {
          const how =
            g.cause === 'flex-gap'
              ? 'a flex gap'
              : g.cause === 'grid-gap'
                ? 'a grid gap'
                : g.cause === 'table-cell'
                  ? 'table cell padding'
                  : g.cause === 'space-between'
                    ? 'justify-content: space-between'
                    : g.cause === 'margin'
                      ? 'a margin'
                      : 'a gap of untraced origin';
          advice.push(
            `${g.em.toFixed(2)} em at ${g.selector}\n           ${how}, next to "${g.text}"`,
          );
        }
      }
    }
  }
  if (flow.tooThin > 0) {
    advice.push(
      `${flow.tooThin} word spaces below 0.1 em` +
        `${has('letter-spacing') ? ', which letter-spacing causes' : ''}.`,
    );
  }
  if (flow.jump > 0) {
    advice.push(
      `${flow.jump} gaps over 3 em between blocks -- table cell padding and column gaps. ` +
        `A reader ends a text item at each, so a table selects one cell at a time.`,
    );
  }
  if (flow.spans > 0) {
    advice.push(
      `${flow.spans} marked-content spans carrying /ActualText survived the repair, because ` +
        `the font does not map their glyphs to the same characters and the span is therefore ` +
        `the only copy of that text. a browser may end a text item at each whatever the ` +
        `spacing, so selection still breaks at these and no CSS can change it. they are not ` +
        `all ligatures.`,
    );
  }
  if (flow.unreadable > 0) {
    advice.push(`${flow.unreadable} glyphs in fonts with no readable advance, so not measured.`);
  }

  if (!advice.length) {
    console.log(
      `  ${name}\n       every word gap is inside the range a browser keeps in one text item`,
    );
    continue;
  }
  any = true;
  console.log(`  ${name}`);
  console.log(
    `       ${flow.read}/${flow.streams} streams read, ${flow.gaps} gaps measured, widest ${flow.widestAll.toFixed(2)} em`,
  );
  for (const line of advice) console.log(`       - ${line}`);
}
await browser.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});
if (!any) console.log('\n  nothing to change');
