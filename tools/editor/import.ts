/**
 * Create a project folder from a storyboard.
 *
 *   node tools/editor/import.ts <storyboard.md> <target-folder> ["Title"]
 *
 * For the case the editor cannot help with: a storyboard exists and there is no
 * scenario yet, so there is nothing for the editor to open. It writes a folder
 * holding the storyboard, a scenario scaffolded from its shots, and a project
 * file whose asset rows already carry the storyboard's prompts.
 *
 * Once a folder has a `scenario.yaml`, the editor takes over — point its
 * workspace at the parent folder and it appears in the list.
 *
 * It refuses to touch a folder that already exists. Import is a one-time step:
 * afterwards the project file owns the prompts, and re-running it would
 * overwrite tuning that took weeks.
 */

import { mkdir, readFile, writeFile, stat, copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { scaffoldFromStoryboard } from './scaffold.ts';
import { looksSynced } from './workspace.ts';

const [storyboardPath, targetPath, title] = process.argv.slice(2);

if (!storyboardPath || !targetPath) {
  console.error('usage: node tools/editor/import.ts <storyboard.md> <target-folder> [title]');
  process.exit(2);
}

const target = resolve(targetPath);
const name = basename(target);

if (await stat(target).catch(() => null)) {
  console.error(`${target} already exists. Delete it or choose another folder.`);
  process.exit(1);
}

const source = await readFile(storyboardPath, 'utf8');
const { scenarioYaml, projectYaml, report } = scaffoldFromStoryboard(source, {
  id: name.replaceAll(/[^A-Za-z0-9_-]+/g, '-'),
  title: title ?? name,
});

await mkdir(target, { recursive: true });
await copyFile(storyboardPath, join(target, basename(storyboardPath)));
await writeFile(join(target, 'scenario.yaml'), scenarioYaml, 'utf8');
await writeFile(join(target, 'project.yaml'), projectYaml, 'utf8');

const { counts } = report;
console.log(`\n  Created  ${target}`);
if (looksSynced(target)) {
  console.log('  ! Inside a cloud-synced folder — keep generated takes out of it.');
}
console.log(
  `  Parsed   ${counts.shots} shots · ${counts.scenes} scenes · ` +
    `${counts.characters} characters · ${counts.assets} assets\n`,
);

for (const warning of report.warnings) console.log(`  warn  ${warning}`);

if (report.unplaceable.length > 0) {
  // Not a parser failure. These are prompts the storyboard genuinely contains
  // that today's scenario schema has nowhere to hang, and quietly dropping them
  // would hide most of the visual work from the board.
  console.log(`\n  ${report.unplaceable.length} prompts could not be placed:`);
  for (const item of report.unplaceable.slice(0, 5)) {
    console.log(`    ${item.file} — ${item.why}`);
  }
  if (report.unplaceable.length > 5) {
    console.log(`    …and ${report.unplaceable.length - 5} more`);
  }
}

console.log('');
