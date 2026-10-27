# Changelog

## 0.9.1 — 2026-10-27

Four defects found by driving the wire from a real client. None of them changed a
tool name; all of them made a promise the response did not keep.

### Fixed
- **`total_max_chars` measured the wrong string.** The budget was enforced against
  the compact JSON while the client receives the pretty-printed block, which is
  ~40% larger — so a 1,000-char ceiling could ship 1,884 chars, and for a
  `detail=summary` view every rung of the ladder was a no-op, so 500 and 1,000
  produced byte-identical responses. The ladder now measures the served text,
  gained rungs that actually bite (3 tool calls → 0, text → 0, files → 0, drop
  `last_failure`) and reports `truncated.served_chars` / `budget_chars` /
  `over_budget` when the irreducible skeleton alone exceeds the ceiling, instead
  of silently overshooting.
- **`omitted_counts` and `truncated.tool_calls` disagreed.** 38 dropped tool calls
  were reported as `tool_calls: false` because the flag compared the already-capped
  list against itself. Both fields now derive from the real turn total, and the
  total-budget pass recomputes both from its own output — one裁剪 produces both,
  so either can be trusted.
- **A failure had one representation, not two.** Errors returned only a text block;
  a client branching on `structuredContent` got whatever its connector synthesized,
  which is how `WORKSPACE_NOT_FOUND` in the body sat next to `INVALID_ARGUMENT` in
  the structured field. Both now come from a single object, and carry
  `error.retryable` so "try again" and "fix the input" are distinguishable without
  the caller keeping a table of our codes.
- **`INTERNAL` was retryable in one place and not in another** — the fallback branch
  hardcoded `false` while the code table listed it. It is now non-retryable
  everywhere (an unexpected fault is not fixed by asking again).
- The `WORKSPACE_NOT_FOUND` message no longer explains how to *create* a session
  when the failure came from a *lookup*.

### Added
- **`dsh_get_task_status.next`** — `{actionable, waiting_on, recommendation, reason}`.
  A snapshot like `status=queued` + idle agent + pending next-step meant three
  different things depending on whether a goal was armed: a driver is about to run,
  nothing will ever consume it, or the task already ended. `next` names the blocker
  and the move, without collapsing the field set into one label.
- **`dsh_list_sessions` returns `{sessions, page}`** with `has_more`, `next_offset`,
  `sort`, so "is there another page?" no longer costs an empty probe request. Rows
  excluded by `updated_after` (unknown `updated_at`) are called out in `page.note`.

### Verification
- 318 unit tests green (6 new: budget ceiling honoured or overshoot declared,
  counts/flags agreement, page metadata, single-object errors, retryability, and
  the `next` verdict for queued-but-idle / parked-approval / finished).

## 0.9.0 — 2026-10-27

Tool-surface release: the bridge serves **one door per intent** by default and costs
**45.9% less context per request**. Targets DSH `0.2.1-rc.2` (Cordis 4.0.5).

### Added
- **`surface` config** (`core` default | `full`), volatile and switchable from the
  settings panel. This is a *permission* surface: the MCP SDK filters `tools/list`
  by `tool.enabled` and answers `-32602 not found` for anything outside it, so a
  name the surface does not carry cannot be called at all.
- **`dsh_health.surface`**: `{tier, tool_count, tools_sha256, replacements}` — the
  served vocabulary is self-describing, and the hash lets a client detect a stale
  cached list without diffing names or trusting a hand-maintained version integer.
- **`dsh_get_task_status(detail='status'|'session')`**: `session` adds title,
  workspace, created_at, agent and bounded messages (`max_items`/`max_chars`).
  Default `status` is byte-for-byte the previous projection, so polling cost did
  not move.
- **`scripts/surface-cost.mjs`**: the ruler every budget claim is reproducible
  with (`--surface core|full --mode static|served --json`).

### Changed
- **Default surface is `core` (15 tools)**. The 7 full-only doors — four goal
  aliases (`create`/`revise`/`pause`/`resume_goal`), `dsh_get_session`,
  `dsh_message_status`, `dsh_credential_status` — require `surface: 'full'`.
  `dsh_health.surface.replacements` maps each to the core door that owns the verb.
- **Tool descriptions compressed** (a description is a tool-selection hint, not
  documentation): core `tools/list` 19,725 → **10,678 chars** (≈5.5k → ≈3.0k
  tokens), full → 14,695. No parameter was removed; the schema is unchanged.
- `dsh_wait_until_action_required` description now states what the loop actually
  does (returns when the session leaves `running`/`queued`, which includes an idle
  finish) instead of claiming it only returns on approval/question/error/terminal.
- Text that pointed at soon-hidden doors was rewritten: the `start_goal` revision
  hint no longer names `dsh_revise_goal`, and the `GOAL_ALREADY_EXISTS` error no
  longer suggests it either.

### Fixed
- **`dsh_update_goal(action='pause')` now returns `checkpoint_revision`**, matching
  `dsh_pause_goal`. The value was always present as `goal.revision`; the two doors
  now speak the same key.
- Stale "21 tools" claims removed from `ARCHITECTURE.md`, `src/tools.ts` and
  `test/live/boot-smoke.test.mjs` (the wire has served 22 since 0.7.0).
- The duplicated frozen-name literal in `test/unit/plugin-lifecycle.test.mjs` was
  removed; `test/integration/frozen-wire.mjs` is the single literal owner again.

### Verification
- Unit suite 312 tests, all green — including the new budget ratchet (core ≤11,000,
  full ≤15,500, per-tool ≤1,400, description ≤260) and the "no core-visible text
  names a door that core does not serve" scan.
- `dsh-cli` and `boot-smoke` lanes assert the served `core` set end to end; the
  golden lane drives all 22 doors and now refuses to run against a `core` instance
  instead of reporting a fake product failure.

## 0.8.0 — 2026-10-21

Supervisor-grade release: a supervising client can now know **what happened, when it
was observed, and within what budget** — without trusting a natural-language summary.
Targets DSH `0.2.1-rc.2` (Cordis 4.0.5).

### Added
- **Session/result snapshot markers**: `dsh_get_session`, `dsh_get_result` and
  `dsh_get_task_status` all carry `snapshot{observed_at,last_event_seq}` so parallel
  reads from one moment can be paired.
- **Total-payload budget**: `dsh_get_result(total_max_chars=…)` bounds the WHOLE
  serialized response via a deterministic ladder (drop `result_schema` → stub
  tool-call arguments → shrink `changed_files` → re-truncate text), flagged by
  `truncated.total`. Per-field budgets (`max_chars`, `detail=summary|standard|full`,
  `omitted_counts`) are unchanged.
- **`GET /status`** on the HTTP listener: health payload + `state: running|disabled`;
  readable by loopback browser pages (Origin-scoped), refused to foreign origins.
- **`enabled` volatile config + gate**: suspending from the DSH settings panel
  refuses all MCP traffic with 503 `bridge-disabled` while the listener and
  `/status` stay up, so the panel can always resume the service.
- **GUI settings tab**（`settings.plugins.tab`）: modern status card (state, endpoint,
  sessions, uptime, versions, PID) polled from `/status`, with 重启/停止/恢复
  service controls over `enabled`, plus cards for the volatile budgets/switches.
- Message delivery receipts (`dsh_send_message request_id` → `dsh_message_status`
  lookup; `IDEMPOTENCY_CONFLICT` on conflicting replays; 256-row home-persisted window).
- Goal-native wait plane (`dsh_wait_goal`, `dsh_wait_until_action_required`) with
  cursor expiry markers; long polls instead of status polling.
- `dsh_list_sessions` filters: `query`, `title_exact`, `state`, `updated_after`
  (unknown `updated_at` never counts as "recent").

### Changed
- HTTP transport is **stateless** (0.8.0): per-request transport + McpServer, no
  MCP session ids, no idle sweeps.
- Bridge health carries instance/build metadata (`instance_id`, `started_at`,
  `build_time`, `artifact_sha256`); `dsh.version=unknown` always carries a reason.
- `completed` semantics documented as **last-turn terminal state only**;
  `execution_origin` distinguishes goal-driven vs manual activity; `last_failure`
  keeps an earlier failed turn visible after later healthy turns.
- Peers/devDeps pinned to DSH `0.2.1-rc.2` exact, Cordis `4.0.5`,
  schemastery `~3.18.5`; web-surface capability probe accepts both the
  `webApp` (0.2.1) and legacy `webRuntime` service names.

### Fixed
- GUI boot incompatibility on 0.2.1-rc.2: client entries must declare
  `export const inject` (`locale/configForms/slots`); added dictionaries + the
  settings tab registration path.
- `dsh_get_result(max_chars=800)` could still answer with tens of thousands of
  characters; the new aggregate budget closes the hole while preserving the
  documented per-field behavior.

### Verification
- 298/298 unit tests; release lanes (`npm run test:release`): packed tarball boots
  on official `dsh@0.2.1-rc.2` for both the isolated CLI lane and the real-host
  lane (`PACKED_RELEASE_OK`).
- Frozen wire contract unchanged: 22 tools, same names.
