import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
type Manifest = {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

describe('the distribution manifest', () => {
  test('the bin entry points at a script bun can run directly', () => {
    expect(manifest.bin?.letterpress).toBeDefined();
    const entry = readFileSync(join(root, manifest.bin!.letterpress!), 'utf8');
    expect(entry.startsWith('#!/usr/bin/env bun')).toBe(true);
  });

  test('the package is registry-publishable and states its runtime', () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.engines?.bun ?? '').toBeTruthy();
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });
});
