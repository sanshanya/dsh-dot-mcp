/**
 * Durable result attribution: one native goal generation, or the latest turn
 * when no goal is current. Timestamps alone cannot distinguish two goals created
 * in the same millisecond; only the host's goal/change create record can do so.
 */
import type { NativeGoalWire } from './goal-native.js';
import type { LooseEvent } from './session-facts.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Keep event types intact so both the facade and pure schema use this seam. */
export function selectResultEvents<T extends LooseEvent>(
  events: readonly T[],
  goal?: NativeGoalWire,
): readonly T[] {
  if (goal === undefined) {
    let start = 0;
    for (let index = 0; index < events.length; index += 1) {
      if (events[index]?.type === 'turn/start') start = index;
    }
    // Standalone pure-tool fixtures may already be scoped and have no turn row.
    return events.slice(start);
  }

  let start = -1;
  let end = events.length;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.type !== 'goal/change') continue;
    const change = record(event.data);
    if (change?.kind !== 'goal/change' || change.version !== 1) continue;
    const id = record(change.goal)?.id;
    if (change.operation === 'create') {
      if (id === goal.goal_id && start < 0) start = index;
      else if (start >= 0) { end = index; break; }
    } else if (start >= 0 && change.operation === 'clear'
      && record(change.cleared)?.id === goal.goal_id) {
      end = index;
      break;
    } else if (start >= 0 && change.operation === 'complete' && id === goal.goal_id) {
      // A completed goal cannot resume; subsequent ordinary turns are unrelated.
      end = index + 1;
      break;
    }
  }
  // The pinned host always persists a create row. Missing/corrupt attribution
  // fails closed: never borrow older work by guessing from a wall-clock value.
  return start < 0 ? [] : events.slice(start, end);
}
