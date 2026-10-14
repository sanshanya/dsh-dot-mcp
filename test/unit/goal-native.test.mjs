/** Native goal mapping unit tests: phase/CAS/error surface of src/goal-native.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGoalsService } from '../helpers/native-goals.mjs';
import {
  nativeGet, nativeCreate, nativeEdit, nativePause, nativeResume, nativeClear, nativeWait,
  requireAgent, clampWaitSeconds, titleFromGoal,
} from '../../lib/goal-native.js';

const agent = (id = 's1', status = 'running') => ({ id, status });

/** ctx.agents 默认把任何 id 视作活着——本文件只关心 goal 语义。 */
function fakeCtx(goals = makeGoalsService(), knownAgents = undefined) {
  const agents = {
    get: (id) => knownAgents?.get(id) ?? agent(id),
    list: () => [...(knownAgents?.values() ?? [])],
  };
  return { goals, agents };
}

test('nativeGet tolerates a host without the goals service', () => {
  assert.equal(nativeGet({}, 's1'), undefined);
  assert.equal(nativeGet({ goals: undefined }, 's1'), undefined);
});

test('requireAgent 的缺失与正常读取', () => {
  const goals = makeGoalsService();
  const emptyAgents = { get: () => undefined, list: () => [] };
  assert.throws(() => requireAgent({ goals, agents: emptyAgents }, 'ghost'), (error) => error.code === 'SESSION_NOT_FOUND');
  const ctx = fakeCtx(goals);
  const normal = requireAgent(ctx, 's1');
  assert.equal(normal.id, 's1');
});

test('create → edit → pause → resume → clear 的 revision/相位阶梯', () => {
  const goals = makeGoalsService();
  const ctx = fakeCtx(goals);

  const created = nativeCreate(ctx, 's1', { objective: 'objective one', max_goal_rounds: 12 });
  assert.equal(created.revision, 1);
  assert.equal(created.phase, 'active');
  assert.equal(created.maxGoalRounds, 12);

  // 同会话未完成时再创 = GOAL_ALREADY_EXISTS
  assert.throws(() => nativeCreate(ctx, 's1', { objective: 'objective two' }), (error) => error.code === 'GOAL_ALREADY_EXISTS');

  const edited = nativeEdit(ctx, 's1', { objective: 'objective two' });
  assert.equal(edited.revision, 2);
  assert.equal(edited.objective, 'objective two');

  const paused = nativePause(ctx, 's1');
  assert.equal(paused.phase, 'paused');
  assert.equal(paused.revision, 3);

  const resumed = nativeResume(ctx, 's1');
  assert.equal(resumed.phase, 'active');
  assert.equal(resumed.revision, 4);

  nativeClear(ctx, 's1');
  assert.equal(goals.get(agent('s1')), undefined);
});

test('expected_revision 过期 = REVISION_CONFLICT（GOAL_STALE_REVISION 映射）', () => {
  const goals = makeGoalsService();
  const ctx = fakeCtx(goals);
  nativeCreate(ctx, 's1', { objective: 'one' });
  nativeEdit(ctx, 's1', { objective: 'two' }); // revision 2

  assert.throws(() => nativeEdit(ctx, 's1', { objective: 'three', expected_revision: 1 }), (error) => error.code === 'REVISION_CONFLICT');
  assert.throws(() => nativePause(ctx, 's1', 1), (error) => error.code === 'REVISION_CONFLICT');
  assert.throws(() => nativeResume(ctx, 's1', 1), (error) => error.code === 'REVISION_CONFLICT');
  assert.throws(() => nativeClear(ctx, 's1', 1), (error) => error.code === 'REVISION_CONFLICT');

  nativeClear(ctx, 's1', 2); // 命中
  assert.equal(goals.get(agent('s1')), undefined);
});

test('缺失 goal 的 mutators 抛 GOAL_NOT_FOUND；complete 相位的原生非法操作映射 GOAL_INVALID_TRANSITION', () => {
  const goals = makeGoalsService();
  const ctx = fakeCtx(goals);
  assert.throws(() => nativeEdit(ctx, 's1', { objective: 'x' }), (error) => error.code === 'GOAL_NOT_FOUND');
  assert.throws(() => nativePause(ctx, 's1'), (error) => error.code === 'GOAL_NOT_FOUND');
  assert.throws(() => nativeResume(ctx, 's1'), (error) => error.code === 'GOAL_NOT_FOUND');

  nativeCreate(ctx, 's1', { objective: 'one' });
  goals.__setPhase(agent('s1'), 'complete');
  assert.throws(() => nativeResume(ctx, 's1'), (error) => error.code === 'GOAL_INVALID_TRANSITION');
  assert.throws(() => nativePause(ctx, 's1'), (error) => error.code === 'GOAL_INVALID_TRANSITION');
});

test('goal 轮预算耗尽后 resume 被宿主拒绝（GOAL_INVALID_TRANSITION）', () => {
  const goals = makeGoalsService();
  const ctx = fakeCtx(goals);
  nativeCreate(ctx, 's1', { objective: 'one', max_goal_rounds: 1 });
  nativeResume(ctx, 's1'); // 激活？——不改轮次数；用 fake hook 或造假耗
  goals.__setPhase(agent('s1'), 'blocked', { roundsStarted: 1 });
  assert.throws(() => nativeResume(ctx, 's1'), (error) => error.code === 'GOAL_INVALID_TRANSITION');
});

test('nativeWait 在相位转终时立即返回 ended', async () => {
  const goals = makeGoalsService();
  const ctx = fakeCtx(goals);
  nativeCreate(ctx, 's1', { objective: 'one' });

  let now = 0;
  const sleep = async (ms) => { now += ms; goals.__setPhase(agent('s1'), 'complete'); };
  const wait = await nativeWait(ctx, 's1', 5, () => now, sleep);
  assert.equal(wait.outcome, 'ended');
  assert.ok(wait.waited_ms < 5000, 'wait 提前脱身而非耗尽窗口');
});

test('nativeWait 超窗口 = timeout；无 goal = no_goal', async () => {
  const goals = makeGoalsService();
  const ctx = fakeCtx(goals);
  nativeCreate(ctx, 's1', { objective: 'one' });

  let now = 0;
  const sleep = async (ms) => { now += ms; };
  const timeout = await nativeWait(ctx, 's1', 2, () => now, sleep);
  assert.equal(timeout.outcome, 'timeout');
  assert.ok(timeout.waited_ms >= 2000);
  assert.equal(timeout.goal?.phase, 'active');

  const missing = await nativeWait(ctx, 'ghost', 2, () => now, sleep);
  assert.equal(missing.outcome, 'no_goal');
});

test('clampWaitSeconds 将任意值收进 [1, MAX]', () => {
  assert.equal(clampWaitSeconds(0), 1);
  assert.equal(clampWaitSeconds(25), 25);
  assert.equal(clampWaitSeconds(999), 30);
  assert.equal(clampWaitSeconds(undefined), 25);
});

test('titleFromGoal 写 sessiion 名也落到首行短句', () => {
  assert.equal(titleFromGoal('Ship the release.\nRun tests too.'), 'Ship the release.');
  assert.ok(titleFromGoal('a '.repeat(200)).length <= 80 + 3);
});
