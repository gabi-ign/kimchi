# Non-interactive runs

How Kimchi reads a prompt in scripts and CI (`--print`, `--mode json`), and how boolean flags are parsed.

## Prompt sources

A non-interactive run takes its prompt from any of:

- Positional messages: `kimchi --print "summarize this repo"`
- `@file` arguments: `kimchi --print @prompt.md`
- Piped stdin: `echo "summarize this repo" | kimchi --print`

## Boolean flag syntax

Kimchi boolean flags never take a separate value. `--auto`, `--yolo`, `--plan` and the other booleans are on/off switches, so a following token is always a different argument, such as the prompt.

Before pi parses argv, `normalizeBooleanFlagArgs` (`src/cli-args.ts`) rewrites a bare Kimchi-only boolean flag to `--flag=true`. Without this, pi treats the next non-flag token as the flag's value and the positional prompt is lost. Normalization is skipped after `--`.

Both explicit forms are valid. `--flag=true` turns the flag on, and `--flag=false` keeps it off. pi turns any value of a boolean extension flag into `true`, so the normalizer drops `--flag=false` for Kimchi-only booleans before pi sees it. This matters most for `--dangerously-skip-permissions=false`, which would otherwise leave permissions in a mixed state. `--enable-experimental-features` works only in its bare form.

```sh
kimchi --print --auto=true "do the work"
kimchi --print --auto=false "do the work"
kimchi --print --auto "do the work"       # same as --auto=true
kimchi --print "do the work" --auto       # prompt before flags also works
```

## Catalog governance

`CLI_OPTIONS` in `src/cli-args.ts` is the single catalog of Kimchi flags, with their names and types. Every flag an extension registers with `registerFlag` must have a `CLI_OPTIONS` entry with the same name and type. A flag that only extensions know about can be missing from the catalog, and then normalization cannot protect its prompt.

Flags that should parse but not appear in `--help` set `hidden: true` in the catalog.

`src/cli-args.test.ts` enforces this. The "extension flag registration parity" test fails if any `registerFlag` call lacks a matching catalog entry, or its type differs. The flag name must be a string literal or a constant listed in `FLAG_NAME_CONSTANTS` in that test. When you add a flag, add it to `CLI_OPTIONS` in the same change.

## Outcome errors (planned)

This is the planned outcome contract for non-interactive runs, defined by an upcoming non-interactive outcome guard. The boolean-flag change itself does not implement exit 2 or exit 3 handling. Until the guard ships, a run with no prompt or no final answer can still exit `0` with empty output.

The guard only replaces a silent exit `0`. If anything else already set a nonzero code, it does nothing.

| Case | Exit code | stderr prefix |
| --- | ---: | --- |
| No prompt reached the agent | `2` | `KIMCHI_NO_PROMPT:` |
| The agent ran but produced no final answer | `3` | `KIMCHI_NO_RESULT:` |

- Details go to stderr. The first line is the prefix and exit code, followed by what happened, the last important event when one exists, the session file (or that no session was saved), and one next step. Model text is never printed.
- `--mode json` uses the same conditions and exit codes. stdout is unchanged, so JSON consumers keep parsing it line by line.
- "No final answer" follows pi's rule for text mode: the last message in the session has no non-whitespace text.

Example for a missing prompt:

```
KIMCHI_NO_PROMPT: no prompt reached the agent; exiting with code 2.
A flag such as --auto may have taken the prompt as its value.
Put the prompt before the flags, or write the flag as --auto=true.
```

Example for a missing answer:

```
KIMCHI_NO_RESULT: the agent finished without a final answer; exiting with code 3.
Last event: tool "write" was denied (Denied by rule: write).
Session: ~/.config/kimchi/harness/sessions/.../2026-11-24T10-00-00.jsonl
Rerun with --mode json to see every step, or open the session file.
```

Scripts that previously saw exit `0` with empty output will see `2` or `3` once this guard ships.
