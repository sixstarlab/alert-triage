#!/usr/bin/env node
// SixStar Lab alert triage: run the labelled test set through the published prompt and score the answers.
//
//   node eval.mjs [--min-verdict N] [--only T01,T02]      (the key in the environment variable ANTHROPIC_API_KEY)
//
// Reads prompt.md, rules.json and testset.jsonl from this folder. Sends each case exactly as the watch sends an alert
// (the same system prompt, the same first line, the same answer schema, model and effort), and prints one line per case
// and a summary. The key is read from the environment and is never printed. Nothing but the model is contacted.
//
// Scoring, per case: VERDICT agrees with the label; SEVERITY is one the label accepts; STEP is one the label accepts.
// UNSAFE counts a case labelled likely_real_incident that the model called likely_benign: the one mistake that could make
// a team stand down, so any UNSAFE answer fails the run.
//
// Exit 0 when UNSAFE is 0 and VERDICT agreement is at least --min-verdict (default: every case); 1 otherwise; 2 when the
// run could not be made (no key, a file missing).
//
// TRIAGE_EVAL_BASE_URL points the run at a local stand-in for a dry run; absent, the Messages API itself.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TRIAGE_EVAL_BASE_URL || 'https://api.anthropic.com';
const VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 60000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}

let system;
let rules;
let cases;
try {
  system = readFileSync(join(HERE, 'prompt.md'), 'utf8').replace(/\n$/, '');
  rules = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));
  cases = readFileSync(join(HERE, 'testset.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
} catch (e) {
  console.error(`eval: a file of this folder did not read: ${e instanceof Error ? e.message : 'unknown'}`);
  process.exit(2);
}
const key = (process.env.ANTHROPIC_API_KEY || '').trim();
if (key === '') {
  console.error('eval: ANTHROPIC_API_KEY is not set');
  process.exit(2);
}
const only = arg('--only');
if (only) {
  const keep = new Set(only.split(','));
  cases = cases.filter((c) => keep.has(c.id));
}
const minVerdict = arg('--min-verdict') === null ? cases.length : Number(arg('--min-verdict'));

async function ask(input) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION, 'anthropic-beta': FALLBACK_BETA },
      body: JSON.stringify({
        model: rules.model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: `${rules.user_prefix}${JSON.stringify(input, null, 2)}` }],
        output_config: { effort: rules.effort, format: { type: 'json_schema', schema: rules.answer_schema } },
        fallbacks: 'default',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, why: 'network', ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (res.status !== 200) return { ok: false, why: `http ${res.status}`, ms };
  const data = await res.json().catch(() => null);
  if (!data || data.stop_reason === 'refusal') return { ok: false, why: data ? 'refusal' : 'bad json', ms };
  const text = (data.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  try {
    return { ok: true, value: JSON.parse(text), ms, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 };
  } catch {
    return { ok: false, why: 'answer not json', ms };
  }
}

let verdicts = 0;
let severities = 0;
let steps = 0;
let unsafe = 0;
let failed = 0;
let inTok = 0;
let outTok = 0;
const times = [];
for (const c of cases) {
  const r = await ask(c.input);
  times.push(r.ms);
  if (!r.ok) {
    failed += 1;
    console.log(`${c.id}  NO ANSWER (${r.why})  ${r.ms} ms`);
    continue;
  }
  inTok += r.inputTokens;
  outTok += r.outputTokens;
  const v = r.value;
  const okV = v.verdict === c.label.verdict;
  const okS = c.label.severity.includes(v.severity);
  const okT = c.label.steps.includes(v.step);
  const bad = c.label.verdict === 'likely_real_incident' && v.verdict === 'likely_benign';
  verdicts += okV ? 1 : 0;
  severities += okS ? 1 : 0;
  steps += okT ? 1 : 0;
  unsafe += bad ? 1 : 0;
  console.log(`${c.id}  ${okV ? 'ok ' : 'NO '} verdict ${v.verdict}  ${okS ? 'ok ' : 'NO '} severity ${v.severity}  ${okT ? 'ok ' : 'NO '} step ${v.step}  rules ${(v.rules || []).join(',')}${bad ? '  UNSAFE' : ''}  ${r.ms} ms`);
}
times.sort((a, b) => a - b);
const n = cases.length;
console.log('');
console.log(`cases ${n}  answered ${n - failed}  verdict ${verdicts}/${n}  severity ${severities}/${n}  step ${steps}/${n}  unsafe ${unsafe}`);
console.log(`time median ${times[Math.floor(times.length / 2)] ?? 0} ms  slowest ${times.at(-1) ?? 0} ms  tokens in ${inTok} out ${outTok}`);
const pass = unsafe === 0 && verdicts >= minVerdict;
console.log(pass ? 'RESULT PASS' : `RESULT FAIL (needs unsafe 0 and verdict at least ${minVerdict})`);
process.exit(pass ? 0 : 1);
