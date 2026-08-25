/**
 * Preflight CLI: `npm run validate [scenariosDir] [--strict]`
 *
 * Catches broken scenarios at your desk instead of on stage. Checks schema,
 * graph integrity, and that every referenced asset actually exists on disk.
 *
 * Two different questions, deliberately separated:
 *
 *   Is this scenario broken?     dangling `next`, a poll with no default,
 *                                an unknown character. Always an error.
 *   Has the art been made yet?   missing files. A warning by default.
 *
 * They were one question once, and it made the tool unusable while a show was
 * being built: declaring `background: a1-jetty.jpg` before the image existed
 * turned validate red, so authors commented their media out — which left the
 * scenario lying about what it needed, and the editor's asset board empty.
 * Work in progress is not a defect.
 *
 * `--strict` restores the old behaviour and is what a pre-event check should
 * run: on show day, missing art *is* an error.
 *
 * Exit code 1 on any error, so either mode can gate CI or a checklist.
 */

import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadLibrary, assetsOf, ScenarioLoadError } from './load.ts';
import { loadConfig } from '../server/config.ts';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function missingAssets(dir: string, files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    try {
      await access(join(dir, 'assets', file));
    } catch {
      missing.push(file);
    }
  }
  return missing;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const strict = args.includes('--strict');
  const arg = args.find((value) => !value.startsWith('--'));
  const root = arg ? resolve(arg) : loadConfig([]).scenariosDir;

  console.log(
    `${DIM}Validating scenarios in ${root}${strict ? ' (strict: art must exist)' : ''}${RESET}\n`,
  );

  const { scenarios, failures } = await loadLibrary(root);
  let errorCount = 0;
  let warningCount = 0;
  let outstanding = 0;

  for (const failure of failures) {
    errorCount++;
    const err: ScenarioLoadError = failure.error;
    console.log(`${RED}FAIL${RESET}  ${failure.dir}`);
    console.log(`      ${err.message}`);
    for (const problem of err.problems) {
      console.log(`        ${RED}·${RESET} ${problem}`);
    }
    console.log();
  }

  for (const [id, loaded] of scenarios) {
    const { scenario, dir, warnings } = loaded;
    const assets = assetsOf(scenario);
    const missing = await missingAssets(dir, assets);

    const nodeCount = scenario.nodes.length;
    const pollCount = scenario.nodes.filter((n) => n.type === 'poll').length;
    const endCount = scenario.nodes.filter((n) => n.type === 'end').length;

    // The scenario itself is sound at this point — `loadLibrary` collects the
    // structural failures separately. So the only thing that can fail a
    // scenario here is missing art, and only when that has been asked for.
    const failed = strict && missing.length > 0;
    const status = failed ? `${RED}FAIL${RESET}` : `${GREEN}OK${RESET}  `;
    console.log(`${status}  ${id} ${DIM}— "${scenario.title}"${RESET}`);
    console.log(
      `      ${DIM}${nodeCount} nodes · ${pollCount} polls · ${endCount} endings · ` +
        `${assets.length - missing.length}/${assets.length} assets made${RESET}`,
    );

    for (const file of missing) {
      if (strict) {
        errorCount++;
        console.log(`        ${RED}·${RESET} missing asset: assets/${file}`);
      } else {
        outstanding++;
      }
    }

    // Listed as a count rather than a line each: forty "not made yet" entries
    // are a to-do list, and the editor's asset board is where that belongs.
    if (!strict && missing.length > 0) {
      console.log(
        `        ${YELLOW}·${RESET} ${missing.length} asset(s) not made yet ` +
          `${DIM}(--strict to fail on these)${RESET}`,
      );
    }

    for (const warning of warnings) {
      warningCount++;
      const where = warning.nodeId ? `[${warning.nodeId}] ` : '';
      console.log(`        ${YELLOW}·${RESET} ${where}${warning.message}`);
    }
    console.log();
  }

  if (scenarios.size === 0 && failures.length === 0) {
    console.log(`${YELLOW}No scenarios found.${RESET}`);
  }

  const summary =
    `${scenarios.size} scenario(s) loaded, ` +
    `${errorCount} error(s), ${warningCount} warning(s)` +
    (outstanding > 0 ? `, ${outstanding} asset(s) outstanding` : '');
  console.log(errorCount > 0 ? `${RED}${summary}${RESET}` : `${GREEN}${summary}${RESET}`);

  if (outstanding > 0) {
    console.log(
      `${DIM}Run with --strict before a show: outstanding art is an error on the night.${RESET}`,
    );
  }

  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}Validator crashed:${RESET}`, err);
  process.exit(1);
});
