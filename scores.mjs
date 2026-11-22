#!/usr/bin/env node
// Builds SCORES.md from every results/*.json that eval.mjs --out wrote: one row per run, newest first.
//
//   node scores.mjs
//
// Columns: provider and model, test set, verdict agreement, severity and step agreement, UNSAFE (a real incident called
// normal activity; must be 0), answered, cost per alert (only when the run was given list prices), median and slowest
// answer time, and the date of the run.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = join(HERE, 'results');
let files = [];
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json'));
} catch {
  files = [];
}
const runs = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))).sort((a, b) => String(b.date).localeCompare(String(a.date)));
const pct = (k, n) => (n === 0 ? '-' : `${k}/${n} (${Math.round((100 * k) / n)}%)`);
const rows = runs.map((r) =>
  [
    `${r.provider} ${r.model}`,
    r.set,
    pct(r.verdict, r.cases),
    pct(r.severity, r.cases),
    pct(r.step, r.cases),
    String(r.unsafe),
    `${r.answered}/${r.cases}`,
    r.costPerAlertUsd === null || r.costPerAlertUsd === undefined ? 'not priced' : `$${r.costPerAlertUsd.toFixed(5)}`,
    `${(r.medianMs / 1000).toFixed(1)} s / ${(r.slowestMs / 1000).toFixed(1)} s`,
    String(r.date).slice(0, 10),
  ].join(' | '),
);
const body = [
  '# Scores',
  '',
  'Every run of `eval.mjs --out results/<name>.json`, newest first, built by `node scores.mjs`. Each row is the same',
  'published prompt, rules and test set sent to a different model. UNSAFE counts a case labelled a real incident that',
  'the model called normal activity, and must be 0. Cost per alert uses the list prices given to that run.',
  '',
  '| model | set | verdict | severity | step | unsafe | answered | cost per alert | median / slowest | date |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r} |`),
  '',
].join('\n');
writeFileSync(join(HERE, 'SCORES.md'), runs.length === 0 ? body.replace('|---|---|---|---|---|---|---|---|---|---|\n', '|---|---|---|---|---|---|---|---|---|---|\n| no runs yet | | | | | | | | | |\n') : body);
console.log(`SCORES.md: ${runs.length} run(s)`);
