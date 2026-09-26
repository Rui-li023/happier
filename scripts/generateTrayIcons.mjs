/**
 * Generates the desktop tray icons from the vector Happier mark (the same sources as the app
 * icon, `apps/ui/src-tauri/icons/AppIcon.icon/Assets/{HappierBag,HappierSmile}.svg`):
 *
 *   apps/ui/src-tauri/icons/tray/tray-template.png — macOS menu-bar template: black bag with
 *     the smile knocked out (transparent). 36×36 px because tray-icon draws the status-item
 *     image 18 pt tall, so this is its @2x; the glyph is 32 px (16 pt) with 2 px padding.
 *   apps/ui/src-tauri/icons/tray/tray.png — Windows/Linux light trays: full-colour mark
 *     (gradient bag, white smile), 32×32 px full bleed, so edges stay pixel-aligned at 16 and 24 px.
 *   apps/ui/src-tauri/icons/tray/tray-dark.png — Windows/Linux dark trays: the template glyph in
 *     white (smile knocked out), 32×32 px full bleed. The dark bag vanishes on a dark tray.
 *
 * Each PNG is rasterized directly at its final size (librsvg via the repo's `sharp`), no
 * resampling. `apps/ui/src-tauri/src/tray.rs` embeds them with `tauri::include_image!`.
 *
 * Regenerate with:  node scripts/generateTrayIcons.mjs
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(repoRoot, 'apps', 'ui', 'src-tauri', 'icons');
const assetsDir = path.join(iconsDir, 'AppIcon.icon', 'Assets');

// Both source paths are drawn in a 90-unit square (scaled ×11.377778 into a 1024 viewBox).
const MARK_UNITS = 90;

async function readSvg(name) {
  return readFile(path.join(assetsDir, name), 'utf8');
}

function pathData(svg, name) {
  const match = svg.match(/<path[^>]*\sd="([^"]+)"/u);
  if (!match) throw new Error(`No <path d="…"> in ${name}`);
  return match[1];
}

function gradientDef(svg, name) {
  const match = svg.match(/<linearGradient[\s\S]*?<\/linearGradient>/u);
  if (!match) throw new Error(`No <linearGradient> in ${name}`);
  return match[0];
}

/** Places the 90-unit mark `glyphPx` wide, centered in a `canvasPx` square. */
function frame({ canvasPx, glyphPx, defs, body }) {
  const pad = ((canvasPx - glyphPx) / 2) * (MARK_UNITS / glyphPx);
  const box = MARK_UNITS + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasPx}" height="${canvasPx}" viewBox="${-pad} ${-pad} ${box} ${box}"><defs>${defs}</defs>${body}</svg>`;
}

async function main() {
  const bagSvg = await readSvg('HappierBag.svg');
  const smileSvg = await readSvg('HappierSmile.svg');
  const bag = pathData(bagSvg, 'HappierBag.svg');
  const smile = pathData(smileSvg, 'HappierSmile.svg');

  const knockout = `<mask id="knockout" maskUnits="userSpaceOnUse" x="-10" y="-10" width="110" height="110"><rect x="-10" y="-10" width="110" height="110" fill="#fff"/><path fill="#000" d="${smile}"/></mask>`;
  const silhouette = (fill, canvasPx) => frame({
    canvasPx,
    glyphPx: 32,
    defs: knockout,
    body: `<path fill="${fill}" mask="url(#knockout)" d="${bag}"/>`,
  });
  const template = silhouette('#000', 36);
  const dark = silhouette('#FFF', 32);
  const colour = frame({
    canvasPx: 32,
    glyphPx: 32,
    defs: gradientDef(bagSvg, 'HappierBag.svg'),
    body: `<path fill="url(#g)" d="${bag}"/><path fill="#FFFFFF" d="${smile}"/>`,
  });

  const sharp = createRequire(path.join(repoRoot, 'package.json'))('sharp');
  for (const [file, svg] of [['tray-template.png', template], ['tray.png', colour], ['tray-dark.png', dark]]) {
    const out = path.join(iconsDir, 'tray', file);
    // include_image! needs 8-bit RGBA.
    await sharp(Buffer.from(svg)).ensureAlpha().png({ compressionLevel: 9 }).toFile(out);
    console.log(`wrote ${path.relative(repoRoot, out)}`);
  }
}

await main();
