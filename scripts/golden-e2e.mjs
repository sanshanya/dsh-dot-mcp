#!/usr/bin/env node
/**
 * Golden end-to-end drive against a RUNNING test instance of the bridge.
 *
 * This is not a unit test and not the release gate: it speaks the real MCP
 * wire to a real DSH host that has this plugin installed, and it drives every
 * one of the frozen tools the way a remote driver (ChatGPT) actually walks
 * them — session lifecycle, real agent turns against a real model, the
 * approval and question relays, the native goal lifecycle, idempotency,
 * persistence and the fail-closed edges.
 *
 * The last section is a COVERAGE LEDGER: it compares the tools actually
 * invoked against `test/integration/frozen-wire.mjs` and fails when a frozen
 * tool was never driven. "We test the 21 tools" is therefore a checked
 * property of this lane, not a claim in a document.
 *
 * Build the instance first (see README, "Golden E2E"):
 *   DSH_HOME=/tmp/dsh-golden-home node --import tsx/esm apps/cli/src/bin.ts \
 *     --profile golden --host 127.0.0.1 --port 0 --no-open
 * then:
 *   BRIDGE_URL=http://127.0.0.1:34617/mcp node scripts/golden-e2e.mjs
 *
 * The instance needs a model configured and a workspace whose path ends with
 * `/golden-workspace`. The relay stages need a permission preset that ASKS
 * (`workspace-write`); with `danger-full-access` they are reported as SKIP
 * rather than failing, because "nothing asked" is not a bridge defect — the
 * ledger then says which tools were only driven over their fail-closed edge.
 *
 * An instance running `autoApproveEscalations: true` is driven too: the
 * approval stage then asserts the opposite (nothing parks, the wider write
 * still lands) and the ledger marks `dsh_approve` fail-closed-only.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FROZEN_TOOL_NAMES } from '../test/integration/frozen-wire.mjs';

const URL_ = process.env.BRIDGE_URL ?? 'http://127.0.0.1:34617/mcp';
const WORKSPACE_SUFFIX = process.env.BRIDGE_WORKSPACE_SUFFIX ?? '/golden-workspace';
const DSH_HOME = process.env.BRIDGE_DSH_HOME ?? '/tmp/dsh-golden-home';
const RUN = Date.now();

let passed = 0, skipped = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ' — ' + detail : ''}`);
};
const skip = (label, why) => { skipped++; console.log(`○ ${label} — SKIP: ${why}`); };
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(3, 68 - title.length))}`);
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Coverage ledger. Every wire call records its tool as at least "driven over
 * its fail-closed edge"; a check that proves the happy path upgrades the entry
 * to "happy". Both tiers are honest and both are printed at the end.
 */
const driven = new Map();
const mark = (tool) => { driven.set(tool, 'happy'); };

let lastResponseText = '';
async function call(name, args = {}, timeoutMs = 30_000) {
  if (!driven.has(name)) driven.set(name, 'edge');
  const response = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  const frames = [...text.matchAll(/^data: (.*)$/gm)].map((match) => match[1]);
  const payload = JSON.parse(frames.length > 0 ? frames[frames.length - 1] : text);
  if (payload.error !== undefined) throw new Error(`transport error from ${name}: ${JSON.stringify(payload.error)}`);
  lastResponseText = payload.result.content[0].text;
  const parsed = JSON.parse(lastResponseText);
  return payload.result.isError ? { failure: parsed } : parsed;
}

const BUSY = ['queued', 'running'];
const SETTLED = ['completed', 'failed', 'cancelled', 'blocked', 'max-tokens', 'interrupted', 'forked'];

/** Poll one session until it parks something, settles, or the bound expires. */
async function settle(sessionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false;
  for (;;) {
    const status = await call('dsh_get_task_status', { session_id: sessionId });
    const approvals = status.waiting?.approvals ?? [];
    const questions = status.waiting?.questions ?? [];
    const state = status.status ?? '';
    if (approvals.length > 0 || questions.length > 0) return { state, approvals, questions, status };
    if (state !== 'idle') sawBusy = true;
    if (SETTLED.includes(state)) return { state, approvals, questions, status };
    if (state === 'idle' && sawBusy) return { state, approvals, questions, status };
    if (Date.now() > deadline) return { state: 'timeout', approvals, questions, status };
    await sleep(1200);
  }
}

/** Poll a predicate until it yields a value or the bound expires. */
async function until(fn, timeoutMs = 60_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null && value !== false) return { ok: true, value };
    if (Date.now() >= deadline) return { ok: false, value: undefined };
    await sleep(intervalMs);
  }
}

/** Answer the first open question of a park (used when the model asks instead of acting). */
async function answerFirst(sessionId, parked, selected) {
  const question = parked.questions[0];
  const label = selected ?? question?.questions?.[0]?.options?.[0]?.label ?? 'Yes';
  await call('dsh_answer_question', { question_id: question.question_id, session_id: sessionId, selected: [label] });
  mark('dsh_answer_question');
  return label;
}

/** Raw secret material of the test home, for the "never echo a secret" probe. */
function homeSecrets() {
  const values = [];
  for (const name of ['.env', '.credentials.yaml']) {
    const path = join(DSH_HOME, name);
    if (!existsSync(path)) continue;
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const cut = trimmed.includes('=') ? trimmed.indexOf('=') : trimmed.indexOf(':');
      if (cut < 0) continue;
      const value = trimmed.slice(cut + 1).trim().replace(/^["']|["']$/g, '');
      if (value.length >= 8 && /^[A-Za-z0-9_\-./+=]+$/.test(value)) values.push(value);
    }
  }
  return [...new Set(values)];
}

console.log(`golden e2e → ${URL_} (run ${RUN})\n`);

// ── §1 control plane ────────────────────────────────────────────────────────
section('control plane');

let health;
try {
  health = await call('dsh_health');
} catch (error) {
  console.error(`\nno bridge answering at ${URL_} (${error instanceof Error ? error.message : String(error)})`);
  console.error('this lane drives a RUNNING test instance — see README, "Golden E2E", for the recipe');
  process.exit(2);
}
check('dsh_health: bridge + dsh versions', typeof health.bridge?.version === 'string' && typeof health.dsh?.version === 'string',
  `bridge ${health.bridge?.version} on dsh ${health.dsh?.version}`);
check('dsh_health: the control-plane capabilities are advertised',
  health.capabilities?.userQuestions === true && health.capabilities?.approvals === true && health.capabilities?.goalSupervision === true,
  JSON.stringify(health.capabilities));
mark('dsh_health');

// The instance decides which approval posture the lane is verifying: with
// autoApproveEscalations on, nothing may park and the wider write must land
// anyway (see §4). Questions are NOT covered by the switch, so §3 is unchanged.
const autoGrant = health.capabilities?.autoApproveEscalations === true;
if (autoGrant) console.log('  (this instance runs autoApproveEscalations: true — §4 verifies the auto-grant)');

const workspaces = await call('dsh_list_workspaces');
const list = Array.isArray(workspaces) ? workspaces : [];
const workspace = list.find((item) => String(item.path).endsWith(WORKSPACE_SUFFIX));
if (workspace === undefined) {
  console.error(`\nno registered workspace ending in ${WORKSPACE_SUFFIX}; register one before running this lane`);
  process.exit(2);
}
check('dsh_list_workspaces exposes the scratch workspace', typeof workspace.id === 'string' && typeof workspace.path === 'string',
  `${list.length} workspaces, using ${workspace.path}`);
mark('dsh_list_workspaces');

const credentials = await call('dsh_credential_status');
const credentialPayload = lastResponseText;
check('dsh_credential_status reports availability and source per ref',
  Array.isArray(credentials) && credentials.length > 0
  && credentials.every((row) => typeof row.credentialRef === 'string' && typeof row.credentialAvailable === 'boolean'
    && ['env', 'credentials_store', 'runtime', 'none'].includes(row.credentialSource)),
  `${credentials.length} refs`);
check('dsh_credential_status sees the credential this instance runs on',
  credentials.some((row) => row.credentialAvailable && row.credentialRef === 'DEEPSEEK_API_KEY'),
  credentials.filter((row) => row.credentialAvailable).map((row) => row.credentialRef).join(', ') || 'none available');
const secrets = homeSecrets();
const leaked = secrets.filter((value) => credentialPayload.includes(value));
check('dsh_credential_status never echoes raw secret material', leaked.length === 0,
  leaked.length === 0 ? `checked ${secrets.length} home secrets` : 'SECRET MATERIAL ON THE WIRE');
mark('dsh_credential_status');

// ── §2 session lifecycle ────────────────────────────────────────────────────
section('session lifecycle');

const created = await call('dsh_create_session', { workspace: workspace.id, title: 'Golden E2E' });
const sessionId = created.session_id;
check('dsh_create_session returns an idle session', created.status === 'idle' && typeof sessionId === 'string', sessionId);
mark('dsh_create_session');

const noTurn = await call('dsh_get_result', { session_id: sessionId });
check('dsh_get_result on a session without a turn fails closed', noTurn.failure?.error?.code === 'NO_RESULT_YET',
  noTurn.failure?.error?.code ?? 'no error');

// idempotency: request_id replay + conflict. Per-run id: the records live in the
// instance, so a fixed id makes the SECOND run conflict with the first run's
// session (the fingerprint covers session_id) before any turn is queued.
const message = 'Reply with exactly this token and nothing else: GOLDEN-OK';
const requestId = `golden-e2e-${RUN}`;
await call('dsh_send_message', { session_id: sessionId, message, request_id: requestId });
const replayed = await call('dsh_send_message', { session_id: sessionId, message, request_id: requestId });
check('replayed request_id does not queue a second turn', replayed.replayed === true);
const conflict = await call('dsh_send_message', { session_id: sessionId, message: 'DIFFERENT', request_id: requestId });
check('same request_id + different message conflicts', conflict.failure?.error?.code === 'REQUEST_ID_CONFLICT',
  conflict.failure?.error?.code ?? JSON.stringify(conflict).slice(0, 80));
mark('dsh_send_message');

const view = await call('dsh_get_session', { session_id: sessionId, max_items: 1, max_chars: 100 });
check('dsh_get_session reports identity and workspace',
  view.session_id === sessionId && String(view.workspace ?? '').endsWith(WORKSPACE_SUFFIX) && typeof view.created_at === 'string',
  `${view.title ?? '(untitled)'} · ${view.status}`);
check('dsh_get_session honours max_items (bounded history)', Array.isArray(view.messages) && view.messages.length <= 1,
  `${view.messages?.length ?? 'no'} rows`);
check('dsh_get_session honours max_chars', (view.messages ?? []).every((row) => typeof row.text !== 'string' || row.text.length <= 113),
  (view.messages ?? []).map((row) => String(row.text ?? '').length).join(', ') || 'no rows');
mark('dsh_get_session');

let round = await settle(sessionId);
if (round.state === 'waiting_for_user') {
  const label = await answerFirst(sessionId, { questions: round.questions }, 'Yes');
  console.log(`  (the model asked something first; answered "${label}")`);
  round = await settle(sessionId);
}
check('a real model turn completes', round.state === 'completed', round.state);
mark('dsh_get_task_status');

const completedStatus = await call('dsh_get_task_status', { session_id: sessionId });
check('dsh_get_task_status reports the terminal turn with its reason',
  completedStatus.status === 'completed' && completedStatus.last_turn?.turn >= 1 && completedStatus.live === true,
  `turn ${completedStatus.last_turn?.turn} · ${completedStatus.last_turn?.reason ?? 'no reason'} · live ${completedStatus.live}`);

const result = await call('dsh_get_result', { session_id: sessionId });
check('assistant text round-trips through dsh_get_result', String(result.assistant_text ?? '').includes('GOLDEN-OK'),
  JSON.stringify(String(result.assistant_text ?? '').slice(0, 80)));
mark('dsh_get_result');

// tool execution + changed_files (real workspace mutation)
const writeSession = await call('dsh_create_session', { workspace: workspace.id, title: 'Golden write' });
const writeId = writeSession.session_id;
const proofFile = join(workspace.path, 'golden-e2e-proof.txt');
await call('dsh_send_message', { session_id: writeId, message:
  'Use the write tool (not bash) to create the file golden-e2e-proof.txt in the workspace root containing exactly GOLDEN-FILE, then reply DONE.' });
const writeRound = await settle(writeId);
check('write turn completes', writeRound.state === 'completed', writeRound.state);
const writeResult = await call('dsh_get_result', { session_id: writeId });
check('tool calls are reported', (writeResult.tool_calls ?? []).length > 0,
  JSON.stringify((writeResult.tool_calls ?? []).map((tool) => tool.name)));
check('the write landed on disk', existsSync(proofFile) && readFileSync(proofFile, 'utf8').includes('GOLDEN-FILE'),
  existsSync(proofFile) ? JSON.stringify(readFileSync(proofFile, 'utf8').slice(0, 40)) : 'file absent');
// changed_files is a log projection: the paths EDIT-TOOL calls named. A bash
// redirect is not parsed (the wire description says so), so the prompt above
// pins the tool that makes this assertion meaningful.
check('changed_files reports the path the edit tool named', (writeResult.changed_files ?? []).some((file) => file.includes('golden-e2e-proof.txt')),
  JSON.stringify(writeResult.changed_files ?? []));

const sessions = await call('dsh_list_sessions', { limit: 5 });
const listed = Array.isArray(sessions) ? sessions : (sessions.sessions ?? sessions.items ?? []);
check('dsh_list_sessions pages newest-first within the limit',
  listed.length > 0 && listed.length <= 5 && listed.some((item) => item.session_id === sessionId), `${listed.length} rows`);
const filtered = await call('dsh_list_sessions', { workspace: workspace.id, limit: 100 });
const filteredRows = Array.isArray(filtered) ? filtered : (filtered.sessions ?? filtered.items ?? []);
check('dsh_list_sessions filters to one workspace',
  filteredRows.length > 0 && filteredRows.every((row) => row.workspace === undefined || String(row.workspace).endsWith(WORKSPACE_SUFFIX)),
  `${filteredRows.length} rows on ${workspace.path}`);
mark('dsh_list_sessions');

// ── §3 question relay (a forced two-question ask) ───────────────────────────
section('question relay');

const questionSession = await call('dsh_create_session', { workspace: workspace.id, title: 'Golden question' });
const askId = questionSession.session_id;
await call('dsh_send_message', { session_id: askId, message: [
  'Call the ask_user_question tool exactly once, with exactly these two questions and no others:',
  '[{"id":"q-color","question":"Which color should I use?","header":"Color","options":[{"label":"Red"},{"label":"Blue"}]},',
  ' {"id":"q-size","question":"Which size should I use?","header":"Size","options":[{"label":"Small"},{"label":"Large"}]}]',
  'Then, using the answers you receive, reply with exactly one line: COLORS=<answer to q-color> SIZE=<answer to q-size>',
].join('\n') });

// The bridge parks an ask asynchronously, and the tool/call event reaches the
// log first: a poll can catch a `source: 'log'` row that no live pending backs
// (answering its id fails closed). Wait for the PARKED row — the answerable one.
const parkedWait = await until(async () => {
  const status = await call('dsh_get_task_status', { session_id: askId });
  const all = status.waiting?.questions ?? [];
  const parked = all.filter((row) => row.source !== 'log');
  return parked.length > 0 ? { parked, all, state: status.status } : undefined;
}, 120_000, 800);
if (!parkedWait.ok) {
  check('the ask_user_question ask is parked for the driver', false, 'no parked question within 120s');
} else {
  // One ROW per answerable question; a multi-question ask therefore reports
  // several rows, and every one of them must come from the SAME ask. The
  // original defect was one ask surfacing twice under two id spaces (its parked
  // id and the host call id), which is what the row count below catches.
  const rows = parkedWait.value.parked;
  const asks = new Set(rows.map((item) => String(item.question_id).split('#')[0]));
  check('the ask_user_question ask is parked for the driver',
    rows.every((item) => String(item.question_id).startsWith('question-')), `${rows.length} answerable id(s)`);
  check('one open ask is reported once, under one id space (duplicates = defect)',
    asks.size === 1 && parkedWait.value.all.length === rows.length,
    `${parkedWait.value.all.length} row(s) from ${asks.size} ask(s): ${parkedWait.value.all.map((item) => item.question_id).join(', ')}`);

  const first = rows[0];
  const bogus = await call('dsh_answer_question', { question_id: first.question_id, session_id: askId, selected: ['NOT-AN-OFFERED-LABEL'] });
  check('a label the ask never offered is refused', bogus.failure?.error?.code === 'INVALID_ANSWER',
    bogus.failure?.error?.code ?? 'no error');

  // Answer each row on its OWN offered options; the last one must settle the ask.
  const sent = [];
  let last;
  let open = rows;
  for (let index = 0; index < open.length && index < 8; index += 1) {
    const row = open[index];
    const item = row.questions?.[0];
    const label = item?.options?.[index === 0 ? 0 : 1]?.label ?? item?.options?.[0]?.label ?? 'Yes';
    sent.push(label);
    last = await call('dsh_answer_question', { question_id: row.question_id, session_id: askId, selected: [label] });
    if (index === 0 && open.length > 1) {
      const stillOpen = (await call('dsh_get_task_status', { session_id: askId })).waiting?.questions ?? [];
      check('answering one item leaves the rest of the ask answerable',
        last.answered === true && stillOpen.length === open.length - 1 && typeof last.next_question_id === 'string',
        `${open.length}-question ask → ${stillOpen.length} still open, next_question_id=${last.next_question_id ?? '(absent)'}`);
    }
  }
  check('the last answer settles the whole ask',
    last?.answered === true && last?.remaining_questions === 0
    && ((await call('dsh_get_task_status', { session_id: askId })).waiting?.questions ?? []).length === 0,
    `${rows.length} row(s) answered, remaining ${last?.remaining_questions ?? '(absent)'}`);
  if (last?.answered === true) mark('dsh_answer_question');
  if (rows.length === 1) skip('multi-item ask answering', 'the model asked 1 question instead of the 2 it was told to ask');

  const resumed = await settle(askId);
  check('the turn resumes once the whole ask is answered', resumed.state === 'completed', resumed.state);
  if (resumed.state === 'completed') {
    const answerResult = await call('dsh_get_result', { session_id: askId });
    const text = String(answerResult.assistant_text ?? '');
    const missing = sent.filter((label) => !text.toLowerCase().includes(label.toLowerCase()));
    check('every answer reached the agent', missing.length === 0,
      missing.length === 0 ? `answers ${sent.join(' + ')} echoed` : `missing ${missing.join(', ')} in ${JSON.stringify(text.slice(0, 140))}`);
  }
}

// ── §4 approval relay (approve + reject, both fail-closed edges included) ───
section('approval relay');

const approvalSession = await call('dsh_create_session', { workspace: workspace.id, title: 'Golden approval' });
const approvalId = approvalSession.session_id;
const widerFile = join(homedir(), 'golden-e2e-wider.txt');
/**
 * A wider write only ASKS when the model requests the escalation: a plain call
 * that reaches outside the workspace is denied by the sandbox outright (no
 * approval, no relay). Asking for the escalation explicitly is what makes this
 * stage deterministic — the decision itself stays the human's, answered below.
 */
const escalationPrompt = (file, token, insistent = false) => [
  `Run the bash tool with exactly this command: printf ${token} > ${file}`,
  'The path is outside the workspace, so a plain call is refused by the sandbox:',
  'pass sandbox_permissions "danger-full-access" with a one-line justification so the permission',
  'gate asks me. I will answer the gate. Then reply DONE.',
  ...(insistent ? ['Do not stop at a denial and do not write anywhere else — request the escalation.'] : []),
].join(' ');

/**
 * Ask for one wider write and wait for the approval it should raise: long-poll
 * first (that IS the wait tool's job), answer any question the model asks
 * instead, retry once with the insistent wording when the turn ends without
 * asking at all.
 */
async function parkApprovalOn(sessionId, file, token) {
  for (const insistent of [false, true]) {
    await call('dsh_send_message', { session_id: sessionId, message: escalationPrompt(file, token, insistent) });
    const longWait = await call('dsh_wait_until_action_required', { session_id: sessionId, wait_seconds: 90 }, 120_000);
    let round = {
      approvals: longWait.approval === undefined ? [] : [longWait.approval],
      questions: longWait.question === undefined ? [] : [longWait.question],
      state: longWait.status,
    };
    if (round.approvals.length > 0) {
      check('dsh_wait_until_action_required reports the parked approval itself',
        longWait.approval?.approval_id !== undefined && longWait.goal_outcome === 'action_required',
        `goal_outcome ${longWait.goal_outcome} · waited ${longWait.waited_ms}ms`);
      mark('dsh_wait_until_action_required');
      return round;
    }
    if (round.questions.length > 0) {
      const label = await answerFirst(sessionId, round);
      console.log(`  (the model asked something first; answered "${label}")`);
      round = await settle(sessionId);
      if (round.approvals.length > 0) return round;
      continue;
    }
    round = await settle(sessionId);
    if (round.approvals.length > 0) return round;
    if (round.state !== 'completed') return round;
  }
  return { approvals: [], questions: [], state: 'timeout' };
}

if (autoGrant) {
  // Switch on: the point is that NOTHING parks and the wider write still lands.
  await call('dsh_send_message', { session_id: approvalId, message: escalationPrompt(widerFile, 'WIDER-PROOF') });
  const granted = await settle(approvalId, 240_000);
  check('autoApproveEscalations: nothing parked for a decision',
    granted.approvals.length === 0 && granted.questions.length === 0 && granted.state === 'completed',
    `state=${granted.state} · ${granted.approvals.length} approval(s) · ${granted.questions.length} question(s)`);
  const autoText = existsSync(widerFile) ? readFileSync(widerFile, 'utf8') : '';
  check('autoApproveEscalations: the wider write landed without anyone answering',
    autoText.includes('WIDER-PROOF'), existsSync(widerFile) ? JSON.stringify(autoText.slice(0, 60)) : 'file absent');
  rmSync(widerFile, { force: true });
  skip('the dsh_approve decision path', 'autoApproveEscalations is on: nothing parks to approve or reject');
} else {
  let parkedRound = await parkApprovalOn(approvalId, widerFile, 'WIDER-PROOF');
  if (parkedRound.approvals.length === 0) {
    skip('approval relay', `nothing asked (state=${parkedRound.state}); the instance preset must ask for wider writes`);
    skip('reject relay', 'no approval parked to reject');
  } else {
    mark('dsh_approve');
    const parked = parkedRound.approvals[0];
    check('approval relay parks with tool identity', typeof parked.tool_name === 'string' && typeof parked.call_id === 'string',
      `${parked.tool_name} / ${parked.call_id}`);
    check('parked approval carries the command text (wire honesty)', typeof parked.command === 'string' && parked.command !== '',
      parked.command === undefined ? 'command ABSENT on the wire' : String(parked.command).slice(0, 60));
    const mismatch = await call('dsh_approve', { session_id: 'session-not-mine', approval_id: parked.approval_id, decision: 'approve' });
    check('wrong session is rejected fail-closed', mismatch.failure?.error?.code === 'APPROVAL_SESSION_MISMATCH',
      mismatch.failure?.error?.code ?? 'no error');
    const approved = await call('dsh_approve', { session_id: approvalId, approval_id: parked.approval_id, decision: 'approve' });
    check('approve answers allowed-once', approved.outcome === 'allowed-once', String(approved.outcome));
    const after = await settle(approvalId);
    check('turn resumes after the relay answers', after.state === 'completed', after.state);
    // The approved escalation wrote into the real home directory — that file IS
    // the evidence the relay unblocked the wider write, so assert it and then
    // remove it rather than leaving litter behind on every run.
    const widerText = existsSync(widerFile) ? readFileSync(widerFile, 'utf8') : '';
    check('the approved wider write happened outside the workspace', widerText.includes('WIDER-PROOF'),
      existsSync(widerFile) ? JSON.stringify(widerText.slice(0, 60)) : 'file absent');
    rmSync(widerFile, { force: true });

    // reject path: the same relay must fail the call closed and write nothing.
    const rejectedFile = join(homedir(), 'golden-e2e-rejected.txt');
    const second = await parkApprovalOn(approvalId, rejectedFile, 'REJECT-PROOF');
    if (second.approvals.length === 0) {
      skip('reject relay', `no second approval parked (state=${second.state})`);
    } else {
      const rejected = await call('dsh_approve', { session_id: approvalId, approval_id: second.approvals[0].approval_id, decision: 'reject' });
      check('reject fails the call closed', rejected.outcome === 'rejected', String(rejected.outcome));
      const settled = await settle(approvalId, 240_000);
      check('the turn ends after the rejection', SETTLED.includes(settled.state), settled.state);
      check('the rejected write never happened', !existsSync(rejectedFile));
      rmSync(rejectedFile, { force: true });
    }
  }
}

// ── §5 cancel_task (a live turn, cancelled through the host's own mechanism) ─
section('cancel_task');

const cancelSession = await call('dsh_create_session', {
  workspace: workspace.id,
  title: 'Golden cancel',
  initial_message: 'Run exactly this bash command and nothing else, then reply DONE: sleep 25; echo CANCEL-PROBE',
});
const cancelId = cancelSession.session_id;
check('dsh_create_session(initial_message) starts the turn immediately', BUSY.includes(cancelSession.status), cancelSession.status);
const running = await until(async () => {
  const status = await call('dsh_get_task_status', { session_id: cancelId });
  return BUSY.includes(status.status) ? status : undefined;
}, 45_000, 400);
check('the cancel probe turn is in flight', running.ok === true, running.ok ? running.value.status : 'never left idle');
const cancelled = await call('dsh_cancel_task', { session_id: cancelId });
check('dsh_cancel_task cancels the live turn', cancelled.cancelled === true && cancelled.session_id === cancelId,
  JSON.stringify(cancelled).slice(0, 80));
mark('dsh_cancel_task');
const stopped = await until(async () => {
  const status = await call('dsh_get_task_status', { session_id: cancelId });
  return SETTLED.includes(status.status) ? status : undefined;
}, 90_000, 1000);
check('the cancelled turn ends cancelled (not silently completed)', stopped.ok === true && stopped.value.status === 'cancelled',
  stopped.ok ? stopped.value.status : 'still running after 90s');
const cancelledResult = await call('dsh_get_result', { session_id: cancelId });
check('dsh_get_result reports the aborted turn', cancelledResult.status === 'cancelled', String(cancelledResult.status));
const ghostCancel = await call('dsh_cancel_task', { session_id: 'session-definitely-absent' });
check('dsh_cancel_task on a session with no live agent fails closed', ghostCancel.failure?.error?.code === 'SESSION_NOT_LIVE',
  ghostCancel.failure?.error?.code ?? 'no error');

// ── §6 native goal lifecycle ────────────────────────────────────────────────
section('native goal lifecycle');

const goalA = `GOLDEN-GOAL-A ${RUN}: keep this goal active — write one line to golden-goal-log.txt per round and stop the round. Do not mark the goal complete.`;
const goalB = `GOLDEN-GOAL-B ${RUN}: the objective was revised.`;
const goalC = `GOLDEN-GOAL-C ${RUN}: revised again through dsh_update_goal.`;

const goalPort = await call('dsh_create_goal', { workspace: workspace.id, goal: goalA, max_goal_rounds: 8 });
const goalSession = goalPort.session_id;
check('dsh_create_goal creates a native goal on a session of its own',
  typeof goalSession === 'string' && goalPort.goal?.phase === 'active' && goalPort.goal?.objective === goalA,
  `${goalPort.goal?.phase} rev ${goalPort.goal?.revision}`);
check('dsh_create_goal relays the round budget', goalPort.goal?.max_goal_rounds === 8, String(goalPort.goal?.max_goal_rounds));
check('an armed goal keeps the driver in the loop',
  goalPort.continuation_required === true && goalPort.next_tool_call?.tool === 'dsh_wait_goal',
  `continuation_required=${goalPort.continuation_required}`);
mark('dsh_create_goal');

const reused = await call('dsh_create_goal', { workspace: workspace.id, goal: goalA, max_goal_rounds: 8 });
check('dsh_create_goal reuses an identical active goal idempotently',
  reused.session_id === goalSession && reused.existing_goal_reused === true && reused.goal?.revision === goalPort.goal?.revision,
  `same session ${reused.session_id === goalSession} · reused ${reused.existing_goal_reused}`);

const started = await call('dsh_start_goal', { workspace: workspace.id, session_id: goalSession, goal: goalA });
check('dsh_start_goal reuses the identical goal on an existing session',
  started.existing_goal_reused === true && started.session_id === goalSession, `reused ${started.existing_goal_reused}`);
mark('dsh_start_goal');
const foreign = await call('dsh_start_goal', { workspace: workspace.id, session_id: goalSession, goal: `${goalA} (different)` });
check('a second objective on a goal-bearing session fails closed', foreign.failure?.error?.code === 'GOAL_ALREADY_EXISTS',
  foreign.failure?.error?.code ?? 'no error');
const locked = await call('dsh_start_goal', { workspace: workspace.id, goal: `GOLDEN-GOAL-LOCK ${RUN}` });
check('a concurrent mutable goal on the same workspace is refused',
  locked.failure?.error?.code === 'WORKSPACE_LOCKED' && locked.failure?.error?.details?.status === 'waiting_for_workspace_lock',
  `${locked.failure?.error?.code ?? 'no error'} · ${locked.failure?.error?.details?.status ?? 'no details'}`);

const paused = await call('dsh_pause_goal', { session_id: goalSession });
check('dsh_pause_goal parks the durable phase and reports its checkpoint',
  paused.paused === true && paused.goal?.phase === 'paused' && paused.goal?.activation === 'disarmed'
  && typeof paused.checkpoint_revision === 'number' && paused.checkpoint_revision === paused.goal?.revision,
  `phase ${paused.goal?.phase} · checkpoint rev ${paused.checkpoint_revision}`);
mark('dsh_pause_goal');

// Cursor semantics are checked on a quiesced goal so "no new events" is a fact,
// not a race: the paused phase also proves the wait loop terminates.
await sleep(1500);
const waited = await call('dsh_wait_goal', { session_id: goalSession, wait_seconds: 1 }, 45_000);
check('dsh_wait_goal returns one bounded snapshot for a paused goal',
  waited.session_id === goalSession && waited.wait_seconds === 1 && waited.goal_outcome === 'ended'
  && waited.continuation_required === false && typeof waited.waited_ms === 'number',
  `outcome ${waited.goal_outcome} in ${waited.waited_ms}ms`);
check('dsh_wait_goal reports the shared progress cursor',
  typeof waited.progress_delta?.until_seq === 'number' && Array.isArray(waited.progress_delta?.new_events),
  `until_seq ${waited.progress_delta?.until_seq}`);
mark('dsh_wait_goal');
const catchUp = await call('dsh_wait_goal', { session_id: goalSession, wait_seconds: 1, since_seq: 0 }, 45_000);
check('since_seq reads from the caller cursor, not the shared baseline',
  catchUp.progress_delta?.since_seq === 0 && (catchUp.progress_delta?.new_events?.length ?? 0) > 0
  && catchUp.progress_delta?.until_seq >= 0,
  `until_seq ${catchUp.progress_delta?.until_seq} · ${catchUp.progress_delta?.new_events?.length ?? 0} events`);
const afterCatchUp = await call('dsh_wait_goal', { session_id: goalSession, wait_seconds: 1 }, 45_000);
check('a since_seq read does not advance the shared baseline',
  afterCatchUp.progress_delta?.new_events?.length === 0,
  `${afterCatchUp.progress_delta?.new_events?.length ?? 'no'} new events`);

const actionWait = await call('dsh_wait_until_action_required', { session_id: goalSession, wait_seconds: 2 }, 60_000);
check('dsh_wait_until_action_required returns the same 4-value outcome vocabulary',
  actionWait.goal_outcome === 'ended' && actionWait.wait_seconds === 2 && actionWait.continuation_required === false
  && typeof actionWait.progress_delta?.until_seq === 'number',
  `outcome ${actionWait.goal_outcome} waited ${actionWait.waited_ms}ms`);
if (actionWait.goal_outcome === 'ended') mark('dsh_wait_until_action_required');
const actionCatchUp = await call('dsh_wait_until_action_required', { session_id: goalSession, wait_seconds: 2, since_seq: 0 }, 60_000);
check('dsh_wait_until_action_required honours since_seq too',
  actionCatchUp.progress_delta?.since_seq === 0 && (actionCatchUp.progress_delta?.new_events?.length ?? 0) > 0,
  `${actionCatchUp.progress_delta?.new_events?.length ?? 0} events from seq 0`);

const resumed = await call('dsh_resume_goal', { session_id: goalSession });
check('dsh_resume_goal re-arms the paused goal',
  resumed.goal?.phase === 'active' && resumed.goal?.activation === 'armed'
  && resumed.goal?.revision > paused.goal?.revision && resumed.continuation_required === true,
  `phase ${resumed.goal?.phase} · rev ${paused.goal?.revision} → ${resumed.goal?.revision}`);
mark('dsh_resume_goal');

const revised = await call('dsh_revise_goal', { session_id: goalSession, goal: goalB, max_goal_rounds: 12 });
check('dsh_revise_goal edits the objective and the round budget',
  revised.goal?.objective === goalB && revised.goal?.max_goal_rounds === 12 && revised.goal?.revision > resumed.goal?.revision,
  `rev ${resumed.goal?.revision} → ${revised.goal?.revision} · budget ${revised.goal?.max_goal_rounds}`);
mark('dsh_revise_goal');
const stale = await call('dsh_revise_goal', { session_id: goalSession, goal: `${goalB} again`, expected_revision: 1 });
check('a stale expected_revision is refused', stale.failure?.error?.code === 'REVISION_CONFLICT',
  stale.failure?.error?.code ?? 'no error');

const pausedByUpdate = await call('dsh_update_goal', { session_id: goalSession, action: 'pause' });
check('dsh_update_goal action=pause parks the goal',
  pausedByUpdate.goal?.phase === 'paused' && pausedByUpdate.goal?.activation === 'disarmed', String(pausedByUpdate.goal?.phase));
const resumedByUpdate = await call('dsh_update_goal', { session_id: goalSession, action: 'resume' });
check('dsh_update_goal action=resume re-arms the goal',
  resumedByUpdate.goal?.phase === 'active' && resumedByUpdate.goal?.activation === 'armed', String(resumedByUpdate.goal?.phase));
const revisedByUpdate = await call('dsh_update_goal', { session_id: goalSession, action: 'revise', goal: goalC });
check('dsh_update_goal action=revise edits the objective',
  revisedByUpdate.goal?.objective === goalC && revisedByUpdate.goal?.revision > resumedByUpdate.goal?.revision,
  `rev ${resumedByUpdate.goal?.revision} → ${revisedByUpdate.goal?.revision}`);
mark('dsh_update_goal');

const stoppedGoal = await call('dsh_stop_goal', { session_id: goalSession });
check('dsh_stop_goal stops the goal and reports it was not already stopped',
  stoppedGoal.stopped === true && stoppedGoal.already_stopped === false, JSON.stringify(stoppedGoal).slice(0, 90));
mark('dsh_stop_goal');
const stoppedAgain = await call('dsh_stop_goal', { session_id: goalSession });
check('dsh_stop_goal is idempotent', stoppedAgain.stopped === true && stoppedAgain.already_stopped === true,
  `already_stopped=${stoppedAgain.already_stopped}`);
const afterStop = await call('dsh_revise_goal', { session_id: goalSession, goal: `${goalC} post-stop` });
check('a stopped goal is gone (native tombstone, not a live goal)', afterStop.failure?.error?.code === 'GOAL_NOT_FOUND',
  afterStop.failure?.error?.code ?? 'no error');
const noGoalWait = await call('dsh_wait_goal', { session_id: goalSession, wait_seconds: 1 }, 45_000);
check('dsh_wait_goal reports no_goal once the goal is cleared', noGoalWait.goal_outcome === 'no_goal', String(noGoalWait.goal_outcome));

// The plan really is embedded into the objective (audit A#4), and the workspace
// lock released by the stop above is reusable — this is the proof of both.
const planGoal = await call('dsh_start_goal', {
  workspace: workspace.id,
  goal: `GOLDEN-GOAL-PLAN ${RUN}`,
  plan: 'STEP-ONE: write one line to golden-goal-log.txt.',
  max_goal_rounds: 1,
});
check('dsh_start_goal embeds the plan into the objective',
  String(planGoal.goal?.objective ?? '').includes('STEP-ONE: write one line to golden-goal-log.txt.')
  && String(planGoal.goal?.objective ?? '').includes(`GOLDEN-GOAL-PLAN ${RUN}`),
  JSON.stringify(String(planGoal.goal?.objective ?? '').slice(0, 80)));
check('the workspace lock is reusable after a stop', planGoal.goal?.phase === 'active', String(planGoal.goal?.phase));
await call('dsh_pause_goal', { session_id: planGoal.session_id });
await call('dsh_stop_goal', { session_id: planGoal.session_id });

// ── §7 fail-closed edges ────────────────────────────────────────────────────
section('fail-closed edges');

const ghost = await call('dsh_get_task_status', { session_id: 'session-definitely-absent' });
check('dsh_get_task_status on an unknown session fails closed', ghost.failure?.error?.code === 'SESSION_NOT_FOUND',
  ghost.failure?.error?.code ?? 'no error');
const ghostView = await call('dsh_get_session', { session_id: 'session-definitely-absent' });
check('dsh_get_session on an unknown session fails closed', ghostView.failure?.error?.code === 'SESSION_NOT_FOUND',
  ghostView.failure?.error?.code ?? 'no error');
const ghostApproval = await call('dsh_approve', { session_id: sessionId, approval_id: 'approval-absent', decision: 'approve' });
check('unknown approval fails closed', ghostApproval.failure?.error?.code === 'APPROVAL_NOT_FOUND',
  ghostApproval.failure?.error?.code ?? 'no error');
const ghostQuestion = await call('dsh_answer_question', { question_id: 'question-absent', selected: [] });
check('unknown question fails closed', ghostQuestion.failure?.error?.code === 'QUESTION_NOT_FOUND',
  ghostQuestion.failure?.error?.code ?? 'no error');
const badWorkspace = await call('dsh_create_session', { workspace: '/tmp/never-registered-by-dsh' });
check('an unregistered workspace is refused', badWorkspace.failure?.error?.code === 'WORKSPACE_NOT_FOUND',
  badWorkspace.failure?.error?.code ?? 'no error');
const emptyGoal = await call('dsh_start_goal', { workspace: workspace.id, goal: '   ' });
check('an empty goal is refused before any session is created', emptyGoal.failure?.error?.code === 'EMPTY_GOAL',
  emptyGoal.failure?.error?.code ?? 'no error');

// ── §8 coverage ledger ──────────────────────────────────────────────────────
section('frozen-wire coverage');

const frozen = [...FROZEN_TOOL_NAMES].sort();
const missing = frozen.filter((name) => !driven.has(name));
const extra = [...driven.keys()].filter((name) => !frozen.includes(name));
for (const name of frozen) {
  const tier = driven.get(name);
  console.log(`  ${tier === 'happy' ? '✔' : tier === 'edge' ? '·' : '✖'} ${name}`
    + (tier === undefined ? '  ← never driven' : tier === 'edge' ? '  (fail-closed path only)' : ''));
}
const happy = [...driven.values()].filter((tier) => tier === 'happy').length;
check(`every frozen tool was driven over the real wire (${frozen.length - missing.length}/${frozen.length})`,
  missing.length === 0 && extra.length === 0,
  missing.length > 0 ? `never driven: ${missing.join(', ')}`
    : extra.length > 0 ? `driven but not frozen: ${extra.join(', ')}`
      : `${happy} happy path + ${driven.size - happy} fail-closed only`);

console.log(`\npass ${passed} · fail ${failed} · skip ${skipped}`);
process.exit(failed === 0 ? 0 : 1);