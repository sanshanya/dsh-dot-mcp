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
MCP clients ────── 15 core / 22 full ──▶ mcp.ts        the server object (22)
                                          │
                                          ▼
                                       tools.ts       the 22 declarations + zod (556)
                                          │  safe() from mcp-result.ts (47)
                                          ▼
                                     bridge.ts        the facade the tools map onto:
                                     (1372)           sessions · views · results · native goals
                                          │           · workspace boundary · request ids
        ┌──────────────┬──────────────────┼───────────────────┬────────────────────┐
        ▼              ▼                  ▼                   ▼                    ▼
  goal-native.ts  ask-relay.ts     session-facts.ts    result-schema.ts    workspace-guard.ts
  (353)           (643)            (485)               (382)               (126)
  native goal     park + report    fold the event      goal/turn summary +      one mutable
  mapping         approvals &      log into facts      evidence ids/             session per
  (ctx.goals)     questions        (pure)              tests/commits         workspace + queue
        │              │                  ▲                   │                    │
        │              │        session-delta.ts        result-remote.ts         │
        │              │        (209) since_seq slices  (220) per-domain remote   │
        │              │                  ▲             proof: git/npm/ gh       │
        ▼              ▼        temp-resources.ts (132) fail-closed: deletes only  │
   waits.ts (173)       │        trusted registrations (discovery disabled)        │
   both long-poll       │                  │                   │                    │
   loops + cursors      ▼                  ▼                   ▼                    ▼
   ────────────────────────────────────────────────────────────────────────────────────
   errors.ts (32) the wire error vocabulary · session-read.ts (149) the list/view rows
   status.ts (112) · config.ts (157) · http.ts (170) · log.ts (72) · request-id.ts (88)
   paths.ts (47) · command-classify.ts (209) · session-persistence-compat.ts (45) · version.ts (12)
   result-scope.ts (52) selects one durable goal generation or the latest turn
   request-id-store.ts (57) the goal request_id map's fs sidecar (tmp+rename, 0600)
   message-receipts.ts (84) dsh_send_message delivery receipts: FIFO ≤256/≤64KB, 0600
```

Entry: `index.ts` (99) — the Cordis row: resolve config, build the logger, build
the `Bridge`, register transports (stateless HTTP or stdio), and own the
disposer that closes them.

Measured total: **6654 lines across 33 source files (28 host modules + shared defaults + 3 GUI panel files + message receipts)**. `lib/` is a build product
and is untracked; `npm run build` deletes it before compiling and the release
lane asserts exactly one artifact per source module, so a deleted module cannot
ship as a compiled ghost (the adversarial pass once found those in a deployed
copy).

## Modules: who owns what

| Module | Owns | Depends on |
| --- | --- | --- |
| `tools.ts` | the 22 tool declarations, their zod schemas, and the one Bridge verb each maps onto. One table split by surface (`core` 15 / `full` 22), no state: the wire contract's source side | `bridge`, `mcp-result`, `shared/surface` |
| `mcp-result.ts` | the MCP result convention: one JSON text block per success, `{error:{code,message}}` + `isError` per failure | `errors` |
| `mcp.ts` | the `McpServer` object ChatGPT connects to; no declarations, no handlers | `tools`, `version` |
| `bridge.ts` | the facade: session lifecycle, status/result views, the native-goal verbs, the workspace boundary, request-id replay, and the four thin forwarders (two wait verbs to the wait plane, `dsh_approve`/`dsh_answer_question` to the relay) | everything below |
| `ask-relay.ts` | the human-in-the-loop plane: parking, the two reporting lanes, approval decisions, per-question answers, fail-closed settling, and the log mining that feeds both lanes | `errors`, `session-facts`, `log` |
| `session-read.ts` | the read plane's rows (`LoadedView` included): the list-summary shape, pending counts, row status, the three title sources (live service, cold log fold, zero-I/O cache hint), ISO/truncation | `status`, `dsh-session-title` |
| `goal-native.ts` | the structural mirror of `ctx.goals` (get/create/edit/pause/resume/clear), the wire shape `NativeGoalWire`, host-error → bridge-code translation, the wait primitive, the loop-contract constants | `errors` |
| `session-facts.ts` | event folding plus one shared full-output tool outcome used by facts, last-turn calls and both progress projections | `command-classify` |
| `session-delta.ts` | the poll-cursor map and the two delta modes (shared-baseline vs caller cursor); the *policy* of when a cursor moves lives in `waits.ts` | `session-facts`, `command-classify` |
| `result-schema.ts` | current-goal/latest-turn summaries; latest-started test counts, authoritative pack outputs and stable terminal checkpoints; the `ResultSchema` shape | `status`, `session-facts`, `goal-native`, `result-remote`, `result-scope`, `paths` |
| `result-remote.ts` | per-domain remote proof — one scanner each for git pushes, npm publishes and gh releases, with config-change/pending invalidation binding URL, registry, directory and tag to the evidence | `command-classify`, `session-facts`, `paths` |
| `result-scope.ts` | pure durable create-ID boundaries shared by the facade's evidence IDs and the schema; no goal means latest-turn scope | `goal-native`, `session-facts` (types) |
| `credentials.ts` | which provider credentials are configured, where, and their plaintext values (no redaction posture) | — |
| `temp-resources.ts` | fail-closed cleanup seam: deletion accepts only trusted host registrations (ownership + temporary intent); session-log discovery is disabled because logs cannot prove either | `paths`, `session-facts` (types) |
| `workspace-guard.ts` | the single-mutable-session lock, the per-workspace operation queue, and the observed-mutation ledger | `paths` |
| `status.ts` | the status vocabulary and its derivation from a state snapshot | — |
| `http.ts` | the stateless MCP HTTP transport, DNS-rebinding/Origin guards, `GET`/`DELETE` → 405 | `config`, `log` |
| `session-persistence-compat.ts` | the pinned host session-persistence API (nothing else reads it) | — |
| `command-classify.ts` | command semantics: display kind (substring) vs evidence kind (anchored) | — |
| `request-id.ts` | the idempotency map (fingerprint + record) and the in-flight coalescer | `errors` |
| `request-id-store.ts` | the goal map's disk sidecar: JSON document, atomic tmp+rename, 0600, best-effort | `request-id` (type) |
| `message-receipts.ts` | delivery receipts for send_message request ids: persisted ledger, 256-row/64KB retention, honest 'evicted' framing | (fs only) |
| `errors.ts` | the wire error vocabulary: `BridgeError` (code + optional details) and its goal-flavoured subclass. A leaf, so any module may raise a coded failure without depending on the facade | — |
| `waits.ts` | the wait plane: both long-poll loops, the snapshot they answer from (`goal_outcome`, `progress_delta`, the loop contract), the parked-ask-wins rule, and the per-session poll cursors | `goal-native`, `session-delta`, `session-facts`, `ask-relay` (type), `session-read` (type), `status` |
| `paths.ts`, `config.ts`, `log.ts`, `version.ts` | path identity/containment, config schema+resolution, the process log, the version read from `package.json` | — |

No cycles: `bridge` is the only hub (18 internal modules in), and only `index`
imports it at runtime (`tools.ts` and `mcp.ts` take the type only). The two new
leaves point inward and never back: `errors.ts` imports nothing, and `waits.ts`
reaches the facade only through the `WaitHost` seam the facade implements — the
same shape as the relay's `RelayHost`.

Splitting rule this tree follows: **a module owns one plane**. The relay is its
own module because both golden-E2E defect classes landed in the seam where its
state lived in one file and the log mining that fed it lived in another. The
declaration table, the read rows, the error vocabulary and the wait plane were
cut for the same reason at one remove: a wire change, a row-shape change, an
error code and a long-poll verdict each have one owner now. The wait plane in
particular used to sit *between* the goal verbs that arm goals — the loops and
the cursors they advance are one subject, and the rule that a parked ask wins
over the native phase verdict is now stated where the verdict is computed.

### What a change costs (measured)

The repository total is one number; the number that decides how expensive a
change is, is the **static closure** of the files it touches — everything that
must be loaded to understand them. Both come from the context tracker
(`context-governor explain --file`), so they are recomputable rather than
remembered. The closure values below are historical measurements at the module
split, not a remeasurement of the current boundary fixes:

```bash
python3 <context-governor>/scripts/context_tracker.py --repo . explain --file src/session-read.ts
```

| Surface a change touches | Before the split | After | Δ |
| --- | --- | --- | --- |
| MCP result envelope | `src/mcp.ts` — 64.9K | `src/mcp-result.ts` — 1.2K | **−98%** |
| the error vocabulary | `src/goal-native.ts` — 4.9K | `src/errors.ts` — 0.4K | **−91%** |
| list/view row shape | `src/mcp.ts` — 64.9K | `src/session-read.ts` — 3.4K | **−95%** |
| the wait plane | `src/bridge.ts` — 60.6K | `src/waits.ts` — 30.2K | **−50%** |
| one tool declaration / schema | `src/mcp.ts` — 64.9K | `src/tools.ts` — 67.7K | +4% |
| the server object | `src/mcp.ts` — 64.9K | `src/mcp.ts` — 67.9K | +5% |

(Before the split all four surfaces were the same file, `mcp.ts`, with a
64.9K-token closure; the rows above are what each surface costs to load now.)

Four of the six surfaces got 50–98% cheaper to load. The declaration table did
**not**, and saying otherwise would be this document lying again: a row needs the
facade's method signatures, so its closure still contains the facade graph. The
split bought *locality* there — 22 rows in one table, diffable against
`test/integration/frozen-wire.mjs` — not context. The envelope got cheaper in two
passes: first it stopped importing `BridgeError` through the facade, then the
class itself moved to `errors.ts`, so a 700-token file no longer drags the goal
mapping either. `waits.ts` is the honest middle case: waiting on a session really
does need the event fold, the delta math, the goal seam and the relay's parked
view — 30.2K of them, and 8.2K of that is `ask-relay.ts`, which arrives only as
a type (`WaitingState`).

Two limits of these numbers, stated so nobody over-reads them: the closure counts
`import type` like any other import (a type-only edge is real context but not
runtime coupling), and 34 relative imports still resolve to nothing — every
`test/*` file importing `../../lib/<module>.js`, because `lib/` is a gitignored
build product and is not scanned. Closures for test files understate them.

## The four planes

### 1. Session plane (what the driver drives)

`create_session` → `ctx.agents.create` + `workspace.attachSession` + optional
title + optional first message. `send_message` maps its `mode` onto the host's
three inbox channels: `queue` → `agent.followup`, `steer` → `agent.steer`
(next step boundary, nothing aborted), `interrupt` →
`agent.cancel({kind:'user'},{keepInbox:true})` + followup (the host reclassifies
the waking input to next-turn and latches it until the aborted activity
converges). Never a new agent. `cancel_task` → `agent.cancel({kind:'user'})` on
a *live* session only.
Views (`get_session`, `get_task_status`, `get_result`, `list_sessions`) are
projections over `ctx.agents` + `ctx.sessionPersistence`: live sessions replay
in-memory events, cold sessions are inspected from the persisted log, and every
list is budgeted (`sessionMaxItems/Chars`, `resultMaxItems/Chars`). The two
blocking verbs are the only place the bridge keeps a loop of its own:
`wait_until_action_required` and `wait_goal` live in `waits.ts` with the
per-session poll cursors they advance, and both end in the same snapshot whose
first rule is **a parked ask always wins** (see §3).

### 2. Goal plane (a 1:1 map, no supervision vocabulary)

Every goal verb is a structural call into the host's `GoalService`
(`ctx.goals`) through `goal-native.ts`; the host owns the phase machine
(active/paused/blocked/complete), the revision CAS, the round budget and the
armed/disarmed edge. The bridge adds exactly three things: the wire shape, the
error vocabulary, and one ordering — **pause first accepts the native CAS and
disarms, then cancels and awaits quiescence** (`doPause`, shared by `dsh_pause_goal` and
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
- **Approvals** carry the tool identity, call id, reason, **mined command text**
  and `source: parked|log`; only parked IDs are bridge-answerable. Native audit
  IDs and bridge IDs are matched one-to-one by exact request identity, including
  absent call IDs and indistinguishable concurrent asks. Correlation is refreshed
  against the undecided log rather than pinning guessed UUIDs. Every decision
  is `allowed-once` or `rejected` — there is no approve-all.
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

Workspace concurrency (`workspace-guard`: the lock, the per-workspace
operation queue that serializes bridge dispatches, and the mutation ledger),
the workspace registry lookup used by every entry point, and the request-id
maps plus in-flight request coalescing (`goal-requests.json` is the only
persisted bridge state). Stopping a session clears its goal, fails its parked
relays closed, then cancels and awaits quiescence (`whenIdle` covers
idle-status maintenance) — it never deletes files, worktrees, or artifacts:
logs and filename patterns cannot prove ownership, so temp cleanup stays
fail-closed until a trusted registration exists. A workspace lock is retained
while an armed goal exists (a completed turn does not relinquish it), and a
stale `expected_revision` never has side effects — the native CAS is committed
or rejected before any cancellation. Read-only hints are keyed to the exact
native goal ID, retained across that goal's pause/resume and invalidated on
completion, clear or external replacement. New mutable goals cannot inherit an
old audit's exemption, and a fresh audit gets a fresh session rather than
reclassifying completed mutable/unknown work.

### Result evidence boundary

The facade and schema share `result-scope.ts`: native `goal/change` create
records identify a generation even when clocks collide; missing boundaries
exclude history. Edits/pause/resume retain one generation's facts, while
completion cuts off subsequent unrelated work. No goal means latest-turn scope.
Evidence IDs and originating-step provenance use that same scoped snapshot;
they never borrow another session's workspace mutation. An active goal has no
finish timestamp. An ended goal uses its complete/block/pause checkpoint, not a
later edit's `updated_at`; without that checkpoint the finish time is unknown.

Tests select the latest started call (unfinished means unknown), and every
success projection uses `toolResultOutcome` over all blocks and the full exit
marker. Remote verification requires post-settlement reads, matching effective
workdir and explicit endpoint context: a Git alias needs fresh matching push
and fetch URL observations, and observed/pending configuration changes revoke
its candidate even after partial failure; npm needs a known publish registry
and an explicit matching registry on read-back. Pack artifacts come only from
authoritative filename/JSON output; member inventories supply no tarball names,
sizes or hashes. Pending remote-call checks use a completed-call Set rather
than a quadratic search through the goal's tool history.

## State ownership

| State | Owner | Lifetime | Persisted |
| --- | --- | --- | --- |
| managed session ids | `bridge` | process | no |
| goal request ids | `bridge.goalRequests` + `goal-requests.json` | process + disk | yes |
| message request ids | `bridge` | process | no |
| in-flight request reservations | `RequestFlights` (per verb plane) | process, per in-flight call | no |
| read-only goal classification (session → goal ID) | `bridge.readOnlySessions` | process, exact goal generation | no |
| poll cursors (per session) | `waits` | process, FIFO-capped | no |
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

Owned by `errors.ts` — one class, no imports — and raised by every plane.
Session/input: `SESSION_NOT_FOUND`, `SESSION_NOT_LIVE`, `SESSION_REQUIRED`,
`SESSION_CREATE_FAILED`, `EMPTY_MESSAGE`, `NO_RESULT_YET`,
`WORKSPACE_NOT_FOUND`, `WORKSPACE_REGISTRY_UNAVAILABLE`, `WORKSPACE_MISMATCH`,
`REQUEST_ID_CONFLICT`, `REQUEST_ID_STALE`,
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

## Wire contract (frozen at 22 tools)

Sessions (5): `create_session, list_sessions, get_session, send_message,
cancel_task`. Goals (7): `create_goal, revise_goal, pause_goal, resume_goal,
stop_goal, start_goal, update_goal`. Waits (2): `wait_goal,
wait_until_action_required`. Read projections (2): `get_task_status,
get_result`. Answers (2): `approve, answer_question`. Meta (3): `health,
list_workspaces, credential_status`.

Renaming any of them breaks the deployed ChatGPT actions config. The literal
list lives in exactly one place — `test/integration/frozen-wire.mjs` — and both
real-boundary lanes assert set-equality against it (never against `src/`, which
could drift with the code under test). These 22 are the whole wire; a deployment
serves 15 of them on `core` (the default) or all 22 on `full`, and an action
config naming anything outside the served set fails at call time with `not found`.

## Verification

| Tier | Command | Proves | Last measured |
| --- | --- | --- | --- |
| Unit | `npm test` | 294 tests over synthetic contexts and isolated host-service fixtures | 294/294 |
| Release | `npm run test:release` | packs this tree, installs the tarball + official `dsh@0.2.1-rc.2` into a throwaway dir, asserts one compiled artifact per source module (no `lib/` ghosts), runs the two real-boundary lanes there | 2/2, 68 files |
| Live | `BRIDGE_DSH_DIR=… npm run test:live` | boots a real harness checkout in a throwaway profile on a probed free port (never the shipped 3456) and asserts the served vocabulary | 1/1, 22 tools |
| Golden | `npm run test:golden` | drives a RUNNING instance over MCP: real model turns, both relays, the goal lifecycle, the fail-closed edges — and fails if any frozen tool was never invoked | 87 pass · 0 fail · 0 skip (22/22 happy); 70 · 0 · 1 with `autoApproveEscalations` on |

The golden lane's coverage ledger is what keeps "all 22 tools are covered" a
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