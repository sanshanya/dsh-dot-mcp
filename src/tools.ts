/**
 * The 21 frozen tool declarations, in one table: every row names the wire tool
 * ChatGPT calls, its advertised zod schema, and the single Bridge verb it maps
 * onto. Nothing here reaches the filesystem, the shell or DSH internals, and no
 * row holds state — this file is the wire contract's source side, and
 * `test/integration/frozen-wire.mjs` is its literal side.
 *
 * Adding, renaming or removing a row breaks deployed ChatGPT actions: the count
 * (21) and the names are asserted by the real-boundary lanes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { safe } from './mcp-result.js';

/** Register every frozen tool on one server, each mapped onto one Bridge verb. */
export function registerBridgeTools(server: McpServer, bridge: Bridge): void {
  server.registerTool(
    'dsh_health',
    {
      title: 'DSH bridge health',
      description:
        'Bridge and DSH runtime status: versions, live/persisted/active session counts and ' +
        'capability flags.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.health()),
  );

  server.registerTool(
    'dsh_list_workspaces',
    {
      title: 'List registered workspaces',
      description:
        'List the workspaces DSH already registered/authorized. Sessions can only be created ' +
        'inside these. Arbitrary paths are never opened or auto-registered.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.listWorkspaces()),
  );

  server.registerTool(
    'dsh_create_session',
    {
      title: 'Create a DSH session',
      description:
        'Create a real DSH agent session bound to a registered workspace (id, canonical path, or ' +
        'title from dsh_list_workspaces). The agent starts immediately; if initial_message is ' +
        'given the first turn begins right away. Returns the stable session_id to continue later.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        title: z.string().optional().describe('Optional display title for the session'),
        initial_message: z.string().optional().describe('Optional first message for the agent'),
      }),
    },
    safe(async (args: { workspace: string; title?: string; initial_message?: string }) =>
      bridge.createSession(args.workspace, args.title, args.initial_message)),
  );

  server.registerTool(
    'dsh_list_sessions',
    {
      title: 'List DSH sessions',
      description:
        'List sessions (live + persisted), newest first, with limited paging. DSH persistence is ' +
        'the authority: sessions survive bridge and ChatGPT restarts and can be continued by id.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 50)'),
        offset: z.number().int().min(0).optional().describe('Skip this many rows (default 0)'),
        workspace: z.string().optional().describe('Filter to one registered workspace'),
        query: z.string().optional().describe('Case-insensitive substring match on titles'),
        title_exact: z.string().optional().describe('Exact title equality; same title ≠ same task'),
        state: z.enum(['live', 'persisted', 'all']).optional().describe('live = in-process agent attached; persisted = cold only'),
        updated_after: z.string().optional().describe('ISO timestamp; rows whose updated_at is unknown are EXCLUDED, never treated as recent'),
      }),
    },
    safe(async (args: { limit?: number; offset?: number; workspace?: string; query?: string; title_exact?: string; state?: 'live' | 'persisted' | 'all'; updated_after?: string }) =>
      bridge.listSessions({
        limit: args.limit, offset: args.offset, workspace: args.workspace,
        query: args.query, title_exact: args.title_exact, state: args.state, updated_after: args.updated_after,
      })),
  );

  server.registerTool(
    'dsh_get_session',
    {
      title: 'Inspect one DSH session',
      description:
        'Status, workspace, recent message summary (bounded), agent state, pending work, ' +
        'waiting approvals/questions and todos for one session. History is budgeted, never unlimited.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_items: z.number().int().min(1).max(200).optional().describe('Max message rows'),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars per message'),
      }),
    },
    safe(async (args: { session_id: string; max_items?: number; max_chars?: number }) =>
      bridge.getSession(args.session_id, args.max_items, args.max_chars)),
  );

  server.registerTool(
    'dsh_send_message',
    {
      title: 'Send a message to a DSH session',
      description:
        'Continue an EXISTING DSH session: the message joins that session\'s durable log and the ' +
        'same agent loop (never a fresh agent). mode queue (default) is a plain next-turn followup; ' +
        'steer reaches the model at the next step boundary mid-turn without aborting anything ' +
        '(in-flight tool calls still finish; the model may decline steering); interrupt aborts the ' +
        'active turn first — its executor signal kills in-flight work, queued messages are preserved — ' +
        'then continues with this message. Returns immediately. For a multi-step goal or execution ' +
        'plan prefer dsh_start_goal + dsh_wait_goal instead of polling this low-level API.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message: z.string().min(1).max(20000),
        mode: z.enum(['queue', 'steer', 'interrupt']).optional()
          .describe('Delivery: queue (default) waits for the next turn; steer injects at the next step ' +
            'boundary mid-turn; interrupt aborts the active turn (queued work preserved) and opens a new turn'),
        request_id: z.string().min(1).max(200).optional()
          .describe('Optional idempotency key: a retry with the same key and message is not dispatched twice'),
      }),
    },
    safe(async (args: { session_id: string; message: string; mode?: 'queue' | 'steer' | 'interrupt'; request_id?: string }) =>
      bridge.sendMessage(args.session_id, args.message, args.request_id, args.mode)),
  );

  server.registerTool(
    'dsh_message_status',
    {
      title: 'Delivery receipt of a sent message',
      description:
        'Look up the persisted receipt of a dsh_send_message request_id (survives bridge ' +
        'restarts when the bridge has a DSH Home). state=accepted means exactly one dispatch ' +
        'was accepted with the same key and payload hash — replays are deduplicated, conflicting ' +
        'replays hard-fail with IDEMPOTENCY_CONFLICT. REQUEST_NOT_FOUND means never accepted, or ' +
        'evicted from the 256-row retention window. Read-only; the payload itself is never stored ' +
        'or echoed, only its hash.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        request_id: z.string().min(1),
      }),
    },
    safe(async (args: { session_id: string; request_id: string }) =>
      bridge.messageStatus(args.session_id, args.request_id)),
  );

  server.registerTool(
    'dsh_get_task_status',
    {
      title: 'Task status of one session',
      description:
        'Status vocabulary: idle, queued, running, waiting_for_user, waiting_for_approval, ' +
        'completed, failed, cancelled, blocked, max-tokens, interrupted, forked. completed ' +
        'describes the LAST TURN\'s terminal state only — the bridge deliberately never infers ' +
        'task-level success; goal progress is the separate goal.phase field, and execution_origin ' +
        'says whether an armed goal or a plain message drives current activity. Also reports pending ' +
        'inbox items and any waiting approvals/questions with their ids, plus snapshot markers ' +
        '(observed_at / last_event_seq) to pair this call with a dsh_get_result of the same moment. ' +
        'For long supervised goals prefer dsh_wait_goal, which long-polls instead of returning one snapshot.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.getTaskStatus(args.session_id)),
  );

  server.registerTool(
    'dsh_get_result',
    {
      title: 'Final result of the last turn',
      description:
        'Last turn\'s assistant text, status, tool calls, changed files (the paths edit-tool ' +
        'calls named in the session log — a bash redirect is not parsed) and structured error ' +
        'when the turn failed. Budgets are per field and honest: max_chars caps the assistant ' +
        'text only; tool calls and changed_files have their own ceilings with omitted_counts ' +
        'counters. detail=summary minimizes tokens (names only, 5 files, no result_schema); ' +
        'standard (default) caps tool args at 500 chars and files at 200; full lifts those ceilings. ' +
        'total_max_chars caps the WHOLE payload in one go (degradation ladder, see truncated.total). ' +
        'When a previous turn failed, last_failure keeps it visible after later healthy turns. ' +
        'dsh_wait_goal already returns a bounded final summary when the goal is terminal; use ' +
        'this for a more detailed check.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars of assistant text'),
        detail: z.enum(['summary', 'standard', 'full']).optional().describe('Response envelope budget: summary (leanest), standard (default), full (no per-field ceilings)'),
        total_max_chars: z.number().int().min(500).max(200000).optional()
          .describe('Hard ceiling for the WHOLE serialized payload (all sections combined). Applied after the ' +
            'per-field budgets by dropping result_schema, stubbing tool-call arguments, shrinking changed_files, ' +
            'and lastly re-truncating the assistant text; sets truncated.total so the degradation is visible. ' +
            'Below the irreducible skeleton (ids/status/markers) nothing more is cut.'),
      }),
    },
    safe(async (args: { session_id: string; max_chars?: number; detail?: 'summary' | 'standard' | 'full'; total_max_chars?: number }) =>
      bridge.getResult(args.session_id, args.max_chars, args.detail, args.total_max_chars)),
  );

  server.registerTool(
    'dsh_cancel_task',
    {
      title: 'Cancel the running task',
      description:
        'Cancel the active turn of a live session through DSH\'s own cancel mechanism ' +
        '(agent.cancel). No processes are killed; the turn ends with an aborted reason. The ' +
        'result carries external_jobs_may_run=true: processes the agent spawned are outside the ' +
        'bridge\'s reach — a successful cancel does NOT imply their resources were released. ' +
        'For supervised goals prefer dsh_stop_goal, which is idempotent and also fails-closed any ' +
        'pending approval or question.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.cancelTask(args.session_id)),
  );

  server.registerTool(
    'dsh_answer_question',
    {
      title: 'Answer a pending user question',
      description:
        'Answer a question the DSH agent asked the human (status waiting_for_user). Pass the ' +
        'question_id from dsh_get_task_status, one or more offered option labels, and optional ' +
        'free text. An ask that carries several questions is parked as one answerable id per ' +
        'question: answer them one by one, following next_question_id until remaining_questions is 0.',
      inputSchema: z.object({
        question_id: z.string().min(1),
        session_id: z.string().optional(),
        selected: z.array(z.string()).default([]),
        custom: z.string().optional(),
      }),
    },
    safe(async (args: { question_id: string; session_id?: string; selected: string[]; custom?: string }) =>
      bridge.answerQuestion(args.question_id, args.session_id, { selected: args.selected, custom: args.custom })),
  );

  server.registerTool(
    'dsh_approve',
    {
      title: 'Decide one pending approval',
      description:
        'Decide one explicit DSH permission approval (status waiting_for_approval). Requires the ' +
        'exact approval_id and an explicit approve/reject decision. There is no approve-all; ' +
        'every grant is allowed-once for the exact tool call. Rejecting fails the call closed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        approval_id: z.string().min(1),
        decision: z.enum(['approve', 'reject']),
      }),
    },
    safe(async (args: { session_id: string; approval_id: string; decision: 'approve' | 'reject' }) =>
      bridge.approve(args.session_id, args.approval_id, args.decision)),
  );

  server.registerTool(
    'dsh_create_goal',
    {
      title: 'Create a DSH goal',
      description:
        'Create a native DSH goal on the given workspace. Native goals are the host\'s own ' +
        'objective/rounds lifecycle: the agent continues in rounds (armed) until the goal is ' +
        'complete, blocked, or paused. If an identical active goal already exists on the workspace, ' +
        'it is reused idempotently without bumping revision.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        goal: z.string().min(1).max(20000).describe('The completion objective for DSH'),
        request_id: z.string().min(1).max(200).optional().describe('Idempotency key'),
        max_goal_rounds: z.number().int().min(1).optional().describe('Native round budget (host default: 256)'),
        workspace_lock_override: z.boolean().optional()
          .describe('Take over an existing mutable workspace lock. Concurrent writers are rejected by default.'),
      }),
    },
    safe(async (args: {
      workspace: string;
      goal: string;
      request_id?: string;
      max_goal_rounds?: number;
      workspace_lock_override?: boolean;
    }) => bridge.createGoal(args)),
  );

  server.registerTool(
    'dsh_revise_goal',
    {
      title: 'Revise a DSH goal',
      description:
        'Substantive native edit of an existing goal (objective and/or round budget). ' +
        'Revision +1 with optimistic locking via expected_revision; revision conflicts surface as REVISION_CONFLICT.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        goal: z.string().max(20000).optional().describe('Replacement objective'),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on the current native revision'),
        max_goal_rounds: z.number().int().min(1).optional().describe('Replacement round budget'),
        request_id: z.string().min(1).max(200).optional(),
      }),
    },
    safe(async (args: {
      session_id: string;
      goal?: string;
      expected_revision?: number;
      max_goal_rounds?: number;
      request_id?: string;
    }) => bridge.reviseGoal(args)),
  );

  server.registerTool(
    'dsh_pause_goal',
    {
      title: 'Pause a DSH goal',
      description: 'Pause the session\'s native goal (durable phase → paused, disarmed). Idempotently stops the in-flight turn.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.pauseGoal(args.session_id)),
  );

  server.registerTool(
    'dsh_resume_goal',
    {
      title: 'Resume a DSH goal',
      description: 'Resume (re-arm) a paused or blocked native goal. The host enforces the round budget.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on the current native revision'),
        request_id: z.string().min(1).max(200).optional(),
      }),
    },
    safe(async (args: {
      session_id: string;
      expected_revision?: number;
      request_id?: string;
    }) => bridge.resumeGoal(args.session_id, args.request_id, args.expected_revision)),
  );

  server.registerTool(
    'dsh_wait_until_action_required',
    {
      title: 'Long wait until action is required',
      description:
        'Server-side long wait: returns only when human approval/question, error, or terminal completion ' +
        'is reached, avoiding high-frequency polling. Pass since_seq to read progress_delta from your own ' +
        'cursor instead of the shared per-session baseline.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(300).optional().describe('Max seconds to wait (default 120, max 300)'),
        since_seq: z.number().int().min(0).optional()
          .describe('Client-held event cursor: resume progress_delta from this seq. Does not advance the shared per-session baseline; page forward with progress_delta.until_seq'),
      }),
    },
    safe(async (args: { session_id: string; wait_seconds?: number; since_seq?: number }) =>
      bridge.waitUntilActionRequired(args.session_id, args.wait_seconds, args.since_seq)),
  );

  server.registerTool(
    'dsh_credential_status',
    {
      title: 'Provider credentials, plaintext',
      description:
        'Provider credentials: availability, source, and the plaintext secret value of each ' +
        'configured ref. No redaction — whoever connects can read what the bridge can read.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.getCredentialStatus()),
  );

  server.registerTool(
    'dsh_start_goal',
    {
      title: 'Start a DSH goal',
      description:
        'Use this when the user gives DSH a longer goal or an execution plan. The word "goal" below is ' +
        'the host-native objective: DSH creates a goal, arms rounds on the session, and continues until ' +
        'complete / blocked / paused (or max round budget). Call dsh_wait_goal immediately (loop contract, ' +
        'do not end the turn early). Identical objectives on the same session reuse idempotently; revision ' +
        'CAS via expected_revision.'
        + ' To edit / pause / resume an existing goal prefer dsh_update_goal; for revision-only edits dsh_revise_goal.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path, or title from dsh_list_workspaces'),
        goal: z.string().min(1).max(20000).describe('The completion objective for DSH'),
        plan: z.string().max(20000).optional().describe('Optional execution plan text (embedded into the objective)'),
        session_id: z.string().optional().describe('Continue on this existing DSH session; omit to create one'),
        request_id: z.string().min(1).max(200).optional().describe('Idempotency key for connector retries in this process'),
        expected_revision: z.number().int().min(1).optional().describe('Optional optimistic lock on the current native revision'),
        max_goal_rounds: z.number().int().min(1).optional().describe('Native round budget (host default: 256)'),
        workspace_lock_override: z.boolean().optional()
          .describe('Take over an existing mutable workspace lock. Concurrent writers are rejected by default.'),
        read_only: z.boolean().optional()
          .describe('Bridge-level concurrency hint: a read-only audit coexists with an existing mutable workspace lock'),
      }),
    },
    safe(async (args: {
      workspace: string;
      goal: string;
      plan?: string;
      session_id?: string;
      request_id?: string;
      expected_revision?: number;
      max_goal_rounds?: number;
      workspace_lock_override?: boolean;
      read_only?: boolean;
    }) => bridge.startGoal(args)),
  );

  server.registerTool(
    'dsh_update_goal',
    {
      title: 'Revise, pause, or resume a DSH goal',
      description:
        'Control-plane update for an EXISTING native goal. session_id is required; this tool never ' +
        'creates a session. action=revise edits objective and/or round budget; action=pause parks the goal ' +
        '(durable, disarmed); action=resume re-arms it (host enforces remaining round budget). ' +
        'Each call is revision-checked via expected_revision. Then call dsh_wait_goal if the goal re-arms.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('Existing DSH session that already has a goal'),
        action: z.enum(['revise', 'pause', 'resume']).optional()
          .describe('revise (default), pause, or resume the native goal'),
        goal: z.string().max(20000).optional().describe('Replacement objective (revise)'),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on the current native revision'),
        max_goal_rounds: z.number().int().min(1).optional().describe('Replacement round budget (revise)'),
        request_id: z.string().min(1).max(200).optional(),
      }),
    },
    safe(async (args: {
      session_id: string;
      action?: 'revise' | 'pause' | 'resume';
      goal?: string;
      expected_revision?: number;
      max_goal_rounds?: number;
      request_id?: string;
    }) => bridge.updateGoal(args)),
  );

  server.registerTool(
    'dsh_wait_goal',
    {
      title: 'Wait on a supervised DSH goal',
      description:
        'Bounded long-poll (default 25s, max 30s) of one DSH session. Pass since_seq to read progress_delta from your own cursor instead of the shared per-session baseline. If continuation_required is ' +
        'true, call this tool again immediately in the same assistant turn unless user action is ' +
        'required. Do not end the turn while continuation_required is true. Do not tell the user ' +
        'the task is running in the background and stop. waiting_for_approval / waiting_for_user ' +
        'stop the loop so you can ask the human, then dsh_approve or dsh_answer_question, then ' +
        'call this again. Never auto-approve or guess answers.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(30).optional().describe('Max seconds to wait (default 25)'),
        since_seq: z.number().int().min(0).optional()
          .describe('Client-held event cursor: resume progress_delta from this seq. Does not advance the shared per-session baseline; page forward with progress_delta.until_seq'),
      }),
    },
    safe(async (args: { session_id: string; wait_seconds?: number; since_seq?: number }) =>
      bridge.waitGoal(args.session_id, args.wait_seconds, args.since_seq)),
  );

  server.registerTool(
    'dsh_stop_goal',
    {
      title: 'Stop a supervised DSH goal',
      description:
        'Use when the user asks to stop, cancel, or interrupt the supervised DSH goal. Idempotent: ' +
        'already completed/cancelled/failed sessions return already_stopped=true without error. ' +
        'Cancels through DSH agent.cancel and fails-closed any pending approval or question. ' +
        'Does not kill processes.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.stopGoal(args.session_id)),
  );
}
