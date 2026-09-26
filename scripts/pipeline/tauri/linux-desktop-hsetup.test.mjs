import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { extractBundledHsetup } from './linux-desktop-hsetup.mjs';

/** A .deb laid out like the Tauri Linux bundle, carrying `hsetupScript` as the gz resource. */
function buildDeb(root, { hsetupScript, resourceNames = ['hsetup-x86_64-unknown-linux-gnu.gz'] }) {
  const pkg = join(root, 'pkg');
  mkdirSync(join(pkg, 'DEBIAN'), { recursive: true });
  writeFileSync(join(pkg, 'DEBIAN', 'control'), 'Package: happier-test\nVersion: 0.0.1\nArchitecture: amd64\nMaintainer: test <t@example.invalid>\nDescription: test\n');
  const binaries = join(pkg, 'usr', 'lib', 'Happier', 'binaries');
  mkdirSync(binaries, { recursive: true });
  for (const name of resourceNames) writeFileSync(join(binaries, name), gzipSync(Buffer.from(hsetupScript)));
  const deb = join(root, 'happier-test.deb');
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', pkg, deb], { stdio: 'ignore' });
  return deb;
}

const HSETUP = '#!/bin/sh\necho bundled-hsetup\n';

test('extracts and decompresses the bundled hsetup resource from a .deb', () => {
  const root = mkdtempSync(join(tmpdir(), 'hsetup-extract-test-'));
  try {
    const deb = buildDeb(root, { hsetupScript: HSETUP });
    const outFile = join(root, 'out', 'hsetup');
    const extracted = extractBundledHsetup({ artifactPath: deb, outFile });
    assert.equal(extracted.resource, 'usr/lib/Happier/binaries/hsetup-x86_64-unknown-linux-gnu.gz');
    assert.equal(readFileSync(outFile, 'utf8'), HSETUP);
    assert.equal(extracted.hsetupSha256, createHash('sha256').update(HSETUP).digest('hex'));
    // The packaged resource's own size: the app names its materialized copy after it.
    assert.equal(extracted.resourceBytes, gzipSync(Buffer.from(HSETUP)).length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artifact must carry exactly one hsetup resource', () => {
  const root = mkdtempSync(join(tmpdir(), 'hsetup-extract-test-'));
  try {
    const deb = buildDeb(root, { hsetupScript: HSETUP, resourceNames: ['hsetup-a.gz', 'hsetup-b.gz'] });
    assert.throws(() => extractBundledHsetup({ artifactPath: deb, outFile: join(root, 'out', 'hsetup') }), /exactly one/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
