# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It applies an edit an AI model wrote to a tree of text
files, in any of four formats — unified diff, SEARCH/REPLACE blocks, V4A patches, or text-editor tool
calls as JSON — and writes every change or none at all.

## Run it

    node main.ts [options] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree). When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default,
  which detects the format from the patch text).
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly, instead of trying the three matching tiers.

Options and PATCH may come in any order; `--` ends the options.

## What it does

- Finds the lines each edit names at the first of three tiers: exact, ignoring trailing whitespace,
  then ignoring leading and trailing whitespace — and re-indents replacement lines to match the file
  at the loosest tier. Unified hunks are placed at the occurrence nearest their stated line number,
  so wrong line numbers still land right.
- Applies creations, deletions, renames and moves (`R <old> -> <new>`), keeps each file's CRLF or LF
  line breaks and its final line break, and honours `\ No newline at end of file`.
- Prints one line per changed file (`A`, `D`, `M` or `R`) plus `ok: <n> files`, or one
  `error: <code> <path>` line per failed edit plus `failed: <k> of <n> edits`. A failed edit changes
  nothing, the edits after it still run, and when any edit failed no file is written at all.
- Exit codes: 0 applied, 1 some edit failed, 2 usage / unreadable patch / undetected format / parse
  error (`error: parse <N>` names the patch line).

## The files

- `main.ts` — the CLI. Node 22 and its standard library alone, no dependencies.
- `SPEC.md` — the whole specification this tool implements.
- `runner.ts` — the trial runner (kept as the kit has it).
- `check.ts` — runs the 100 public practice checks against `main.ts`:

      node check.ts <practice.json>

## Practice score

100 of 100 practice checks pass.
