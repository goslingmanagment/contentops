# contentops

The ContentOps API from the command line, for agents (SPEC §11.2). Every command is a
route of the table in `packages/contracts/src/api/routes`; nothing is written per route.
Runs from a copy of the repo after `pnpm install`, no build:

```sh
pnpm contentops <area> <name> …              # from the repo root
node packages/cli/bin/contentops.mjs …       # from anywhere
```

## Environment

| Variable | Meaning |
|---|---|
| `CONTENTOPS_URL` | server address without `/api/v1`; default `http://127.0.0.1:3000` (`pnpm dev:server`) |
| `CONTENTOPS_TOKEN` | agent token, sent as `Authorization: Bearer` |

## Syntax

```
contentops <area> <name> [--<param> value …] [--body @file.json | --body - | --body '<json>']
           [--json] [--wait [--timeout <s>]] [--if-match N] [--idempotency-key K] [--out <file>]
contentops <area> <name> --help     path params, query keys, body JSON Schema (--json for a machine)
contentops routes [--json]          every route: area.name, method, path; and the aliases
contentops help
```

- Path params and query keys are flags named as in the route: `--model lora --id PPV-073`.
  A query key may repeat (`--tag lace --tag dance`). Any other flag is a usage error.
- `--body`: a file (`@file.json`, relative to where you run it), stdin (`-`) or inline JSON.
- stdout gets only the result JSON: indented, or one line with `--json`. Everything else
  (keys, progress, errors) goes to stderr.
- An API error prints `code: message` to stderr; with `--json` its body
  `{code, message, details?, request_id}` also goes to stdout.
- A route that answers with a file (`media.*`) needs `--out <path>`; stdout gets
  `{file, size_bytes, content_type}`.

## Idempotency and versions

Every changing call sends one `Idempotency-Key` per run and prints it to stderr:
`idempotency-key: 3f0c…`. To repeat the same intent after a lost answer or a network error,
run the command again with `--idempotency-key <that key>`: the server replays the stored
answer instead of applying the change twice. A new key means a new intent.

Changes of a versioned record need `--if-match <version>` (the `version` of the record you
read); a stale one answers 412, a missing one 428.

## Long operations: `--wait`

A 202 answer carries `{kind: "operation", operation_id, status_url}`. Without `--wait` the
command prints it and exits 0. With `--wait` it polls the status address (0.5 s, growing to
5 s), prints progress to stderr and the finished operation to stdout. `--timeout <s>`
(default 600) gives up with exit 2; the work goes on, and repeating the command with the
same `--idempotency-key` (or `contentops operations get … --wait`) follows it again.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success; or accepted (202) without `--wait` |
| 1 | domain error: 400, 404, 409, 412, 422, 428, 429, or a failed operation |
| 2 | access or connection: 401, 403, 5xx, network failure, an answer outside the contract, `--wait` timeout |
| 64 | usage: the command cannot become a request (unknown command or flag, missing param or body, bad JSON) |

## Examples

```sh
export CONTENTOPS_URL=http://127.0.0.1:3000 CONTENTOPS_TOKEN=…

# Read a page's week norm
pnpm contentops plan norm --model lora --account lora-1 --json

# Change it: the version from the read, the body from a file
pnpm contentops plan updateNorm --model lora --account lora-1 --if-match 4 --body @norm.json

# Start a long operation and wait for its result
pnpm contentops admin verifyBlobs --wait --timeout 900 --json

# The routine customs-daily: is there an order for this card? (exit 1 `not_found` — no)
pnpm contentops orders find --model lora --tg https://t.me/c/2627984998/12/9844 --json

# A new card: the order from the card's fields (see `orders create --help` for the body)
pnpm contentops orders create --model lora --body @order.json --json
```

## Aliases

`src/aliases.ts` maps friendly commands onto routes. An alias declares its flags and turns
them into the route's flags and body; it may read other routes first through `context.read`.

| Command | Calls | Flags |
|---|---|---|
| `objects open` | `objects.get` | `--link` — object page link from the interface |
| `orders find` | `orders.get` | `--model`, `--tg` — link to the order card in Telegram, any spelling |

The order's address in other `orders` commands is its `id` from `orders find`
(`--order tg-2627984998-12-9844`).
