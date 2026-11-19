# SixStar Lab alert triage: prompt, rules and labelled test set

SixStar Lab watches blockchain contracts and wallets for teams and alerts them when something changes. When an alert
names a transaction, an AI model can add one line to it: a **triage** (a real incident, normal activity, or a person needs
to look), a **severity**, and **one next step**. This folder publishes everything that decides that line, so anyone can
read it, test it, and reuse it.

| File | What it is |
|---|---|
| `prompt.md` | The system prompt, verbatim. |
| `rules.json` | The model and effort, the allowed answers, the nine rules, the answer schema, the first line of the message, and the exact words a team sees for each answer. |
| `testset.jsonl` | Sixteen labelled findings, mostly reconstructed from public incidents of November 2026, with the answers a careful responder would accept. |
| `eval.mjs` | Runs the test set through the prompt and scores it. Node 20 or later, no dependencies. |

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
sets how many verdicts must match (default: all), and `--only T01,T05` runs a subset.

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
