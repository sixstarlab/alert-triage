#!/usr/bin/env node
// A dry run of eval.mjs for both providers against a local stand-in: no key, no network, no cost.
//
//   node selftest.mjs
//
// The stand-in answers each case with its own label, so a correct eval.mjs scores every case and exits 0. It also
// checks what each request carried: the published system prompt, the first line, the answer schema, and the key in the
// provider's own header. A last run answers one case off the lists and must be counted as no answer.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const system = readFileSync(join(HERE, 'prompt.md'), 'utf8').replace(/\n$/, '');
const rules = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8'));
const cases = readFileSync(join(HERE, 'testset.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byInput = new Map(cases.map((c) => [JSON.stringify(c.input), c]));
const KEY = 'k-test';
let offList = false;
const problems = [];

function answerFor(userText) {
  if (!userText.startsWith(rules.user_prefix)) problems.push('first line differs');
  const c = byInput.get(JSON.stringify(JSON.parse(userText.slice(rules.user_prefix.length))));
  if (!c) {
    problems.push('a case the stand-in does not know');
    return { verdict: 'needs_person', severity: 'low', step: 'read_transaction', rules: [] };
  }
  if (offList) return { verdict: 'probably_fine', severity: 'low', step: 'read_transaction', rules: [] };
  return { verdict: c.label.verdict, severity: c.label.severity[0], step: c.label.steps[0], rules: [] };
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    let out;
    if (req.url === '/v1/messages') {
      if (req.headers['x-api-key'] !== KEY) problems.push('anthropic key header');
      if (body.system !== system) problems.push('anthropic system prompt');
      if (JSON.stringify(body.output_config?.format?.schema) !== JSON.stringify(rules.answer_schema)) problems.push('anthropic schema');
      const a = answerFor(body.messages[0].content);
      out = { content: [{ type: 'text', text: JSON.stringify(a) }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 50 } };
    } else if (req.url === '/v1/responses') {
      if (req.headers.authorization !== `Bearer ${KEY}`) problems.push('openai key header');
      if (body.input[0].role !== 'system' || body.input[0].content !== system || body.store !== false) problems.push('openai system prompt');
      const fm = body.text?.format;
      if (fm?.type !== 'json_schema' || fm?.strict !== true || JSON.stringify(fm?.schema) !== JSON.stringify(rules.answer_schema)) problems.push('openai schema');
      if (body.model !== 'stand-in-model') problems.push('openai model');
      const a = answerFor(body.input[1].content);
      out = { status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(a) }] }], usage: { input_tokens: 1000, output_tokens: 50 } };
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  });
});

// The stand-in answers in this process, so each eval runs as a child without blocking it.
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
function evalRun(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, 'eval.mjs'), ...args], { env: { PATH: process.env.PATH, TRIAGE_EVAL_BASE_URL: base, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const results = [];
const a = await evalRun(['--price-in', '1', '--price-out', '1'], { ANTHROPIC_API_KEY: KEY });
results.push(['anthropic scores every case and exits 0', a.code === 0 && a.out.includes(`verdict ${cases.length}/${cases.length}`) && a.out.includes('unsafe 0')]);
const o = await evalRun(['--provider', 'openai', '--model', 'stand-in-model'], { OPENAI_API_KEY: KEY });
results.push(['openai scores every case and exits 0', o.code === 0 && o.out.includes(`verdict ${cases.length}/${cases.length}`) && o.out.includes('unsafe 0')]);
const noModel = await evalRun(['--provider', 'openai'], { OPENAI_API_KEY: KEY });
results.push(['openai without --model refuses (exit 2)', noModel.code === 2]);
const noKey = await evalRun(['--provider', 'openai', '--model', 'stand-in-model'], {});
results.push(['openai without a key refuses (exit 2)', noKey.code === 2]);
offList = true;
const off = await evalRun(['--provider', 'openai', '--model', 'stand-in-model', '--only', cases[0].id], { OPENAI_API_KEY: KEY });
results.push(['an answer off the lists is no answer, and the run fails', off.code === 1 && off.out.includes('answer off the lists')]);
results.push(['no key is printed', ![a, o, off].some((r) => r.out.includes(KEY))]);
server.close();

for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
for (const p of [...new Set(problems)]) console.log(`FAIL  request: ${p}`);
const pass = results.every(([, ok]) => ok) && problems.length === 0;
console.log(pass ? 'SELFTEST PASS' : 'SELFTEST FAIL');
process.exit(pass ? 0 : 1);
