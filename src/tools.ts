/**
 * The frozen tool declarations, in one table: every row names the wire tool a
 * client calls, its advertised zod schema, and the single Bridge verb it maps
 * onto. Nothing here reaches the filesystem, the shell or DSH internals, and no
 * row holds state — this file is the wire contract's source side, and
 * `test/integration/frozen-wire.mjs` is its literal side.
 *
 * Two surfaces share this table (`src/shared/surface.ts`):
 *   core  — one door per intent (15). The default.
 *   full  — core plus the four goal aliases, the long-form session inspector,
 *           the delivery receipt and the plaintext credential dump (22).
 * A surface is a permission surface: names outside it are never registered, so
 * the SDK answers `-32602 not found` for them.
 *
 * Descriptions are budgeted (see docs/0.9-tool-surface.md): a description over
 * 260 chars, a parameter note over 90, or a tool over 1,100 fails the suite.
 * They exist to make the first tool choice correct — keep the discriminating
 * "when to use this instead of that" clause, drop the prose around it.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { safe } from './mcp-result.js';
import { visibleUnder, type Surface } from './shared/surface.js';

/** Register the tools of one surface on one server, each mapped onto one Bridge verb. */
export function registerBridgeTools(server: McpServer, bridge: Bridge, surface: Surface = 'core'): void {
  // `core` is a subset of `full`, so only the full-only doors need a guard.
  const on = (name: string): boolean => visibleUnder(name, surface);

  server.registerTool(
    'dsh_health',
    {
      title: 'DSH bridge health',
      description:
        'Bridge and DSH runtime status: versions, session counts, capability flags, and the active ' +
        'tool surface (tier, tool count, tools hash).',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.health(surface)),
  );

  server.registerTool(
    'dsh_list_workspaces',
    {
      title: 'List registered workspaces',
      description:
        'List workspaces DSH already registered. Sessions and goals can only be created inside ' +
        'these; arbitrary paths are never opened or auto-registered.',
      inputSchema: z.object({}),
    },
    safe(async () => bridge.listWorkspaces()),
  );

  server.registerTool(
    'dsh_create_session',
    {
      title: 'Create a DSH session',
      description:
        'Create a DSH agent session inside a registered workspace. The agent starts immediately; ' +
        'initial_message begins the first turn now. Returns the stable session_id.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path or title from dsh_list_workspaces'),
        title: z.string().optional().describe('Optional display title'),
        initial_message: z.string().optional().describe('Optional first message; starts a turn now'),
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
        'List sessions (live + persisted), newest first. DSH persistence is the authority: sessions ' +
        'survive restarts and are continued by id.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max rows 1-100 (default 50)'),
        offset: z.number().int().min(0).optional().describe('Skip N rows (default 0)'),
        workspace: z.string().optional().describe('Filter to one workspace'),
        query: z.string().optional().describe('Substring match on titles'),
        title_exact: z.string().optional().describe('Exact title match'),
        state: z.enum(['live', 'persisted', 'all']).optional().describe('live = agent attached; persisted = cold'),
        updated_after: z.string().optional().describe('ISO time; unknown updated_at is excluded'),
      }),
    },
    safe(async (args: { limit?: number; offset?: number; workspace?: string; query?: string; title_exact?: string; state?: 'live' | 'persisted' | 'all'; updated_after?: string }) =>
      bridge.listSessions({
        limit: args.limit, offset: args.offset, workspace: args.workspace,
        query: args.query, title_exact: args.title_exact, state: args.state, updated_after: args.updated_after,
      })),
  );

  if (on('dsh_get_session')) {
    server.registerTool(
      'dsh_get_session',
      {
        title: 'Inspect one DSH session',
        description:
          'Full session view: status, workspace, title, agent state, pending work and recent ' +
          'messages (bounded). Prefer dsh_get_task_status with detail=session.',
        inputSchema: z.object({
          session_id: z.string().min(1),
          max_items: z.number().int().min(1).max(200).optional().describe('Max message rows'),
          max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars per message'),
        }),
      },
      safe(async (args: { session_id: string; max_items?: number; max_chars?: number }) =>
        bridge.getSession(args.session_id, args.max_items, args.max_chars)),
    );
  }

  server.registerTool(
    'dsh_send_message',
    {
      title: 'Send a message to a DSH session',
      description:
        'Continue an EXISTING session: joins its durable log and agent loop. mode=queue (default) ' +
        'next turn, steer at a step boundary, interrupt aborts the active turn.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        message: z.string().min(1).max(20000),
        mode: z.enum(['queue', 'steer', 'interrupt']).optional()
          .describe('queue (default), steer at a step boundary, interrupt aborts the turn'),
        request_id: z.string().min(1).max(200).optional()
          .describe('Idempotency key: same key + message is not dispatched twice'),
      }),
    },
    safe(async (args: { session_id: string; message: string; mode?: 'queue' | 'steer' | 'interrupt'; request_id?: string }) =>
      bridge.sendMessage(args.session_id, args.message, args.request_id, args.mode)),
  );

  if (on('dsh_message_status')) {
    server.registerTool(
      'dsh_message_status',
      {
        title: 'Delivery receipt of a sent message',
        description:
          'Persisted receipt of a dsh_send_message request_id. state=accepted means exactly one ' +
          'dispatch; replays dedupe, conflicting replays fail IDEMPOTENCY_CONFLICT.',
        inputSchema: z.object({
          session_id: z.string().min(1),
          request_id: z.string().min(1),
        }),
      },
      safe(async (args: { session_id: string; request_id: string }) =>
        bridge.messageStatus(args.session_id, args.request_id)),
    );
  }

  server.registerTool(
    'dsh_get_task_status',
    {
      title: 'Task status of one session',
      description:
        'Session status, pending inbox, waiting approvals/questions with ids, todos and goal phase. ' +
        'completed describes the LAST TURN only; goal progress is goal.phase. detail=session adds ' +
        'title, workspace and messages. Prefer dsh_wait_goal for supervised goals.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        detail: z.enum(['status', 'session']).optional()
          .describe('status (default) = status projection; session adds title, workspace, messages'),
        max_items: z.number().int().min(1).max(200).optional()
          .describe('Max message rows when detail=session (default 20)'),
        max_chars: z.number().int().min(100).max(100000).optional()
          .describe('Max chars per message when detail=session (default 4000)'),
      }),
    },
    safe(async (args: { session_id: string; detail?: 'status' | 'session'; max_items?: number; max_chars?: number }) =>
      bridge.getTaskStatus(args.session_id, args.detail, args.max_items, args.max_chars)),
  );

  server.registerTool(
    'dsh_get_result',
    {
      title: 'Final result of the last turn',
      description:
        'Last turn\'s assistant text, status, tool calls, changed files and error. ' +
        'detail=summary|standard|full; total_max_chars caps the whole payload (see truncated.total).',
      inputSchema: z.object({
        session_id: z.string().min(1),
        max_chars: z.number().int().min(100).max(100000).optional().describe('Max chars of assistant text'),
        detail: z.enum(['summary', 'standard', 'full']).optional()
          .describe('summary (leanest) | standard (default) | full (no per-field ceilings)'),
        total_max_chars: z.number().int().min(500).max(200000).optional()
          .describe('Whole-payload ceiling; sets truncated.total when it bites'),
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
        'Cancel the active turn of a live session. No processes are killed ' +
        '(external_jobs_may_run=true). For a supervised goal use dsh_stop_goal.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.cancelTask(args.session_id)),
  );

  server.registerTool(
    'dsh_answer_question',
    {
      title: 'Answer a pending user question',
      description:
        'Answer a question the agent asked (waiting_for_user). Use the question_id from ' +
        'dsh_get_task_status; a multi-question ask is answered one by one.',
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
        'Decide one explicit permission approval (waiting_for_approval) by approval_id. There is no ' +
        'approve-all: each grant is allowed-once, and rejecting fails the call closed.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        approval_id: z.string().min(1),
        decision: z.enum(['approve', 'reject']),
      }),
    },
    safe(async (args: { session_id: string; approval_id: string; decision: 'approve' | 'reject' }) =>
      bridge.approve(args.session_id, args.approval_id, args.decision)),
  );

  if (on('dsh_create_goal')) {
    server.registerTool(
      'dsh_create_goal',
      {
        title: 'Create a DSH goal',
        description: 'Create a native DSH goal. Same verb as dsh_start_goal, which is the core door.',
        inputSchema: z.object({
          workspace: z.string().min(1).describe('Workspace id, path or title'),
          goal: z.string().min(1).max(20000).describe('The completion objective for DSH'),
          request_id: z.string().min(1).max(200).optional().describe('Idempotency key'),
          max_goal_rounds: z.number().int().min(1).optional().describe('Round budget (host default 256)'),
          workspace_lock_override: z.boolean().optional()
            .describe('Take over an existing mutable workspace lock'),
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
  }

  if (on('dsh_revise_goal')) {
    server.registerTool(
      'dsh_revise_goal',
      {
        title: 'Revise a DSH goal',
        description:
          'Substantive edit of an existing goal. Same verb as dsh_update_goal action=revise.',
        inputSchema: z.object({
          session_id: z.string().min(1),
          goal: z.string().max(20000).optional().describe('Replacement objective'),
          expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on the goal revision'),
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
  }

  if (on('dsh_pause_goal')) {
    server.registerTool(
      'dsh_pause_goal',
      {
        title: 'Pause a DSH goal',
        description:
          'Park the native goal (durable, disarmed) and stop the in-flight turn. ' +
          'Same verb as dsh_update_goal action=pause.',
        inputSchema: z.object({ session_id: z.string().min(1) }),
      },
      safe(async (args: { session_id: string }) => bridge.pauseGoal(args.session_id)),
    );
  }

  if (on('dsh_resume_goal')) {
    server.registerTool(
      'dsh_resume_goal',
      {
        title: 'Resume a DSH goal',
        description: 'Re-arm a paused or blocked goal. Same verb as dsh_update_goal action=resume.',
        inputSchema: z.object({
          session_id: z.string().min(1),
          expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on the goal revision'),
          request_id: z.string().min(1).max(200).optional(),
        }),
      },
      safe(async (args: {
        session_id: string;
        expected_revision?: number;
        request_id?: string;
      }) => bridge.resumeGoal(args.session_id, args.request_id, args.expected_revision)),
    );
  }

  server.registerTool(
    'dsh_wait_until_action_required',
    {
      title: 'Long wait on a session',
      description:
        'Long wait (default 120s, max 300s) returning as soon as the session leaves running/queued — ' +
        'a parked approval/question, a terminal end, or an idle finish.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(300).optional().describe('Max seconds to wait (default 120)'),
        since_seq: z.number().int().min(0).optional()
          .describe('Client-held cursor: resume progress_delta from this seq'),
      }),
    },
    safe(async (args: { session_id: string; wait_seconds?: number; since_seq?: number }) =>
      bridge.waitUntilActionRequired(args.session_id, args.wait_seconds, args.since_seq)),
  );

  if (on('dsh_credential_status')) {
    server.registerTool(
      'dsh_credential_status',
      {
        title: 'Provider credentials, plaintext',
        description:
          'Provider credentials including plaintext secrets. No redaction: whoever connects can read ' +
          'what the bridge can read.',
        inputSchema: z.object({}),
      },
      safe(async () => bridge.getCredentialStatus()),
    );
  }

  server.registerTool(
    'dsh_start_goal',
    {
      title: 'Start a DSH goal',
      description:
        'Create AND arm a native goal: rounds run until complete, blocked, paused or the budget ' +
        'ends. Call dsh_wait_goal immediately after — do not end the turn early.',
      inputSchema: z.object({
        workspace: z.string().min(1).describe('Workspace id, path or title'),
        goal: z.string().min(1).max(20000).describe('Completion objective'),
        plan: z.string().max(20000).optional().describe('Optional plan text'),
        session_id: z.string().optional().describe('Continue this session; omit = new'),
        request_id: z.string().min(1).max(200).optional().describe('Idempotency key'),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on revision'),
        max_goal_rounds: z.number().int().min(1).optional().describe('Round budget (host default 256)'),
        workspace_lock_override: z.boolean().optional()
          .describe('Take over an existing mutable lock'),
        read_only: z.boolean().optional()
          .describe('Read-only audit; coexists with a mutable lock'),
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
        'Update an EXISTING goal: revise edits objective/rounds, pause parks it, resume re-arms. ' +
        'Revision-checked via expected_revision. Then call dsh_wait_goal if it re-arms.',
      inputSchema: z.object({
        session_id: z.string().min(1).describe('Existing DSH session that already has a goal'),
        action: z.enum(['revise', 'pause', 'resume']).optional()
          .describe('revise (default), pause, or resume'),
        goal: z.string().max(20000).optional().describe('Replacement objective (revise)'),
        expected_revision: z.number().int().min(1).optional().describe('Optimistic lock on the goal revision'),
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
        'Bounded long-poll of one goal (25s, max 30s). While continuation_required is true call it ' +
        'again in this turn; a parked approval or question stops the loop. Never auto-approve.',
      inputSchema: z.object({
        session_id: z.string().min(1),
        wait_seconds: z.number().int().min(1).max(30).optional().describe('Max seconds to wait (default 25)'),
        since_seq: z.number().int().min(0).optional()
          .describe('Client-held cursor: resume progress_delta from this seq'),
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
        'Stop or interrupt a supervised goal. Idempotent; fails closed any parked approval or ' +
        'question; does not kill processes.',
      inputSchema: z.object({ session_id: z.string().min(1) }),
    },
    safe(async (args: { session_id: string }) => bridge.stopGoal(args.session_id)),
  );
}