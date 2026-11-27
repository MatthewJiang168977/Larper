// The offline eval (docs/eval/README.md). From apps/api, after a build:
//
//   node dist/eval/cli.js                     the synthetic fixture, against docs/eval/baseline.json
//   node dist/eval/cli.js --update-baseline   write that baseline (say why in the PR)
//   node dist/eval/cli.js --places FILE       real places (ops/eval-snapshot) against data/golden-places.csv
//
// Writes a report under docs/eval/. Exits 1 on a regression.

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { evaluate, EvalPlace, EvalResult, regressions, report } from './eval';
import { fixture } from './fixture';
import { parseGoldenCsv } from './golden';

const ROOT = join(__dirname, '../../../..');
const OUT = join(ROOT, 'docs/eval');

function main(): void {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  mkdirSync(OUT, { recursive: true });

  const placesFile = arg('--places');
  if (placesFile) {
    const places = JSON.parse(readFileSync(placesFile, 'utf8')) as EvalPlace[];
    const golden = parseGoldenCsv(readFileSync(arg('--golden') ?? join(ROOT, 'data/golden-places.csv'), 'utf8'));
    const day = new Date().toISOString().slice(0, 10);
    const result = evaluate(places, golden);
    const text = report(`Eval on real places, ${day}`, result) + `\n${places.length} places, ${golden.size} rated.\n`;
    writeFileSync(join(OUT, `real-${day}.md`), text);
    console.log(text);
    return;
  }

  const { places, golden } = fixture();
  const result = evaluate(places, golden);
  writeFileSync(join(OUT, 'fixture.md'), report('Eval on the synthetic fixture (not real places)', result));
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(join(OUT, 'baseline.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('baseline written');
    return;
  }
  const baseline = JSON.parse(readFileSync(join(OUT, 'baseline.json'), 'utf8')) as EvalResult;
  const problems = regressions(result, baseline);
  console.log(JSON.stringify(result));
  for (const p of problems) console.error(p);
  if (problems.length) process.exitCode = 1;
}

main();
