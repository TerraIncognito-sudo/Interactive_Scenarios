/**
 * Preflight CLI: `npm run validate [scenariosDir]`
 *
 * Catches broken scenarios at your desk instead of on stage. Checks schema,
 * graph integrity, and that every referenced asset actually exists on disk.
 *
 * Exit code 1 on any error, so it can gate CI or a pre-event checklist.
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
  const arg = process.argv[2];
  const root = arg ? resolve(arg) : loadConfig([]).scenariosDir;

  console.log(`${DIM}Validating scenarios in ${root}${RESET}\n`);

  const { scenarios, failures } = await loadLibrary(root);
  let errorCount = 0;
  let warningCount = 0;

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

    const status = missing.length > 0 ? `${RED}FAIL${RESET}` : `${GREEN}OK${RESET}  `;
    console.log(`${status}  ${id} ${DIM}— "${scenario.title}"${RESET}`);
    console.log(
      `      ${DIM}${nodeCount} nodes · ${pollCount} polls · ${endCount} endings · ` +
        `${assets.length} assets${RESET}`,
    );

    for (const file of missing) {
      errorCount++;
      console.log(`        ${RED}·${RESET} missing asset: assets/${file}`);
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
    `${errorCount} error(s), ${warningCount} warning(s)`;
  console.log(errorCount > 0 ? `${RED}${summary}${RESET}` : `${GREEN}${summary}${RESET}`);

  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}Validator crashed:${RESET}`, err);
  process.exit(1);
});
