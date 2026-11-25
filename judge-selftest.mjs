#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// judge-selftest.mjs: checks judge.mjs against a local stand-in model, with no key and no network.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const policy = readFileSync(join(HERE, 'judge-policy.md'), 'utf8');
const read = (f) => readFileSync(join(HERE, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const PLANTED = new Set([...read('injection.jsonl'), ...read('testset.jsonl').filter((c) => c.id === 'T11')].map((c) => c.input.alert_text));
const problems = [];
let mode = 'good';
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = JSON.parse(raw);
    if (req.url !== '/v1/chat/completions') problems.push(`path ${req.url}`);
    if (body.messages[0].role !== 'system' || body.messages[0].content !== policy) problems.push('policy not sent as system');
    if (body.model !== 'stand-in-judge') problems.push('model');
    if (req.headers.authorization !== undefined && req.headers.authorization !== 'Bearer k-judge') problems.push('auth');
    const text = body.messages[1].content;
    // The good stand-in flags exactly the planted texts, read from the case files.
    const planted = PLANTED.has(text);
    const flag = mode === 'blind' ? 0 : planted ? 1 : 0;
    const content = mode === 'junk' ? 'maybe' : JSON.stringify({ violation: flag, where: flag ? 'stand-in' : '' });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const run = (args, env = {}) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, 'judge.mjs'), ...args], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });

const results = [];
const good = await run(['--base-url', url, '--model', 'stand-in-judge'], { JUDGE_API_KEY: 'k-judge' });
results.push(['a judge that flags every planted text and nothing else passes', good.code === 0 && good.out.includes('missed 0') && good.out.includes('false alarms 0')]);
results.push(['the key is never printed', !good.out.includes('k-judge')]);
mode = 'blind';
const blind = await run(['--base-url', url, '--model', 'stand-in-judge']);
results.push(['a judge that flags nothing fails', blind.code === 1 && blind.out.includes('missed 19')]);
mode = 'junk';
const junk = await run(['--base-url', url, '--model', 'stand-in-judge', '--only', 'I01,T01']);
results.push(['an answer that is not 0 or 1 is no answer, and a missed plant', junk.code === 1 && junk.out.includes('unanswered 2')]);
results.push(['no --model refuses (exit 2)', (await run(['--base-url', url])).code === 2]);
results.push(['no --base-url refuses (exit 2)', (await run(['--model', 'x'])).code === 2]);
server.close();
results.push(['the stand-in saw the published request shape', problems.length === 0]);
for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (problems.length) console.log(`problems: ${[...new Set(problems)].join(', ')}`);
const all = results.every(([, ok]) => ok);
console.log(all ? 'JUDGE SELFTEST PASS' : 'JUDGE SELFTEST FAIL');
process.exit(all ? 0 : 1);
