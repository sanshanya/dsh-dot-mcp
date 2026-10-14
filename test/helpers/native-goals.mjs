/**
 * In-test fake of the host's native GoalService (dsh-goal).
 * Mirrors the real state machine: full-snapshot mutations with revision CAS,
 * phases active|paused|blocked|complete + clear tombstones, process-local
 * activation edge. Tests use this to exercise the bridge's thin mapping
 * without loading the host package.
 */
class FakeGoalError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function makeGoalsService() {
  /** @type Map<string, {id: string, revision: number, objective: string, phase: string, maxGoalRounds: number}> one goal per agent id */
  const goals = new Map();
  let serial = 0;

  const viewOf = (record, agent) => {
    const activation = record.phase === 'active' ? 'armed' : 'disarmed';
    return {
      id: record.id,
      revision: record.revision,
      objective: record.objective,
      phase: record.phase,
      ...(record.blockedReason === undefined ? {} : { blockedReason: record.blockedReason }),
      maxGoalRounds: record.maxGoalRounds,
      roundsStarted: record.roundsStarted,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      sessionId: agent.id,
      activation,
    };
  };

  const recordOf = (agent) => goals.get(agent.id);
  const expectRef = (record, ref) => {
    if (ref.revision !== record.revision) {
      throw new FakeGoalError(`expected revision ${ref.revision} but current revision is ${record.revision}`, 'GOAL_STALE_REVISION');
    }
  };

  return {
    get(agent) {
      const record = recordOf(agent);
      return record === undefined ? undefined : viewOf(record, agent);
    },
    create(agent, request) {
      const current = recordOf(agent);
      if (current !== undefined && current.phase !== 'complete') {
        throw new FakeGoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS');
      }
      if (typeof request?.objective !== 'string' || request.objective.trim() === '') {
        throw new FakeGoalError('objective must be non-empty', 'GOAL_INVALID_OBJECTIVE');
      }
      const now = Date.now();
      const record = {
        id: `goal-${++serial}`,
        revision: 1,
        objective: request.objective,
        phase: 'active',
        maxGoalRounds: request.maxGoalRounds ?? 256,
        roundsStarted: 0,
        createdAt: now,
        updatedAt: now,
      };
      goals.set(agent.id, record);
      return viewOf(record, agent);
    },
    edit(agent, ref, request) {
      const record = recordOf(agent);
      if (record === undefined) throw new FakeGoalError('no goal on this session', 'GOAL_NOT_FOUND');
      expectRef(record, ref);
      if (request.objective === undefined && request.maxGoalRounds === undefined) {
        throw new FakeGoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT');
      }
      record.revision += 1;
      if (request.objective !== undefined) record.objective = request.objective;
      if (request.maxGoalRounds !== undefined) record.maxGoalRounds = request.maxGoalRounds;
      record.updatedAt = Date.now();
      return viewOf(record, agent);
    },
    pause(agent, ref) {
      const record = recordOf(agent);
      if (record === undefined) throw new FakeGoalError('no goal on this session', 'GOAL_NOT_FOUND');
      expectRef(record, ref);
      if (record.phase !== 'active') throw new FakeGoalError(`pause requires phase active (got ${record.phase})`, 'GOAL_INVALID_TRANSITION');
      record.phase = 'paused';
      record.revision += 1;
      record.updatedAt = Date.now();
      return viewOf(record, agent);
    },
    resume(agent, ref) {
      const record = recordOf(agent);
      if (record === undefined) throw new FakeGoalError('no goal on this session', 'GOAL_NOT_FOUND');
      expectRef(record, ref);
      if (!['active', 'paused', 'blocked'].includes(record.phase)) {
        throw new FakeGoalError(`resume rejects phase ${record.phase}`, 'GOAL_INVALID_TRANSITION');
      }
      if (record.roundsStarted >= record.maxGoalRounds) {
        throw new FakeGoalError(`goal "${record.id}" exhausted ${record.maxGoalRounds} goal rounds`, 'GOAL_INVALID_TRANSITION');
      }
      record.phase = 'active';
      record.revision += 1;
      record.updatedAt = Date.now();
      return viewOf(record, agent);
    },
    clear(agent, ref) {
      const record = recordOf(agent);
      if (record === undefined) throw new FakeGoalError('no goal on this session', 'GOAL_NOT_FOUND');
      expectRef(record, ref);
      goals.delete(agent.id);
      return { id: record.id, revision: record.revision + 1 };
    },
    /** Test hook: force a phase without revision bump. */
    __setPhase(agent, phase, extras = {}) {
      const record = recordOf(agent);
      if (record === undefined) return;
      record.phase = phase;
      Object.assign(record, extras);
    },
    __count() {
      return goals.size;
    },
  };
}
