/**
 * Which tools a deployment exposes. Shared by the host (register-time filter in
 * `tools.ts`), the settings panel (the `surface` enum) and the contract tests.
 * This module must stay Node-free and dependency-free so the browser bundle can
 * inline it, exactly like `defaults.ts`.
 *
 * A surface is a PERMISSION surface, not a display filter: the MCP SDK filters
 * `tools/list` by `tool.enabled` and rejects calls to a tool the server did not
 * register (`-32602 Tool X not found`). A name outside the current surface is
 * therefore not callable at all — which is the point: a smaller surface means a
 * smaller default attack surface.
 */

export type Surface = 'core' | 'full';

/** Every selectable surface, cheapest first. */
export const SURFACES: readonly Surface[] = ['core', 'full'];

/**
 * The default. `core` carries one door per intent; `full` adds the alias and
 * diagnostic doors that exist for compatibility and troubleshooting.
 */
export const DEFAULT_SURFACE: Surface = 'core';

/**
 * The `core` surface: one entry per intent, no aliases, no diagnostics.
 * 15 names — reads, writes, approvals, goal control, and both wait loops.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  'dsh_health',
  'dsh_list_workspaces',
  'dsh_create_session',
  'dsh_list_sessions',
  'dsh_get_task_status',
  'dsh_send_message',
  'dsh_get_result',
  'dsh_cancel_task',
  'dsh_answer_question',
  'dsh_approve',
  'dsh_start_goal',
  'dsh_update_goal',
  'dsh_stop_goal',
  'dsh_wait_goal',
  'dsh_wait_until_action_required',
];

/**
 * `full`-only doors: four goal aliases (each a second door onto a verb that
 * `start_goal` / `update_goal` already own), the long-form session inspector,
 * the delivery-receipt lookup and the plaintext credential dump.
 */
export const FULL_ONLY_TOOL_NAMES: readonly string[] = [
  'dsh_create_goal',
  'dsh_revise_goal',
  'dsh_pause_goal',
  'dsh_resume_goal',
  'dsh_get_session',
  'dsh_message_status',
  'dsh_credential_status',
];

/** Every registered tool name, in registration order. `full` = core + full-only. */
export const ALL_TOOL_NAMES: readonly string[] = [
  'dsh_health',
  'dsh_list_workspaces',
  'dsh_create_session',
  'dsh_list_sessions',
  'dsh_get_session',
  'dsh_send_message',
  'dsh_message_status',
  'dsh_get_task_status',
  'dsh_get_result',
  'dsh_cancel_task',
  'dsh_answer_question',
  'dsh_approve',
  'dsh_create_goal',
  'dsh_revise_goal',
  'dsh_pause_goal',
  'dsh_resume_goal',
  'dsh_wait_until_action_required',
  'dsh_credential_status',
  'dsh_start_goal',
  'dsh_update_goal',
  'dsh_wait_goal',
  'dsh_stop_goal',
];

/** True when `surface` exposes `name`. Unknown names are never visible. */
export function visibleUnder(name: string, surface: Surface): boolean {
  if (!ALL_TOOL_NAMES.includes(name)) return false;
  return surface === 'full' || CORE_TOOL_NAMES.includes(name);
}

/** The tool names a surface serves, in registration order. */
export function toolsForSurface(surface: Surface): readonly string[] {
  return surface === 'full' ? ALL_TOOL_NAMES : CORE_TOOL_NAMES;
}

/** Coerce an arbitrary configured value to a known surface, defaulting to core. */
export function asSurface(value: unknown): Surface {
  return value === 'full' ? 'full' : DEFAULT_SURFACE;
}

/**
 * Legacy name → the door that owns the same verb on the `core` surface.
 * Shipped as data (readable from `dsh_health`), never as extra registered
 * aliases: adding the aliases back would undo the whole point of `core`.
 *
 * `dsh_credential_status` has no equivalent — switch to `full` to read it.
 */
export const TOOL_REPLACEMENTS: Readonly<Record<string, string>> = {
  dsh_create_goal: 'dsh_start_goal',
  dsh_revise_goal: 'dsh_update_goal',
  dsh_pause_goal: 'dsh_update_goal',
  dsh_resume_goal: 'dsh_update_goal',
  dsh_get_session: 'dsh_get_task_status',
  dsh_message_status: 'dsh_send_message',
};