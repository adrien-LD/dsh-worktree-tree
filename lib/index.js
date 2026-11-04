/**
 * `dsh-worktree-tree` Host half.
 *
 * Registers one read-only JSON RPC channel (`/dsh-worktree-tree`, endpoint
 * `snapshot`) that reports every registered Workspace together with its Git
 * worktree inventory and dirty state, plus a best-effort map of each Session's
 * current working directory. The client half renders it; this module never
 * writes files, never uses a shell and never mutates a repository.
 *
 * Snapshot value shape:
 * ```
 * {
 *   generatedAt: number,
 *   workspaces: Array<{
 *     workspaceId: string, path: string, title: string, repoRoot: string|null,
 *     worktrees: Array<{ path, branch, head, main, bare, locked, prunable, dirty }>,
 *     error?: 'not-a-git-repo'|'git-failed'
 *   }>,
 *   sessions: Record<sessionId, currentWorkingDirectory>
 * }
 * ```
 *
 * Wire protocol (see `@deepseek-ai/dsh-client-connection`): the handler returns
 * the generic RPC result envelope, so `ctx.connection.rpc.call(channel,
 * 'snapshot', payload)` resolves to `{ ok: true, value: Snapshot }`.
 *
 * @module dsh-worktree-tree
 */
import { resolve as resolvePath } from "node:path";
import { MAX_SESSION_CWDS, mergeSessionCwds, parseDirtyStatus, parseWorktreeList } from "./parse.js";

export const name = "worktree-tree";

// `connection` is injected lazily inside `apply` so the plugin still loads in a
// Host composition that has no Connection service (the RPC channel is simply
// absent there).
export const inject = ["workspaceRegistry", "subprocess", "sandbox", "sandboxPolicy"];

/** The RPC channel owned by this plugin (must satisfy the Connection grammar). */
export const CHANNEL = "/dsh-worktree-tree";

/** How long a successful snapshot is shared between callers. */
const SNAPSHOT_TTL_MS = 5_000;
/** How long a failed snapshot is shared before the next attempt. */
const SNAPSHOT_ERROR_TTL_MS = 2_000;
/** Per-command deadline. */
const COMMAND_TIMEOUT_MS = 8_000;
/** Global limit of concurrent Git child processes per snapshot build. */
const MAX_CONCURRENT_COMMANDS = 4;
/** Safety cap on the number of worktrees reported for one workspace. */
const MAX_WORKTREES_PER_WORKSPACE = 40;
/** Output bound for one Git command (worktree lists stay far below this). */
const MAX_OUTPUT_BYTES = 128 * 1024;
/** Termination grace period handed to the subprocess provider. */
const GRACE_MS = 3_000;
/** Environment override for the Git executable, mainly for tests. */
const GIT_ENV_OVERRIDE = "DSH_WORKTREE_TREE_GIT";

/**
 * Inherited Git selectors that would point a repo-local command at the wrong
 * repository or config tree; borrowed from the official worktree runtime.
 */
const GIT_ENV = Object.fromEntries(
  [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_CEILING_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_GRAFT_FILE",
    "GIT_REPLACE_REF_BASE",
    "GIT_ATTR_SOURCE",
  ].map((key) => [key, undefined]),
);

/** Resolve the configured Git executable (bare name by default). */
function gitExecutable() {
  const override = process.env[GIT_ENV_OVERRIDE];
  return typeof override === "string" && override.trim().length > 0 ? override.trim() : "git";
}

/**
 * Fuse the caller's cancellation with a command deadline.
 * @param {AbortSignal|undefined} upstream
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, dispose: () => void }}
 */
function createDeadline(upstream, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) controller.abort(upstream.reason);
  else upstream?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`worktree-tree: git command timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      upstream?.removeEventListener?.("abort", onAbort);
    },
  };
}

/** FIFO concurrency limiter shared by every Git command in one snapshot build. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= max || queue.length === 0) return;
    const entry = queue.shift();
    active += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .then(() => {
        active -= 1;
        pump();
      });
  };
  return function limit(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  };
}

/**
 * Spawn one bounded, collected command and return its stdout.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[]} argv - resolved executable plus literal arguments.
 * @param {AbortSignal} signal
 * @returns {Promise<string>} complete stdout text.
 */
async function collect(ctx, argv, signal) {
  const child = ctx.subprocess.spawn({
    argv,
    env: {
      ...GIT_ENV,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_NO_LAZY_FETCH: "1",
    },
    signal,
    graceMs: GRACE_MS,
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: MAX_OUTPUT_BYTES },
      stderr: { maxBytes: MAX_OUTPUT_BYTES },
    },
  });
  try {
    signal.throwIfAborted?.();
    const outcome = await child.done;
    const stdout = child.collected?.stdout?.readFrom(0)?.text ?? "";
    const stderr = child.collected?.stderr?.readFrom(0)?.text ?? "";
    if (outcome?.exitCode !== 0) {
      const error = new Error(
        `worktree-tree: git ${argv.slice(1).join(" ")} failed ` +
          `(${outcome?.signal ?? outcome?.exitCode ?? "unknown"}): ${stderr.trim()}`,
      );
      error.exitCode = outcome?.exitCode ?? null;
      error.stderr = stderr;
      error.stdout = stdout;
      throw error;
    }
    return stdout;
  } finally {
    try {
      child.terminate?.();
    } finally {
      await Promise.resolve(child.waitForExit?.()).catch(() => {});
    }
  }
}

/**
 * Run one read-only Git command under the resolved sandbox policy.
 *
 * If the sandbox backend cannot produce a confined argv the command falls back
 * to the plain executable (these commands only read), keeping the plugin usable
 * on Hosts whose containment runner is unavailable.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string[]} args - arguments after the executable.
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<string>} complete stdout text.
 */
async function runGit(ctx, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const deadline = createDeadline(options.signal, timeoutMs);
  try {
    const command = [await ctx.subprocess.resolveExecutable(gitExecutable(), undefined, deadline.signal), ...args];
    let argv = command;
    const policy = ctx.sandboxPolicy.resolve({});
    if (policy.mode !== "danger-full-access") {
      try {
        const confined = await ctx.sandbox.confine(command, { ...policy }, deadline.signal);
        if (Array.isArray(confined?.argv) && confined.argv.length > 0) argv = confined.argv;
      } catch {
        argv = command;
      }
    }
    return await collect(ctx, argv, deadline.signal);
  } finally {
    deadline.dispose();
  }
}

/**
 * Report whether one worktree has local changes.
 * @returns {Promise<boolean|null>} null when the command cannot answer.
 */
async function dirtyOf(ctx, worktreePath, limit, signal) {
  if (typeof worktreePath !== "string" || worktreePath.length === 0) return null;
  try {
    const stdout = await limit(() =>
      runGit(ctx, ["--no-optional-locks", "-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=normal"], {
        signal,
      }),
    );
    return parseDirtyStatus(stdout);
  } catch {
    return null;
  }
}

/**
 * Build the snapshot entry for one registered Workspace. Any per-workspace
 * failure is reported in `error` instead of rejecting the whole snapshot.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ id: string, path: string, title: string }} workspace
 * @param {<T>(task: () => Promise<T>) => Promise<T>} limit
 * @param {AbortSignal} signal
 */
async function snapshotWorkspace(ctx, workspace, limit, signal) {
  const entry = {
    workspaceId: String(workspace.id),
    path: resolvePath(workspace.path),
    title: typeof workspace.title === "string" ? workspace.title : "",
    repoRoot: null,
    worktrees: [],
  };

  let toplevel;
  try {
    toplevel = await limit(() =>
      runGit(ctx, ["-C", entry.path, "rev-parse", "--show-toplevel"], { signal }),
    );
  } catch {
    return { ...entry, error: "not-a-git-repo" };
  }
  const root = toplevel.trim();
  if (root.length === 0) return { ...entry, error: "not-a-git-repo" };
  entry.repoRoot = resolvePath(root);

  let listing;
  try {
    listing = await limit(() =>
      runGit(ctx, ["-C", entry.repoRoot, "worktree", "list", "--porcelain", "-z"], { signal }),
    );
  } catch {
    return { ...entry, error: "git-failed" };
  }

  const parsed = parseWorktreeList(listing, { repoRoot: entry.repoRoot });
  const selected = parsed.worktrees.slice(0, MAX_WORKTREES_PER_WORKSPACE);
  entry.worktrees = await Promise.all(
    selected.map(async (worktree) => ({
      ...worktree,
      path: worktree.path.length > 0 ? resolvePath(worktree.path) : worktree.path,
      dirty: worktree.bare ? null : await dirtyOf(ctx, worktree.path, limit, signal),
    })),
  );
  return entry;
}

/**
 * Read the current working directory of every Session, best effort.
 *
 * A cold Session only carries its initial `cwd` in its header; its current
 * directory may have moved. Two zero-cost readers fill the gap: the live
 * projection (connected Sessions) and the persisted projection cache (cold
 * Sessions, read without touching the session log). Missing optional services
 * degrade to `{}` — the worktree inventory must never fail because of this.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {AbortSignal} signal
 * @returns {Promise<Record<string, string>>}
 */
async function collectSessionCwds(ctx, signal) {
  try {
    const query = ctx.get?.("sessionQuery");
    if (query === undefined || typeof query.listSessions !== "function") return {};

    const records = await query.listSessions(signal);
    if (!Array.isArray(records) || records.length === 0) return {};

    const sessions = ctx.get?.("sessions");
    const workingDirectory = ctx.get?.("workingDirectory");
    const projectionCache = ctx.get?.("sessionProjectionCache");

    const liveLookup = (header) => {
      if (sessions === undefined || workingDirectory === undefined) return undefined;
      const live = sessions.get?.(header.id);
      if (live === undefined || live === null) return undefined;
      const cwd = workingDirectory.get?.(live);
      return typeof cwd === "string" ? cwd : undefined;
    };
    const cachedLookup = (header) => {
      if (projectionCache === undefined) return undefined;
      const snapshot = projectionCache.cachedSnapshot?.(header, ["workingDirectory"]);
      const cwd = snapshot?.values?.workingDirectory;
      return typeof cwd === "string" ? cwd : undefined;
    };

    return mergeSessionCwds(records, liveLookup, cachedLookup, MAX_SESSION_CWDS);
  } catch {
    // Session metadata is an optimisation, never a reason to fail the snapshot.
    return {};
  }
}

/**
 * Build one complete snapshot; every command goes through the shared limiter.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {AbortSignal} signal
 */
async function buildSnapshot(ctx, signal) {
  const limit = createLimiter(MAX_CONCURRENT_COMMANDS);
  const workspaces = ctx.workspaceRegistry.list();
  const [entries, sessions] = await Promise.all([
    Promise.all(workspaces.map((workspace) => snapshotWorkspace(ctx, workspace, limit, signal))),
    collectSessionCwds(ctx, signal),
  ]);
  return { generatedAt: Date.now(), workspaces: entries, sessions };
}

/** Generic RPC failure envelope. */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * Host plugin entry: mount the read-only snapshot RPC channel.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const lifetime = new AbortController();
  /** @type {{ at: number, promise: Promise<object>, ok: boolean }|null} */
  let cache = null;

  /** Share one in-flight snapshot and keep the result for a short TTL. */
  const getSnapshot = () => {
    const now = Date.now();
    if (cache !== null && now - cache.at < (cache.ok ? SNAPSHOT_TTL_MS : SNAPSHOT_ERROR_TTL_MS)) {
      return cache.promise;
    }
    const promise = buildSnapshot(ctx, lifetime.signal);
    const record = { at: now, promise, ok: true };
    cache = record;
    promise.then(
      () => {
        if (cache === record) cache.ok = true;
      },
      () => {
        if (cache === record) cache.ok = false;
      },
    );
    // Callers may all have gone away; never surface an unhandled rejection.
    promise.catch(() => {});
    return promise;
  };

  const handler = async (endpoint) => {
    if (endpoint !== "snapshot") {
      return failure("worktree-tree/unknown-endpoint", `unsupported endpoint: ${String(endpoint)}`);
    }
    try {
      return { ok: true, value: await getSnapshot() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure("worktree-tree/snapshot-failed", message);
    }
  };

  ctx.effect(
    () => () => {
      lifetime.abort(new Error("worktree-tree: plugin disposed"));
    },
    "dsh-worktree-tree: lifetime",
  );

  ctx.inject(["connection"], (scope) => {
    scope.effect(
      () => scope.connection.rpc.handle(CHANNEL, handler),
      "dsh-worktree-tree: rpc",
    );
  });
}
