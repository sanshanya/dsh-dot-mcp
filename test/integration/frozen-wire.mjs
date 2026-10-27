/**
 * The frozen MCP wire, spelled out ONCE as literals.
 *
 * Two real-boundary lanes assert the SERVED vocabulary — the isolated official
 * CLI (`../integration/dsh-cli.test.mjs`) and the live harness boot
 * (`../live/boot-smoke.test.mjs`) — and neither may read it out of `src/`: a
 * value imported from the code under test can never catch that code drifting
 * away from the deployed contract.
 *
 * This file exists because that exact drift already happened once. The 0.7.0
 * cut removed `dsh_retry_step`/`dsh_rerun_step` (23 → 21 tools) and left a
 * literal `23` in the CLI lane, which stayed red unnoticed. One owner for the
 * wire; every real observer checks here.
 *
 * 0.9.0 added a second dimension: WHICH names a deployment serves is now the
 * `surface` config (`core` default, `full` opt-in). Both surfaces are frozen
 * here as literals, so a code-side change that quietly moves a name between
 * them fails a lane.
 */

/** Every name the bridge can register — the `full` surface, in alphabetical order. */
export const FROZEN_TOOL_NAMES = [
  'dsh_answer_question',
  'dsh_approve',
  'dsh_cancel_task',
  'dsh_create_goal',
  'dsh_create_session',
  'dsh_credential_status',
  'dsh_get_result',
  'dsh_get_session',
  'dsh_get_task_status',
  'dsh_health',
  'dsh_list_sessions',
  'dsh_list_workspaces',
  'dsh_message_status',
  'dsh_pause_goal',
  'dsh_resume_goal',
  'dsh_revise_goal',
  'dsh_send_message',
  'dsh_start_goal',
  'dsh_stop_goal',
  'dsh_update_goal',
  'dsh_wait_goal',
  'dsh_wait_until_action_required',
];

/**
 * The `core` surface (default): one door per intent. It is
 * `FROZEN_TOOL_NAMES` minus `FULL_ONLY_TOOL_NAMES`, and this file asserts that
 * relationship so the three lists can never drift apart.
 */
export const CORE_TOOL_NAMES = [
  'dsh_answer_question',
  'dsh_approve',
  'dsh_cancel_task',
  'dsh_create_session',
  'dsh_get_result',
  'dsh_get_task_status',
  'dsh_health',
  'dsh_list_sessions',
  'dsh_list_workspaces',
  'dsh_send_message',
  'dsh_start_goal',
  'dsh_stop_goal',
  'dsh_update_goal',
  'dsh_wait_goal',
  'dsh_wait_until_action_required',
];

/**
 * Doors that exist only on `full`: four goal aliases (each a second door onto a
 * verb `start_goal`/`update_goal` already owns), the long-form session
 * inspector, the delivery receipt, and the plaintext credential dump.
 */
export const FULL_ONLY_TOOL_NAMES = [
  'dsh_create_goal',
  'dsh_credential_status',
  'dsh_get_session',
  'dsh_message_status',
  'dsh_pause_goal',
  'dsh_resume_goal',
  'dsh_revise_goal',
];

/**
 * Full-only name → the core door that owns the same verb. Shipped as data
 * (`dsh_health.surface.replacements`), never as extra registered aliases.
 * `dsh_credential_status` is absent: reading secrets has no core equivalent.
 */
export const TOOL_REPLACEMENTS = {
  dsh_create_goal: 'dsh_start_goal',
  dsh_revise_goal: 'dsh_update_goal',
  dsh_pause_goal: 'dsh_update_goal',
  dsh_resume_goal: 'dsh_update_goal',
  dsh_get_session: 'dsh_get_task_status',
  dsh_message_status: 'dsh_send_message',
};

/** The names a surface serves, sorted, as the wire reports them. */
export function namesFor(surface) {
  return surface === 'full' ? FROZEN_TOOL_NAMES : CORE_TOOL_NAMES;
}