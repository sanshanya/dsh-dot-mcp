/**
 * Low-level cleanup for temporary paths registered by a trusted host owner.
 * Session-log discovery is disabled: names and successful calls do not prove
 * creation, temporary intent, or ownership by the current goal.
 */
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SessionFacts, LooseEvent } from './session-facts.js';
import { isPathInsideWorkspace, pathsEqual } from './paths.js';

export type TempKind = 'worktree' | 'directory' | 'file';

/** Trusted internal ownership record; never construct one from model text or logs. */
export interface TempResource {
  path: string;
  kind: TempKind;
  session_id: string;
  goal_id: string;
  created_by_goal: true;
  temporary: true;
  seq: number;
}

export interface CleanupResult {
  removed: string[];
  warnings: string[];
}

export interface CleanupIo {
  exists(path: string): boolean;
  remove(path: string): void;
  removeWorktree?(path: string, workspacePath: string): void;
}

function normalizeWorkspacePath(path: string): string {
  return resolve(path);
}

/** Absolute path if `path` is inside `workspace` and is not the workspace root. */
export function resolveInsideWorkspace(path: string, workspace: string): string | undefined {
  const root = normalizeWorkspacePath(workspace);
  const abs = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (pathsEqual(abs, root)) return undefined;
  const rel = relative(root, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  if (rel.split(sep).includes('..')) return undefined;
  return abs;
}

export function isSafeToDelete(resource: TempResource, workspace: string): boolean {
  if (resource.temporary !== true || resource.created_by_goal !== true) return false;
  if (resource.path === '' || resource.session_id === '' || resource.goal_id === '') return false;
  // BOTH proofs, in this order. The lexical one is cheap and fs-free, but a
  // path can be lexically inside the workspace while an in-workspace symlink
  // points outside it — `mkdir -p ws/out/_release-verify` through a symlinked
  // `ws/out` records a path that lexically passes. The realpath one resolves
  // the link and refuses; it is the reason deletion cannot escape the
  // workspace (regression test: "cleanup refuses a target that escapes
  // through an in-workspace symlink").
  return resolveInsideWorkspace(resource.path, workspace) !== undefined
    && isPathInsideWorkspace(resource.path, workspace);
}

/**
 * Compatibility seam for callers that previously reconstructed ownership from
 * session logs. These inputs carry no trusted registration proving that the
 * current goal created a resource and explicitly designated it temporary.
 *
 * Reads and edits may name existing user files; mkdir -p may reuse a directory;
 * command/result text does not reliably identify the execution directory; and
 * a session can contain several goal generations. Neither successful calls nor
 * model-supplied ownership fields can authorize deletion. Until a host-owned
 * registration mechanism exists, fail closed and leave these paths untouched.
 */
export function discoverTempResources(_input: {
  facts: SessionFacts;
  events?: readonly LooseEvent[];
  sessionId: string;
  goalId: string;
  workspacePath: string;
}): TempResource[] {
  return [];
}

function defaultIo(): CleanupIo {
  return {
    exists: (path) => existsSync(path),
    remove: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    removeWorktree: (path, workspacePath) => {
      spawnSync('git', ['worktree', 'remove', '--force', path], {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
    },
  };
}

/**
 * Low-level deletion for trusted host registrations only. The caller must prove
 * current ownership and temporary intent; the checks here additionally enforce
 * containment. Plain ownership flags are not evidence obtained from a session.
 * Cleanup errors become warnings; they do not throw.
 */
export function cleanupTempResources(
  resources: readonly TempResource[],
  workspacePath: string,
  io: CleanupIo = defaultIo(),
): CleanupResult {
  const removed: string[] = [];
  const warnings: string[] = [];
  for (const resource of resources) {
    if (!isSafeToDelete(resource, workspacePath)) continue;
    const abs = resolveInsideWorkspace(resource.path, workspacePath);
    if (abs === undefined) continue;
    try {
      if (resource.kind === 'worktree' && io.removeWorktree !== undefined) {
        io.removeWorktree(abs, normalizeWorkspacePath(workspacePath));
      }
      if (io.exists(abs)) io.remove(abs);
      removed.push(abs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${abs}: ${message}`);
    }
  }
  return { removed, warnings };
}
