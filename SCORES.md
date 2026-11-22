# Scores

Every run of `eval.mjs --out results/<name>.json`, newest first, built by `node scores.mjs`. Each row is the same
published prompt, rules and test set sent to a different model. UNSAFE counts a case labelled a real incident that
the model called normal activity, and must be 0. Cost per alert uses the list prices given to that run.

| model | set | verdict | severity | step | unsafe | answered | cost per alert | median / slowest | date |
|---|---|---|---|---|---|---|---|---|---|
| no runs yet | | | | | | | | | |
