/**
 * Downloading a model's files from the terminal.
 *
 * `npm run voice:fetch -- kokoro`
 *
 * The same code the editor's Download button runs. It exists separately
 * because a 340 MB download is a thing you may want to start before making
 * coffee, and because a failure here prints a URL you can try in a browser.
 */

import { downloadModel } from '../app/download.ts';
import { modelById, modelsFor } from '../app/models.ts';
import { loadConfig, modelsRoot } from '../app/workspace.ts';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

async function main(): Promise<number> {
  const id = process.argv[2];
  if (!id || !modelById(id)) {
    const named = modelsFor('voice')
      .filter((model) => model.files?.length)
      .map((model) => model.id);
    console.error(`\n  Usage: npm run voice:fetch -- <model>\n  Downloadable: ${named.join(', ')}\n`);
    return 1;
  }

  await loadConfig();
  const root = modelsRoot();

  let lastLine = '';
  try {
    const result = await downloadModel(id, root, ({ file, received, total }) => {
      const percent = total ? Math.floor((received / total) * 100) : 0;
      const line = `  ${file}  ${percent}%  ${mb(received)}`;
      // Only on a change, and over the top of itself: a progress bar that
      // scrolls is a log, and a log of one download is noise.
      if (line !== lastLine) {
        process.stdout.write(`\r${line.padEnd(60)}`);
        lastLine = line;
      }
    });

    process.stdout.write('\r'.padEnd(62) + '\r');
    console.log(`\n  ${result.model} → ${result.path}`);
    for (const file of result.fetched) console.log(`    fetched  ${file}`);
    for (const file of result.kept) console.log(`    already there  ${file}`);
    console.log(`\n  ${mb(result.bytes)} downloaded. Check it with \`npm run voice:check -- ${id}\`.\n`);
    return 0;
  } catch (err) {
    console.error(`\n  FAILED: ${(err as Error).message}\n`);
    return 1;
  }
}

process.exit(await main());
