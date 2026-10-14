# Architecture — dsh-dot-mcp

One sentence: **a thin, honest relay between ChatGPT ("dot") and the DeepSeek
Harness host.** The bridge owns no judgement of its own about goals, approvals,
secrets, or execution policy — where such judgement existed it was deleted, and
what remains is a mapping onto host services plus the smallest state needed to
await a human.

This page is a **map, not the territory**: every claim below was taken from
`src/` and every number is `wc -l` of the file it names. When prose and code
disagree, the code is right (the last section says what that cost once).

## Shape

```
ChatGPT actions ── 21 frozen tools ──▶ mcp.ts        the server object (18)
                                          │
                                          ▼
                                       tools.ts       the 21 declarations + zod (407)
                                          │  safe() from mcp-result.ts (47)
                                          ▼
                                     bridge.ts        the facade the tools map onto:
                                     (1320)           sessions · views · results · native goals
                                          │           · workspace boundary · waits · facade verbs
        ┌──────────────┬──────────────────┼───────────────────┬────────────────────┐
        ▼              ▼                  ▼                   ▼                    ▼
  goal-native.ts  ask-relay.ts     session-facts.ts    result-schema.ts    workspace-guard.ts
  (370)           (583)            (421)               (266)               (99)
  native goal     park + report    fold the event      turn summary +      one mutable
  mapping         approvals &      log into facts      evidence/commits/   session per
  (ctx.goals)     questions        (pure)              tags/artifacts      workspace
        │              │                  ▲                   ▲                    │
        │              │        session-delta.ts        credentials.ts             │
        │              │        (212) since_seq slices  (115) availability,        │
        │              │                  ▲             never values               │
        │              │        temp-resources.ts (189) discovered worktrees/mkdirs │
        ▼              ▼                  │                   │                    ▼
   ────────────────────────────────────────────────────────────────────────────────────
   session-read.ts (137) the list/view rows · status.ts (112) · config.ts (157)
   http.ts (170) · log.ts (72) · request-id.ts (57) · paths.ts (47)
   command-classify.ts (83) · session-persistence-compat.ts (45) · version.ts (12)
```

Entry: `index.ts` (99) — the Cordis row: resolve config, build the logger, build
the `Bridge`, register transports (stateless HTTP or stdio), and own the
disposer that closes them.

Measured total: **5038 lines across 23 source files**. `lib/` is a build product
and is untracked; `npm run build` deletes it before compiling and the release
lane asserts exactly one artifact per source module, so a deleted module cannot
ship as a compiled ghost (the adversarial pass once found those in a deployed
copy).

## Modules: who owns what

| Module | Owns | Depends on |
| --- | --- | --- |
| `tools.ts` | the 21 tool declarations, their zod schemas, and the one Bridge verb each maps onto. One table, no state: the wire contract's source side | `bridge`, `mcp-result` |
| `mcp-result.ts` | the MCP result convention: one JSON text block per success, `{error:{code,message}}` + `isError` per failure | `goal-native` (`BridgeError` only) |
| `mcp.ts` | the `McpServer` object ChatGPT connects to; no declarations, no handlers | `tools`, `version` |
| `bridge.ts` | the facade: session lifecycle, status/result views, the native-goal verbs, the workspace boundary, the wait loops, request-id replay, and the two MCP answer verbs forwarded to the relay | everything below |
| `ask-relay.ts` | the human-in-the-loop plane: parking, the two reporting lanes, approval decisions, per-question answers, fail-closed settling, and the log mining that feeds both lanes | `goal-native` (error type), `session-facts`, `log` |
| `session-read.ts` | the read plane's rows: the list-summary shape, pending counts, row status, the three title sources (live service, cold log fold, zero-I/O cache hint), ISO/truncation | `status`, `dsh-session-title` |
| `goal-native.ts` | the structural mirror of `ctx.goals` (get/create/edit/pause/resume/clear), the wire shape `NativeGoalWire`, host-error → bridge-code translation, the wait primitive, the loop-contract constants | — |
| `session-facts.ts` | folding an event log into facts: turns, tool calls, changed files, todos, messages, commands | `command-classify` |
| `session-delta.ts` | poll cursors and the two delta modes (shared-baseline vs caller cursor) | `session-facts`, `command-classify` |
| `result-schema.ts` | the structured turn summary: test metrics, commits, tags, artifacts, warnings, provenance | `status`, `session-facts`, `goal-native` |
| `credentials.ts` | which provider credentials are configured and where — never their values | — |
| `temp-resources.ts` | discovering session-scoped temp paths in the workspace and deleting them (with two containment proofs) | `paths`, `session-facts` |
| `workspace-guard.ts` | the single-mutable-session lock and the observed-mutation ledger | `paths` |
| `status.ts` | the status vocabulary and its derivation from a state snapshot | — |
| `http.ts` | the stateless MCP HTTP transport, DNS-rebinding/Origin guards, `GET`/`DELETE` → 405 | `config`, `log` |
| `session-persistence-compat.ts` | the pinned host session-persistence API (nothing else reads it) | — |
| `command-classify.ts` | command semantics: display kind (substring) vs evidence kind (anchored) | — |
| `request-id.ts` | the idempotency map (fingerprint + record) and its disk sidecar format | — |
| `paths.ts`, `config.ts`, `log.ts`, `version.ts` | path identity/containment, config schema+resolution, the process log, the version read from `package.json` | — |

No cycles: `bridge` is the only hub (17 internal modules in), and only `index`
imports it at runtime (`tools.ts` takes the type only, `mcp-result.ts` reaches
the error class at its owner in `goal-native`).

Splitting rule this tree follows: **a module owns one plane**. The relay is its
own module because both golden-E2E defect classes landed in the seam where its
state lived in one file and the log mining that fed it lived in another. The
declaration table and the read rows were cut for the same reason at one remove:
a wire change and a row-shape change have one owner each.

### What a change costs (measured)

The repository total is one number; the number that decides how expensive a
change is, is the **static closure** of the files it touches — everything that
must be loaded to understand them. Both come from the context tracker
(`context-governor explain --file`), so they are recomputable rather than
remembered:

```bash
python3 <context-governor>/scripts/context_tracker.py --repo . explain --file src/session-read.ts
```

| Surface a change touches | Before the split | After | Δ |
| --- | --- | --- | --- |
| MCP result envelope | `src/mcp.ts` — 64.9K | `src/mcp-result.ts` — 5.4K | **−92%** |
| list/view row shape | `src/mcp.ts` — 64.9K | `src/session-read.ts` — 3.3K | **−95%** |
| one tool declaration / schema | `src/mcp.ts` — 64.9K | `src/tools.ts` — 66.1K | +2% |
| the server object | `src/mcp.ts` — 64.9K | `src/mcp.ts` — 66.3K | +2% |

(Before the split all four surfaces were the same file, `mcp.ts`, with a
64.9K-token closure; the rows above are what each surface costs to load now.)

Two of the four surfaces got 92–95% cheaper to load. The declaration table did
**not**, and saying otherwise would be this document lying again: a row needs the
facade's method signatures, so its closure still contains the facade graph. The
split bought *locality* there — 21 rows in one table, diffable against
`test/integration/frozen-wire.mjs` — not context. The envelope got cheaper only
after a second pass: it imported `BridgeError` through `bridge.ts`, which pulled
in the whole facade for a 700-token file; it now reaches the class at its owner.

Two limits of these numbers, stated so nobody over-reads them: the closure counts
`import type` like any other import (a type-only edge is real context but not
runtime coupling), and 34 relative imports still resolve to nothing — every
`test/*` file importing `../../lib/<module>.js`, because `lib/` is a gitignored
build product and is not scanned. Closures for test files understate them.

## The four planes

### 1. Session plane (what the driver drives)

`create_session` → `ctx.agents.create` + `workspace.attachSession` + optional
title + optional first message. `send_message` → `agent.followup` (never a new
agent). `cancel_task` → `agent.cancel({kind:'user'})` on a *live* session only.
Views (`get_session`, `get_task_status`, `get_result`, `list_sessions`) are
projections over `ctx.agents` + `ctx.sessionPersistence`: live sessions replay
in-memory events, cold sessions are inspected from the persisted log, and every
list is budgeted (`sessionMaxItems/Chars`, `resultMaxItems/Chars`).

### 2. Goal plane (a 1:1 map, no supervision vocabulary)

Every goal verb is a structural call into the host's `GoalService`
(`ctx.goals`) through `goal-native.ts`; the host owns the phase machine
(active/paused/blocked/complete), the revision CAS, the round budget and the
armed/disarmed edge. The bridge adds exactly three things: the wire shape, the
error vocabulary, and one ordering — **a pause always quiesces the in-flight
turn before flipping the phase** (`doPause`, shared by `dsh_pause_goal` and
`dsh_update_goal action=pause`). `dsh_start_goal`/`dsh_create_goal` reuse an
identical active objective on the same workspace, replace a completed one, and
refuse a foreign active goal (`GOAL_ALREADY_EXISTS`) or a workspace held by
another live mutable session (`WORKSPACE_LOCKED`, `workspace_lock_override`
takes over). The loop contract (`continuation_required`, `next_tool_call`) is
computed once in `mapGoalStartNative`; `goal_outcome` has a single owner in the
wait snapshot, where a parked ask always wins over the phase loop's verdict.

### 3. Relay plane (`ask-relay.ts`) — the human in the loop

Three moves, one owner: 不归我 → `next()`; 宿主能答 → `next()`; otherwise **park
the raw ask** and show it in two lanes until the driver answers.

```ts
async decideApproval(request, next) {
  if (!host.isManaged(request.agent.id)) return next();      // not ours
  if (host.autoApproveEscalations()) return 'allowed-once';  // operator switch (off by default)
  if (host.hostCanAnswer()) { log; return next(); }          // host GUI/driver wins
  return parkApproval(request, commandForCall(log, request.callId)); // park
}
```

- **Two lanes, one identity.** The parked lane (`source: 'parked'`) is
  answerable; the session-log lane (`source: 'log'`) exists so an ask that
  outlived a restart is still visible, and it says so instead of offering an id
  that `dsh_answer_question` refuses. The two are deduped on the host call id,
  which modern hosts put on `request.wait.callId` and legacy hosts do not — so
  it is mined from the open `ask_user_question` call in the log.
- **Approvals** carry the tool identity, the call id, the reason and the
  **mined command text** (the host request does not include it), and every
  decision is `allowed-once` or `rejected` — there is no approve-all.
- **Questions** are asked in batches: the wire exposes **one answerable id per
  question** (`question-<uuid8>`, or `... #<index>` inside a batch), each
  validated against its own options, and the host promise settles with every
  answer in the order it was asked. `remaining_questions` / `next_question_id`
  let a driver walk a batch.
- **`autoApproveEscalations`** (default off) is the one place the bridge grants
  instead of relaying: it answers `allowed-once` to the requested mode and sits
  deliberately in front of the host-client deferral, so "never ask" does not
  quietly stop working while the GUI is open. It cannot create an ask — a call
  that never requests a wider mode is refused inside the sandbox, with no
  request to relay. Visible as `dsh_health.capabilities.autoApproveEscalations`.
- **Fail-closed** on stop/abort/dispose: parked approvals settle `cancelled`,
  parked questions settle with the answers already given (`{answers: []}` if
  none), and the batch records are released.

### 4. Boundary plane

Workspace concurrency (`workspace-guard`), the workspace registry lookup used by
every entry point, session-scoped temp cleanup on stop (deletion, not a
projection; two containment proofs against symlink escapes), and the request-id
maps (`goal-requests.json` is the only persisted bridge state; `send_message`
dedupes in-process only, deliberately).

## State ownership

| State | Owner | Lifetime | Persisted |
| --- | --- | --- | --- |
| managed session ids | `bridge` | process | no |
| goal request ids | `bridge.goalRequests` + `goal-requests.json` | process + disk | yes |
| message request ids | `bridge` | process | no |
| poll cursors (per session) | `bridge` | process, FIFO-capped | no |
| parked approvals / questions / batches | `ask-relay` | until answered, aborted, or disposed | no |
| workspace lock + mutation ledger | `workspace-guard` | until terminal / capped | no |
| session truth (events, headers, titles) | **the host** | the host's | host JSONL |

Nothing else is written to disk; the log file under `DSH_HOME` is the second
deliberate write.

## Host seams and what happens without them

| Seam | Used for | Missing ⇒ |
| --- | --- | --- |
| `ctx.agents` / `ctx.sessions` | every session operation | plugin cannot start (declared in `inject`) |
| `ctx.sessionPersistence` | cold reads, `list_sessions` | `SESSION_NOT_FOUND` for cold ids (`inject`) |
| `ctx.sessionTitle` | titles | optional: sessions are untitled |
| `ctx.workspaceRegistry` | every workspace lookup | `WORKSPACE_REGISTRY_UNAVAILABLE` |
| `ctx.goals` | the goal verbs | `GOAL_UNAVAILABLE` |
| `ctx.agentPresets` / `ctx.agentDefaultModel` | agent composition | optional: host defaults |
| `ctx.userQuestions` | question relay | the waterfall is never claimed; questions flow to whoever provides it |
| `ctx.get('typertGateway')` | "can the host answer?" (`hasLiveClient()`) | read as *no client*: the bridge parks (or, with the switch, grants) |
| `ctx.get('webRuntime')` | the `webSurface` health flag: is a `dsh-web-app` browser surface mounted? | reported `false` |
| `ctx.get('sessionProjectionCache')` | zero-I/O titles for cold rows (asks for the `title` key only) | titles resolved from the log instead |

## Error vocabulary (stable codes on the wire)

Session/input: `SESSION_NOT_FOUND`, `SESSION_NOT_LIVE`, `SESSION_REQUIRED`,
`SESSION_CREATE_FAILED`, `EMPTY_MESSAGE`, `NO_RESULT_YET`,
`WORKSPACE_NOT_FOUND`, `WORKSPACE_REGISTRY_UNAVAILABLE`, `REQUEST_ID_CONFLICT`,
`INTERNAL` (anything unexpected; adds a stack when
`DSH_DOT_MCP_DEBUG=1`).

Goals: `EMPTY_GOAL`, `GOAL_NOT_FOUND`, `GOAL_ALREADY_EXISTS`, `GOAL_INVALID`,
`GOAL_INVALID_TRANSITION`, `GOAL_UNAVAILABLE`, `GOAL_HOST_ERROR`,
`REVISION_CONFLICT`, `WORKSPACE_LOCKED` (details carry
`status: 'waiting_for_workspace_lock'` plus the holder).

Approvals/questions: `APPROVAL_NOT_FOUND`, `APPROVAL_SESSION_MISMATCH`,
`QUESTION_NOT_FOUND`, `INVALID_ANSWER`.

Codes are asserted by name in the unit and real-boundary lanes; they are part
of the wire contract, not prose.

## Wire contract (frozen at 21 tools)

Sessions (5): `create_session, list_sessions, get_session, send_message,
cancel_task`. Goals (7): `create_goal, revise_goal, pause_goal, resume_goal,
stop_goal, start_goal, update_goal`. Waits (2): `wait_goal,
wait_until_action_required`. Read projections (2): `get_task_status,
get_result`. Answers (2): `approve, answer_question`. Meta (3): `health,
list_workspaces, credential_status`.

Renaming any of them breaks the deployed ChatGPT actions config. The literal
list lives in exactly one place — `test/integration/frozen-wire.mjs` — and both
real-boundary lanes assert set-equality against it (never against `src/`, which
could drift with the code under test). These 21 are the whole wire: an action
config naming any other tool fails at call time.

## Verification

| Tier | Command | Proves | Last measured |
| --- | --- | --- | --- |
| Unit | `npm test` | 161 tests over synthetic contexts and fixtures | 161/161 |
| Release | `npm run test:release` | packs this tree, installs the tarball + official `dsh@0.2.0-rc.2` into a throwaway dir, asserts one compiled artifact per source module (no `lib/` ghosts), runs the two real-boundary lanes there | 2/2, 52 files |
| Live | `BRIDGE_DSH_DIR=… npm run test:live` | boots a harness checkout with the packed artifact and asserts the served vocabulary | opt-in |
| Golden | `npm run test:golden` | drives a RUNNING instance over MCP: real model turns, both relays, the goal lifecycle, the fail-closed edges — and fails if any frozen tool was never invoked | 79 pass · 0 fail · 0 skip (21/21 happy); 70 · 0 · 1 with `autoApproveEscalations` on |

The golden lane's coverage ledger is what keeps "all 21 tools are covered" a
checked property; the SKIP path (an instance whose preset never asks) is
reported per tool rather than hidden.

## Deliberately absent (do not reintroduce)

- **Secret redaction** — the wire is verbatim; secrets are the caller's
  responsibility.
- **An approval policy matrix** — hook/GUI/driver layers already decide; a
  bridge-side classifier was a parallel protocol. The relay has exactly one
  grant switch, and it is the operator's.
- **Skip-answering and drift annotation** — the last two bridge-side judgements
  that rode the approval seam.
- **An execution-idempotency ledger** — `dsh_get_result` evidence ids are
  derived per read (`exec-<sessionId>:<callId>`).
- **A workspace baseline pipeline** — five git calls whose product was
  write-only.
- **The bridge's own goal protocol** — constraint matrix, revision cards,
  preflight, reconcile loop; all replaced by the native map.

## What the adversarial pass taught this document

An earlier revision asserted a per-session tmp dir that no longer existed,
`pending.approvals[]` as the wire path for a parked approval (actual:
`waiting.approvals[]`), `unavailable` as a bridge emission (it is not), and a
baseline captured at adopt time (there is no baseline at all). Two later
golden-E2E passes found defects that only the real wire could show — one ask
reported twice under two id spaces, and a two-question ask answered by halves.
Read `src/`; keep this page honest or delete the claim.