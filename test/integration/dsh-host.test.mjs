// Run in a disposable copy with @deepseek-ai/dsh@0.2.1-rc.2 installed.
// Real Cordis, AgentLoop, V3 JSONL, approvals and questions; no credentials or model adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
// DSH 0.2.1-rc.2 dropped the default class export in favor of the loader row
// convention ({ name, Config, apply }); ctx.plugin accepts a { apply } object
// directly, so the namespace import mounts the same way the loader mounts it.
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Questions from '@deepseek-ai/dsh-user-questions';
import Approval from '@deepseek-ai/dsh-user-approval';
import Title from '@deepseek-ai/dsh-session-title';
import Goals from '@deepseek-ai/dsh-goal';
import { Bridge } from '../../lib/bridge.js';

/**
 * Poll a synchronous predicate until it answers, or fail loudly at the bound.
 * The approval relay parks on a later tick, so a bare setImmediate read is a
 * race the lane would lose on a loaded machine.
 * @param probe - predicate polled every 10ms.
 * @param timeoutMs - bound before giving up.
 * @returns the first truthy result.
 */
async function waitFor(probe, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > until) throw new Error('waitFor: condition never held');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('real DSH: explicit setup, V3 read/cold resume, question/approval and teardown', { timeout: 30000 }, async () => {
  const tempRoot = await realpath(tmpdir());
  const home = await mkdtemp(join(tempRoot, 'bridge-dsh-contract-'));
  const ctx = new Context();
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  let handle;
  try {
    for (const plugin of [Agents, Sessions, Projections, SystemPrompt, Tools, Llm, Questions, Approval, Goals]) {
      await ctx.plugin(plugin, {});
    }
    await ctx.plugin(Title, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 });
    await ctx.plugin(Persistence, { root: join(home, 'sessions') });
    await ctx.plugin(AgentLoop, {});
    const config = { dshHome: home, sessionMaxItems: 10, sessionMaxChars: 500 };
    let bridge;
    const fixtureInject = ['agents', 'sessions', 'sessionPersistence', 'sessionTitle', 'goals'];
    const firstBridgeFork = ctx.plugin({ name: 'first-contract-bridge', inject: fixtureInject, apply(scope) {
      bridge = new Bridge(scope, config, log);
      bridge.start();
    } });
    await waitFor(() => bridge, 5000);
    const setup = await bridge.composeSetupFor(undefined);
    handle = await ctx.agents.create({ sessionId: SessionId('bridge-contract'), meta: { cwd: home }, setup: setup.setup });
    const { agent } = handle;
    bridge.adopt(agent.id);
    assert.equal((await bridge.getSession(agent.id)).status, 'idle');
    const asking = ctx.userQuestions.ask({ agent, questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] });
    await new Promise(resolve => setImmediate(resolve));
    const question = [...bridge['relays'].questions.values()][0];
    assert.ok(question);
    await bridge.answerQuestion(question.id, agent.id, { selected: ['Yes'] });
    assert.deepEqual(await asking, { answers: [{ id: 'q', selected: ['Yes'] }] });

    agent.session.append('turn/start', { turn: 1 });
    // Approval on a MANAGED session is a relay, never a local verdict: with no
    // host client attached the request parks (its promise stays pending) until
    // the driver answers through dsh_approve → bridge.approve(). Asserting the
    // final word alone would hang here forever once the relay became
    // park-by-default — which is exactly how this lane went red unnoticed.
    const deciding = ctx.approval.request({ agent, toolName: 'read' });
    const parked = await waitFor(() => [...bridge['relays'].approvals.values()][0], 5000);
    assert.equal(parked.sessionId, agent.id);
    assert.equal(parked.toolName, 'read');
    const pendingView = await bridge.getTaskStatus(agent.id);
    assert.equal(pendingView.waiting.approvals.length, 1, 'native audit and parked lane report one ask even without callId');
    assert.equal(pendingView.waiting.approvals[0].source, 'parked');
    assert.equal(pendingView.waiting.approvals[0].approval_id, parked.id);
    const answered = await bridge.approve(agent.id, pendingView.waiting.approvals[0].approval_id, 'approve');
    assert.equal(answered.outcome, 'allowed-once');
    assert.equal(await deciding, 'allowed-once');
    const calledApproval = ctx.approval.request({ agent, toolName: 'read', callId: 'approval-read', reason: 'fixture' });
    await waitFor(() => bridge['relays'].approvals.size === 1, 5000);
    const calledView = await bridge.getTaskStatus(agent.id);
    assert.equal(calledView.waiting.approvals.length, 1, 'callId correlation does not duplicate the native audit identity');
    assert.equal(calledView.waiting.approvals[0].call_id, 'approval-read');
    await bridge.approve(agent.id, calledView.waiting.approvals[0].approval_id, 'reject');
    assert.equal(await calledApproval, 'rejected');
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

    // The workspace registry is a fixture; GoalService, AgentLoop and JSONL are
    // real. No goal-round driver/model adapter is mounted, so these native
    // control-plane operations cannot make paid model calls.
    const workspace = { id: 'contract', path: home, title: 'contract', attachSession: async () => {} };
    const resolveWorkspace = async input => { assert.equal(input, 'contract'); return workspace; };
    bridge.resolveWorkspace = resolveWorkspace;
    const goalInput = { workspace: 'contract', session_id: agent.id, goal: 'native contract', request_id: 'native-create' };
    const started = await bridge.startGoal(goalInput);
    assert.equal(started.goal.activation, 'armed');
    const revised = await bridge.reviseGoal({ session_id: agent.id, goal: 'revised native contract', expected_revision: 1 });
    assert.equal(revised.goal.revision, 2);

    let cancels = 0;
    const originalCancel = agent.cancel.bind(agent);
    agent.cancel = (...args) => { cancels++; originalCancel(...args); };
    let maintenanceAborted = false;
    const maintenance = agent.runMaintenance(signal => new Promise(resolve => {
      signal.addEventListener('abort', () => { maintenanceAborted = true; resolve(); }, { once: true });
    }));
    await assert.rejects(bridge.updateGoal({ session_id: agent.id, action: 'pause', expected_revision: 1 }), error => error.code === 'REVISION_CONFLICT');
    assert.equal(cancels, 0, 'a rejected native CAS has no cancellation side effect');
    assert.equal(maintenanceAborted, false);
    const paused = await bridge.updateGoal({ session_id: agent.id, action: 'pause', expected_revision: 2 });
    assert.equal(paused.goal.phase, 'paused');
    assert.equal(paused.goal.revision, 3);
    assert.equal(maintenanceAborted, true, 'pause also cancels maintenance while public status is idle');
    await maintenance;
    agent.cancel = originalCancel;
    assert.equal((await bridge.pauseGoal(agent.id)).checkpoint_revision, 3, 'pause is idempotent');
    const armed = await bridge.resumeGoal(agent.id, undefined, 3);
    assert.equal(armed.goal.revision, 4);
    assert.equal(armed.goal.activation, 'armed');
    await bridge.getTaskStatus(agent.id);
    assert.equal(bridge.workspaceGuard.getLock(home).sessionId, agent.id, 'completed turn is not an ended armed goal');
    await ctx.sessionPersistence.flush();
    // A real plugin reload must unregister the old relay hooks. Merely creating
    // a second Bridge leaves the original driver holding native asks forever.
    await firstBridgeFork.dispose();
    await handle.dispose();
    handle = undefined;
    assert.equal(ctx.agents.get(agent.id), undefined);
    let restarted;
    ctx.plugin({ name: 'restarted-contract-bridge', inject: fixtureInject, apply(scope) {
      restarted = new Bridge(scope, config, log);
      restarted.resolveWorkspace = resolveWorkspace;
      restarted.start();
    } });
    await waitFor(() => restarted, 5000);
    const cold = await restarted.getSession(agent.id);
    assert.equal(cold.status, 'completed');
    assert.equal((await restarted.listSessions({}))[0].session_id, agent.id);
    const replay = await restarted.startGoal(goalInput);
    assert.equal(replay.session_id, agent.id);
    assert.equal(replay.goal.goal_id, started.goal.goal_id);
    assert.equal(replay.goal.revision, 4);
    assert.equal(replay.goal.activation, 'disarmed', 'loading a persisted goal cannot re-arm it');
    assert.equal(replay.existing_goal_reused, true);
    assert.equal(replay.continuation_required, false);
    assert.equal(ctx.agents.list().length, 1, 'cold retry never creates another session');
    const resumed = ctx.agents.get(agent.id);
    assert.equal((await restarted.getSession(agent.id)).status, 'completed');
    const approval = resumed.session.snapshotEvents().find(event => event.type === 'approval/decided');
    assert.equal(approval.data.outcome, 'allowed-once');
    assert.equal((await restarted.resumeGoal(agent.id, undefined, 4)).goal.activation, 'armed');
    assert.equal((await restarted.stopGoal(agent.id)).already_stopped, false);
    assert.equal(ctx.goals.get(resumed), undefined);
    await assert.rejects(restarted.startGoal(goalInput), error => error.code === 'GOAL_NOT_FOUND');
    assert.equal(ctx.agents.list().length, 1);
    // Maintenance with no native goal still hides behind public idle status;
    // stop must cancel it and await whenIdle before returning.
    const goallessMaintenanceAborted = Promise.withResolvers();
    const goallessMaintenance = resumed.runMaintenance(signal => new Promise(resolve => {
      signal.addEventListener('abort', () => { goallessMaintenanceAborted.resolve(true); resolve(); }, { once: true });
    }));
    const secondStop = await restarted.stopGoal(agent.id);
    assert.equal(secondStop.already_stopped, true);
    assert.equal(await goallessMaintenanceAborted.promise, true, 'whenIdle-tracked maintenance is cancelled even with no goal');
    await goallessMaintenance;

    // Native question service + bridge stop preserve the human's partial batch
    // answers, rather than inventing the rest or discarding the answered item.
    const batchAsk = ctx.userQuestions.ask({ agent: resumed, questions: [
      { id: 'partial-first', question: 'First?', options: [{ label: 'Yes' }] },
      { id: 'partial-second', question: 'Second?', options: [{ label: 'No' }] },
    ] });
    await waitFor(() => restarted['relays'].questions.size === 2, 5000);
    const batchView = await restarted.getTaskStatus(resumed.id);
    await restarted.answerQuestion(batchView.waiting.questions[0].question_id, resumed.id, { selected: ['Yes'] });
    await restarted.stopGoal(resumed.id);
    assert.deepEqual(await batchAsk, { answers: [{ id: 'partial-first', selected: ['Yes'] }] });
    assert.equal(restarted['relays'].questionBatches.size, 0);

    // Synthetic tool evidence in a REAL session and REAL GoalService; no model
    // or round driver is mounted, so this exercises persisted boundaries free
    // of credentials, actual file writes, Git remotes, and model quota.
    const prior = await restarted.startGoal({ workspace: 'contract', session_id: resumed.id, goal: 'old release evidence' });
    resumed.session.append('turn/start', { turn: 2 });
    const appendToolEvidence = (callId, name, args, output) => {
      resumed.session.append('tool/call', { turn: 2, step: 0, callId, name, arguments: JSON.stringify(args) });
      resumed.session.append('tool/result', { turn: 2, step: 0, message: createUserMessage({
        source: { kind: 'tool', callId }, content: [{ type: 'tool', callId, isError: false, content: output }],
      }) }, { surfaceOp: 'append' });
    };
    const repository = 'https://github.com/synthetic/contract.git';
    const sha = 'a'.repeat(40);
    appendToolEvidence('old-test-proof', 'bash', { command: 'npm test' }, 'Tests: 7 passed, 7 total\n[exit code: 0]');
    appendToolEvidence('old-push-proof', 'bash', { command: `git push ${repository} ${sha}:refs/heads/main` }, 'ok\n[exit code: 0]');
    appendToolEvidence('old-remote-proof', 'bash', { command: `git ls-remote ${repository} refs/heads/main` }, `${sha}\trefs/heads/main\n[exit code: 0]`);
    appendToolEvidence('old-write-proof', 'write', { file_path: 'synthetic-old.ts' }, 'ok');
    resumed.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    const priorResult = await restarted.getStructuredResult(resumed.id);
    assert.equal(priorResult.tests.pass, 7);
    assert.equal(priorResult.remote.push_verified, true);
    ctx.goals.complete(resumed, { id: prior.goal.goal_id, revision: prior.goal.revision });
    const replacement = await restarted.startGoal({ workspace: 'contract', goal: 'entirely new goal' });
    assert.equal(replacement.session_id, resumed.id);
    assert.notEqual(replacement.goal.goal_id, prior.goal.goal_id);
    const freshResult = await restarted.getStructuredResult(resumed.id);
    assert.equal(freshResult.goal.goal_id, replacement.goal.goal_id);
    assert.equal(freshResult.goal.finished_at, undefined);
    assert.equal(freshResult.tests.counts_known, false);
    assert.deepEqual(freshResult.tests.evidence_ids, []);
    assert.deepEqual(freshResult.changes.changed_files, []);
    assert.equal(freshResult.remote.push_verified, false);
    assert.equal(freshResult.provenance.originating_step, undefined);

    const audit = await restarted.startGoal({ workspace: 'contract', goal: 'read-only native audit', read_only: true });
    const auditAgent = ctx.agents.get(audit.session_id);
    ctx.goals.complete(auditAgent, { id: audit.goal.goal_id, revision: audit.goal.revision });
    await assert.rejects(restarted.startGoal({ workspace: 'contract', goal: 'must acquire a writer lock', read_only: false }),
      error => error.code === 'WORKSPACE_LOCKED');
    assert.equal(ctx.goals.get(auditAgent).id, audit.goal.goal_id, 'denied writer did not replace completed audit');
    assert.equal(ctx.goals.get(resumed).activation, 'armed');
    assert.equal(restarted.workspaceGuard.getLock(home).sessionId, resumed.id);
    await restarted.stopGoal(resumed.id);
    await restarted.stopGoal(auditAgent.id);
  } finally {
    if (handle) await handle.dispose();
    await ctx.fiber.dispose();
    assert.equal(await realpath(home), home);
    assert.equal(dirname(home), tempRoot);
    assert.ok(home.startsWith(join(tempRoot, 'bridge-dsh-contract-')));
    await rm(home, { recursive: true, force: true });
  }
});
