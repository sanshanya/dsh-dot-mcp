# Changelog

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
