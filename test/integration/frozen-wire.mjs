/**
 * The frozen MCP wire, spelled out ONCE as literals.
 *
 * Two real-boundary lanes assert the SERVED vocabulary — the isolated official
 * CLI (`dsh-cli.test.mjs`) and the live harness boot (`../live/boot-smoke.test.mjs`)
 * — and neither may read it out of `src/`: a value imported from the code under
 * test can never catch that code drifting away from the deployed contract.
 *
 * This file exists because that exact drift already happened once. The 0.7.0
 * cut removed `dsh_retry_step`/`dsh_rerun_step` (23 → 21 tools) and left a
 * literal `23` in the CLI lane, which stayed red unnoticed. One owner for the
 * wire; every real observer checks here.
 */
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