#!/usr/bin/env node
/**
 * Read-only Linux artifact review. Never copies, rewrites or approves baselines.
 * Usage: node packages/ui/scripts/compare-customer-goldens.mjs BASELINES ARTIFACT
 * Inputs must come from the same Linux/browser/font configuration. PNG metadata
 * cannot establish the source platform. Changed images require human review.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 2 || args.includes('--help')) {
  process.stderr.write('Usage: node compare-customer-goldens.mjs BASELINES ARTIFACT\n');
  process.exitCode = args.includes('--help') ? 0 : 1;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const requireUi = createRequire(join(root, 'package.json'));
  const requireTest = createRequire(requireUi.resolve('@playwright/test/package.json'));
  const requirePlaywright = createRequire(requireTest.resolve('playwright/package.json'));
  // Reuse the pinned Playwright PNG decoder; no new application dependency.
  const core = dirname(requirePlaywright.resolve('playwright-core/package.json'));
  const { PNG } = requirePlaywright(join(core, 'lib/utilsBundle.js'));
  const baseline = resolve(args[0]);
  const candidate = resolve(args[1]);
  const namePattern =
    /^(390|1440)-(light|dark)-(login|home|profile)(?:-(actual|expected|diff))?\.png$/;
  const normalize = (path) => path.split(sep).join('/');
  async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(path)));
      else if (entry.isFile() && namePattern.test(entry.name)) files.push(path);
    }
    return files.sort();
  }
  async function png(path) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 40_000_000)
      throw new Error('Unsafe or oversized PNG input');
    const bytes = await readFile(path);
    if (
      bytes.length < 24 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 40_000_000
    )
      throw new Error('Invalid or oversized PNG dimensions');
    return { ...PNG.sync.read(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  try {
    const originals = (await walk(baseline)).filter(
      (path) => !/-(actual|expected|diff)\.png$/.test(path)
    );
    const incoming = await walk(candidate);
    if (!originals.length) throw new Error('No 390/1440 customer baselines found');
    const images = [];
    for (const oldPath of originals) {
      const key = normalize(relative(baseline, oldPath));
      const project = key.split('/')[0];
      const baseName = key.split('/').at(-1);
      const exact = incoming.filter((path) => normalize(relative(candidate, path)) === key);
      const matches = exact.length
        ? exact
        : incoming.filter((path) => {
            const parts = normalize(relative(candidate, path)).split('/');
            return (
              parts.some((part) => part === project || part.endsWith('-' + project)) &&
              parts.at(-1) === baseName.replace(/\.png$/, '-actual.png')
            );
          });
      if (matches.length !== 1) {
        images.push({ key, status: matches.length ? 'ambiguous' : 'missing' });
        continue;
      }
      const [oldImage, newImage] = await Promise.all([png(oldPath), png(matches[0])]);
      const width = Math.max(oldImage.width, newImage.width);
      const height = Math.max(oldImage.height, newImage.height);
      let differentPixels = 0;
      let strongDifferencePixels = 0;
      if (oldImage.sha256 !== newImage.sha256) {
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            let delta = 255;
            if (
              x < oldImage.width &&
              y < oldImage.height &&
              x < newImage.width &&
              y < newImage.height
            ) {
              const oldOffset = (y * oldImage.width + x) * 4;
              const newOffset = (y * newImage.width + x) * 4;
              delta = 0;
              for (let channel = 0; channel < 4; channel++)
                delta = Math.max(
                  delta,
                  Math.abs(oldImage.data[oldOffset + channel] - newImage.data[newOffset + channel])
                );
            }
            if (delta) differentPixels++;
            if (delta > 16) strongDifferencePixels++;
          }
      }
      images.push({
        key,
        candidate: normalize(relative(candidate, matches[0])),
        status: differentPixels ? 'review_required' : 'identical',
        before: { width: oldImage.width, height: oldImage.height, sha256: oldImage.sha256 },
        after: { width: newImage.width, height: newImage.height, sha256: newImage.sha256 },
        differentPixels,
        differentPercent: +((100 * differentPixels) / (width * height)).toFixed(4),
        strongDifferencePixels,
      });
    }
    const missing = images.filter((image) =>
      ['missing', 'ambiguous'].includes(image.status)
    ).length;
    process.stdout.write(
      JSON.stringify(
        {
          scope:
            'Read-only comparison; no baseline was updated or approved. Confirm both inputs are Linux artifacts before visual review.',
          expected: originals.length,
          identical: images.filter((image) => image.status === 'identical').length,
          reviewRequired: images.filter((image) => image.status === 'review_required').length,
          missingOrAmbiguous: missing,
          images,
        },
        null,
        2
      ) + '\n'
    );
    if (missing) process.exitCode = 1;
  } catch (error) {
    process.stderr.write('Golden comparison failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
