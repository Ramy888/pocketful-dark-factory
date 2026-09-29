# Pocketful stage-1 acceptance suite

An executable acceptance suite for `spec/stage-1.md`. It drives a **running container over
HTTP only** — it never imports, reads or executes the service's source, and never inspects
its storage.

## Running it

```sh
# start the image however RUN.md says, on any port, then:
BASE_URL=http://127.0.0.1:8080 ./run.sh

# skip the slow concurrency checks while iterating
BASE_URL=http://127.0.0.1:8080 ./run.sh --fast

# run one area
BASE_URL=http://127.0.0.1:8080 ./run.sh --only "idempotency"

# list every check with the references it verifies
./run.sh --list

# regenerate COVERAGE.md
node main.mjs --coverage > COVERAGE.md
```

- `BASE_URL` defaults to `http://127.0.0.1:8080`, so the suite points at any container on
  any port.
- `ALT_BASE_URL`, if set, must be a **second, independently started** container. It is used
  only to exercise R10.6 — that an export carries no dependency on its source process, port
  or address. Without it, that reference is reported as exercised only within one container.
- Requirements: **Node 18 or newer, nothing else.** No packages, no install step.
- The suite talks HTTP and nothing else, so it runs unchanged against a container started
  with `--network none`.
- Exit code is `0` only if every blocking check passed. Advisory failures never change it.
- Full run: a few minutes. `--fast` drops the eleven slow concurrency checks.

## What it does and does not decide

Every check cites the specification reference it verifies, and every reference is accounted
for in [COVERAGE.md](COVERAGE.md), which is **generated from the suite itself** — a
requirement with no check shows up there as a gap that must carry a reason.

Checks come in two severities:

- **blocking** — the specification text settles the answer. A failure here is a defect.
- **advisory** — the specification does not settle the answer. The check records what the
  service did, states in the failure output exactly which part of the reading is undecided,
  and never affects the exit code. Most advisory checks test a coordinator interpretation
  (a `D` reference); the rest test one of several defensible readings of a sentence.

That split is deliberate. A suite that rejects a service for choosing a different
defensible reading of an underspecified sentence is testing its author's opinions, not the
specification.

## How scenarios are built

Every check begins by resetting the service with a fixture from `fixtures/` through
`POST /_test/reset`, then drives the public API. Nothing is set up by reaching into the
service, and no check depends on state left by another — the suites run sequentially against
one shared service, and each check establishes its own state.

## Reading a failure

Each failure prints the specification reference, what was expected, what actually happened,
a `curl` that reproduces the failing call, and the full `curl` trail of the scenario that
led to it. Run the trail from the repository root and the fixture paths resolve:

```
[3] BLOCKING  spec ref R8.6
    check     04 payments :: paying your own handle is 422 self_payment
    subject   POST /payments to the caller own handle
    expected  HTTP 422 with error.code "self_payment"
    actual    HTTP 409 with error.code "insufficient_funds"; body: ...
    reproduce curl -sS -i 'http://127.0.0.1:8080/payments' -H '...' --data-binary '...'
    ---- full request trail for this check ----
      curl -sS -i -X POST '.../_test/reset' --data-binary @stage-1/acceptance/fixtures/eur.json   # -> 204
      curl -sS -i -X POST '.../auth/login' --data-binary '{...}'                                  # -> 200
      curl -sS -i -X POST '.../payments' ...                                                      # -> 409
```

## Layout

| path | what |
|---|---|
| `run.sh` | entrypoint; checks the Node version and waits for `/health` |
| `main.mjs` | registers the checks, waits for health, runs, reports; also `--list` and `--coverage` |
| `lib/http.mjs` | raw `node:http` client, so the suite can send unparseable bodies and odd headers |
| `lib/runner.mjs` | the registry, the per-check context, the global response invariants, the report |
| `lib/helpers.mjs` | reset/login/payment helpers and the independently computed share rule |
| `lib/inventory.mjs` | every requirement in the specification, and the declared gaps |
| `checks/*.mjs` | the checks, one file per area |
| `fixtures/*.json` | reset fixtures, referenced by name in reproduction commands |

## Global invariants

Some rules apply to *every* response, so they are asserted on every exchange the suite
makes rather than in one check:

| ref | rule |
|---|---|
| R5.16 | no response is 5xx |
| R5.1 | every 4xx and 5xx carries `{"error":{"code":..,"message":..}}` |
| R3.4a | every response with a body declares `application/json; charset=utf-8` and parses |
| R3.4b | every `created_at` and `committed_at` is RFC 3339 with an explicit offset |
| R3.4e | every `*_id` is a string of at most 64 characters |
| R2.6 | every response arrives within 5 s, or 10 s for `/_test/*` |
| R3.3 | a 204 carries no body |

The opaque `state` of `GET /_test/export` is excluded from the shape rules, since spec 10
makes its contents implementation-defined.
