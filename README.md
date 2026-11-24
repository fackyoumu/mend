# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fackyoumu/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/fackyoumu/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits to a tree of text files, finding the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, indentation-insensitive) and writing every change or none. It scores 100 of 100 on the bounty's public practice checks.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7snjr28q&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## Notes

Options: `--format=NAME` (unified, search-replace, v4a, json, or auto), `--check` (report without writing) and `--strict` (exact matching only). With no PATCH argument the patch is read from standard input.
