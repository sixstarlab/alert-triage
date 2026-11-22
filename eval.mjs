#!/usr/bin/env node
// SixStar Lab alert triage: run the labelled test set through the published prompt and score the answers.
//
//   node eval.mjs [--provider anthropic|openai] [--model NAME] [--min-verdict N] [--only T01,T02]
//                 [--price-in USD --price-out USD] [--out results/NAME.json] [--set testset.jsonl]
//
//   anthropic (the default): the key in ANTHROPIC_API_KEY, the model and effort from rules.json unless --model.
//   openai: the key in OPENAI_API_KEY, and --model is required (no default is guessed).
//
// Reads prompt.md, rules.json and the test set from this folder. Sends each case exactly as the watch sends an alert
// (the same system prompt, the same first line, the same answer schema), and prints one line per case and a summary.
// The key is read from the environment and is never printed or written. Nothing but the model's API is contacted.
//
// Scoring, per case: VERDICT agrees with the label; SEVERITY is one the label accepts; STEP is one the label accepts.
// UNSAFE counts a case labelled likely_real_incident that the model called likely_benign: the one mistake that could make
// a team stand down, so any UNSAFE answer fails the run. An answer off the published lists counts as no answer.
//
// COST: --price-in and --price-out are the provider's list prices in US dollars per million input and output tokens,
// typed by whoever runs it (this script carries no price list, as prices change). With both, the summary prints the
// cost of the run and the cost per alert. --out writes the summary as JSON (no key, no answer text), which
// `node scores.mjs` turns into the score table in SCORES.md.
//
// Exit 0 when UNSAFE is 0 and VERDICT agreement is at least --min-verdict (default: 13 of every 16 cases, rounded up, the bar the watch's own
// real-case check uses); 1 otherwise; 2 when the
// run could not be made (no key, a file missing, a bad argument).
//
// TRIAGE_EVAL_BASE_URL points the run at a local stand-in for a dry run (selftest.mjs does this); absent, the provider.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 60000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] ?? null;
}
function stop(why) {
  console.error(`eval: ${why}`);
  process.exit(2);
}

const provider = arg('--provider') ?? 'anthropic';
if (provider !== 'anthropic' && provider !== 'openai') stop('--provider is anthropic or openai');

let system;
let rules;
let cases;
const setFile = arg('--set') ?? 'testset.jsonl';
try {
  system = readFileSync(join(HERE, 'prompt.md'), 'utf8').replace(/\n$/, '');
  rules = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));
  cases = readFileSync(join(HERE, setFile), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
} catch (e) {
  stop(`a file of this folder did not read: ${e instanceof Error ? e.message : 'unknown'}`);
}

const keyName = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
const key = (process.env[keyName] || '').trim();
if (key === '') stop(`${keyName} is not set`);
const model = arg('--model') ?? (provider === 'anthropic' ? rules.model : null);
if (!model) stop('--model is required with --provider openai');

const only = arg('--only');
if (only) {
  const keep = new Set(only.split(','));
  cases = cases.filter((c) => keep.has(c.id));
}
const minVerdict = arg('--min-verdict') === null ? Math.ceil((13 / 16) * cases.length) : Number(arg('--min-verdict'));
const priceIn = arg('--price-in') === null ? null : Number(arg('--price-in'));
const priceOut = arg('--price-out') === null ? null : Number(arg('--price-out'));
if ((priceIn === null) !== (priceOut === null) || [priceIn, priceOut].some((p) => p !== null && !(p >= 0))) stop('give both --price-in and --price-out, in US dollars per million tokens');

const userText = (input) => `${rules.user_prefix}${JSON.stringify(input, null, 2)}`;

async function post(url, headers, body) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, data: res.status === 200 ? parsed : null, error: res.status === 200 ? null : parsed, ms: Date.now() - t0 };
  } catch {
    return { status: 0, data: null, ms: Date.now() - t0 };
  }
}

async function askAnthropic(input) {
  const base = process.env.TRIAGE_EVAL_BASE_URL || 'https://api.anthropic.com';
  const r = await post(
    `${base}/v1/messages`,
    { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    {
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: userText(input) }],
      output_config: { effort: rules.effort, format: { type: 'json_schema', schema: rules.answer_schema } },
      fallbacks: 'default',
    },
  );
  if (r.status !== 200) return { ok: false, why: r.status === 0 ? 'network' : `http ${r.status}`, ms: r.ms };
  const d = r.data;
  if (!d || d.stop_reason === 'refusal') return { ok: false, why: d ? 'refusal' : 'bad json', ms: r.ms };
  const text = (d.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  return { ok: true, text, ms: r.ms, inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 };
}

// OpenAI through the Responses API with a strict json_schema format. A refusal part, a content_filter stop, a cut answer
// (max_output_tokens) and a cyber_policy error are each no answer, and the summary says which.
async function askOpenAi(input) {
  const base = process.env.TRIAGE_EVAL_BASE_URL || 'https://api.openai.com';
  const r = await post(
    `${base}/v1/responses`,
    { authorization: `Bearer ${key}` },
    {
      model,
      max_output_tokens: MAX_TOKENS,
      store: false,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: userText(input) },
      ],
      text: { format: { type: 'json_schema', name: 'triage', strict: true, schema: rules.answer_schema } },
    },
  );
  if (r.status !== 200) {
    const policy = /cyber_policy/.test(JSON.stringify(r.error ?? ''));
    return { ok: false, why: r.status === 0 ? 'network' : policy ? `policy block (http ${r.status})` : `http ${r.status}`, ms: r.ms };
  }
  const d = r.data;
  if (!d) return { ok: false, why: 'bad json', ms: r.ms };
  const usage = { inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 };
  if (d.status === 'incomplete') {
    const why = d.incomplete_details?.reason === 'content_filter' ? 'refusal (content_filter)' : 'cut off (max_output_tokens)';
    return { ok: false, why, ms: r.ms, ...usage };
  }
  const parts = (d.output || []).filter((o) => o && o.type === 'message').flatMap((o) => o.content || []);
  if (parts.some((p) => p && p.type === 'refusal')) return { ok: false, why: 'refusal', ms: r.ms, ...usage };
  const text = parts.filter((p) => p && p.type === 'output_text').map((p) => p.text).join('');
  return { ok: true, text, ms: r.ms, ...usage };
}

const onList = (v) =>
  v && rules.verdicts.includes(v.verdict) && rules.severities.includes(v.severity) && rules.steps.includes(v.step);

async function ask(input) {
  const r = provider === 'openai' ? await askOpenAi(input) : await askAnthropic(input);
  if (!r.ok) return r;
  let value;
  try {
    value = JSON.parse(r.text);
  } catch {
    return { ok: false, why: 'answer not json', ms: r.ms, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  }
  if (!onList(value)) return { ok: false, why: 'answer off the lists', ms: r.ms, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  return { ...r, value };
}

let verdicts = 0;
let severities = 0;
let steps = 0;
let unsafe = 0;
let failed = 0;
let inTok = 0;
let outTok = 0;
const times = [];
const perCase = [];
for (const c of cases) {
  const r = await ask(c.input);
  times.push(r.ms);
  inTok += r.inputTokens ?? 0;
  outTok += r.outputTokens ?? 0;
  if (!r.ok) {
    failed += 1;
    perCase.push({ id: c.id, answered: false, why: r.why, ms: r.ms });
    console.log(`${c.id}  NO ANSWER (${r.why})  ${r.ms} ms`);
    continue;
  }
  const v = r.value;
  const okV = v.verdict === c.label.verdict;
  const okS = c.label.severity.includes(v.severity);
  const okT = c.label.steps.includes(v.step);
  const bad = c.label.verdict === 'likely_real_incident' && v.verdict === 'likely_benign';
  verdicts += okV ? 1 : 0;
  severities += okS ? 1 : 0;
  steps += okT ? 1 : 0;
  unsafe += bad ? 1 : 0;
  perCase.push({ id: c.id, answered: true, verdict: v.verdict, severity: v.severity, step: v.step, okVerdict: okV, okSeverity: okS, okStep: okT, unsafe: bad, ms: r.ms });
  console.log(`${c.id}  ${okV ? 'ok ' : 'NO '} verdict ${v.verdict}  ${okS ? 'ok ' : 'NO '} severity ${v.severity}  ${okT ? 'ok ' : 'NO '} step ${v.step}  rules ${(v.rules || []).join(',')}${bad ? '  UNSAFE' : ''}  ${r.ms} ms`);
}
times.sort((a, b) => a - b);
const n = cases.length;
const median = times[Math.floor(times.length / 2)] ?? 0;
const slowest = times.at(-1) ?? 0;
const cost = priceIn === null ? null : (inTok * priceIn + outTok * priceOut) / 1e6;
console.log('');
console.log(`provider ${provider}  model ${model}  set ${setFile}`);
console.log(`cases ${n}  answered ${n - failed}  verdict ${verdicts}/${n}  severity ${severities}/${n}  step ${steps}/${n}  unsafe ${unsafe}`);
console.log(`time median ${median} ms  slowest ${slowest} ms  tokens in ${inTok} out ${outTok}`);
if (cost !== null) console.log(`cost USD ${cost.toFixed(4)} for the run, ${(cost / Math.max(n, 1)).toFixed(5)} per alert`);
const pass = unsafe === 0 && verdicts >= minVerdict;
console.log(pass ? 'RESULT PASS' : `RESULT FAIL (needs unsafe 0 and verdict at least ${minVerdict})`);

const out = arg('--out');
if (out) {
  const file = join(HERE, out);
  mkdirSync(dirname(file), { recursive: true });
  const summary = {
    provider,
    model,
    set: setFile,
    date: new Date().toISOString(),
    cases: n,
    answered: n - failed,
    verdict: verdicts,
    severity: severities,
    step: steps,
    unsafe,
    medianMs: median,
    slowestMs: slowest,
    tokensIn: inTok,
    tokensOut: outTok,
    priceInPerMillion: priceIn,
    priceOutPerMillion: priceOut,
    costPerAlertUsd: cost === null ? null : cost / Math.max(n, 1),
    pass,
    perCase,
  };
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`wrote ${out}`);
}
process.exit(pass ? 0 : 1);
