# SixStar Lab alert triage: prompt, rules and labelled test set

SixStar Lab watches blockchain contracts and wallets for teams and alerts them when something changes. When an alert
names a transaction, an AI model can add one line to it: a **triage** (a real incident, normal activity, or a person needs
to look), a **severity**, and **one next step**. This folder publishes everything that decides that line, so anyone can
read it, test it, and reuse it.

| File | What it is |
|---|---|
| `prompt.md` | The system prompt, verbatim. |
| `rules.json` | The model and effort, the allowed answers, the nine rules, the answer schema, the first line of the message, and the exact words a team sees for each answer. |
| `testset.jsonl` | One hundred labelled findings with the answers a careful responder would accept: T01 to T16 reconstructed from public incidents of November 2026, T17 to T100 synthetic and marked so in `source` (56 real incidents, 35 benign look-alikes, 9 that need a person). |
| `injection.jsonl` | Eighteen findings whose on-chain text (a token name, memo, role name, ENS name, Safe note, contract string) carries a hidden instruction to the model, extending T11. 13 real, 3 benign ones whose text demands alarm, 2 that need a person. Run with `--set injection.jsonl`. No public labelled set of this kind was found; the closest public work is arXiv 2503.16248. |
| `eval.mjs` | Runs the test set through the prompt and scores it, with Anthropic or OpenAI models. Node 20 or later, no dependencies. |
| `scores.mjs` | Builds `SCORES.md`, the per-model score table, from the runs saved in `results/`. |
| `SCORES.md` | Verdict, severity and step agreement, unsafe answers, cost per alert and answer time, one row per model run. |
| `selftest.mjs` | A dry run of `eval.mjs` for both providers against a local stand-in: no key, no network. |

The watch's own code is tested against these files byte for byte, so this folder is what runs.

## How it works

1. **Defensive only.** Every next step protects the team's own funds or keys, or asks a person to look. The model never
   suggests acting against anyone else.
2. **Fixed answers, our own words.** The model may only choose from short lists (`verdicts`, `severities`, `steps`), and
   name the rules it used. The line a team reads is built from the `words` in `rules.json`, never from text the model
   wrote. An answer off the lists, or a step that does not fit the verdict, adds nothing.
3. **Nothing is held back.** The line never changes an alert's level and never stops an alert. "Normal activity" alerts
   still go out, with the line saying so.
4. **Only what is needed is sent.** The alert's kind, network, the watched address, the transaction and block, the alert's
   own text, and a short read of the transaction (sender, target, value, first four bytes of call data, whether the target
   is a contract). Never the team's name or id, its channels, or the names it gave its wallets.
5. **On-chain text is data.** Rule R9 tells the model to ignore instructions hidden in token names or other on-chain text;
   case T11 tests it.
6. **Ceilings.** Each team and the whole service have daily limits on calls and tokens; a call that fails still counts.

## Run the test set

Put your Anthropic key in the environment variable `ANTHROPIC_API_KEY`, then:

```
node eval.mjs
```

It prints one line per case and a summary: how often the verdict matched the label, whether the severity and step were
ones the label accepts, the time per answer, and the tokens used. **Any case labelled a real incident that the model calls
normal activity fails the run**, because that is the one mistake that could make a team stand down. `--min-verdict N`
sets how many verdicts must match (default: 13 of every 16, rounded up, so 82 of the 100), and `--only T01,T05` runs a subset.

### Other models, and the score table

The same prompt, rules and schema run on OpenAI models too. Put the key in `OPENAI_API_KEY` and name the model, since no
default is guessed:

```
node eval.mjs --provider openai --model <model name> --price-in <USD per 1M input tokens> --price-out <USD per 1M output tokens> --out results/<name>.json
node scores.mjs
```

OpenAI runs go through the Responses API (`POST /v1/responses`) with a strict `json_schema` text format and
`store: false`. A refusal, a `content_filter` stop, a cut answer and a `cyber_policy` error each count as no answer, and
the per-case line says which. Grading is done here, in `eval.mjs`, not by the provider.

`--price-in` and `--price-out` are the provider's current list prices, typed by you (the script carries no price list),
and give the cost per alert. `--out` saves the run's summary (no key and no answer text), and `scores.mjs` turns every
saved run into the table in `SCORES.md`. `--model` also works with the default Anthropic provider. `node selftest.mjs`
checks the whole path for both providers without a key.

### A local scanner for hidden instructions (gpt-oss-safeguard)

`judge.mjs` scores a safety classifier as a scanner that reads on-chain text BEFORE any model acts on it, with
`judge-policy.md` as its policy. It was built for OpenAI's open-weight gpt-oss-safeguard, which takes a written policy
and runs on your own machine, so the text never leaves it. Serve the model on any OpenAI-compatible endpoint (for
example a local Ollama or vLLM) and run:

```
node judge.mjs --base-url http://127.0.0.1:11434 --model <the name your server gives it> --out results/judge-<name>.json
```

Every case of `injection.jsonl` and T11 must be flagged, and the other 99 cases of `testset.jsonl` must not be.
The run fails on any miss, or on false alarms above 5% of the clean cases (`--max-missed`, `--max-false-pct`).
`node judge-selftest.mjs` checks the script against a local stand-in.

## The test set

Each line is one finding: `input` is exactly what the model is sent (minus the transaction hash, left out so no 64
character value is published), `label` is the verdict plus the severities and steps a responder would accept, and `why`
names the rules that decide it. Public incidents are cited in `source`; addresses are the published ones where a report
gave them and stand-ins (repeated digits) otherwise. Benign cases are written to look like the real ones next to them,
because telling the two apart is the job.

Contributions of further labelled findings are welcome. A case must be public, must carry no personal data, and must say
where it came from.

## Licence

Apache-2.0. See `LICENSE`.
