/**
 * Pure parsers for the read-only Git commands used by the `worktree-tree` Host
 * half. Kept free of Cordis/DSH imports so `node --test` can exercise them in
 * isolation.
 * @module dsh-worktree-tree/parse
 */

/** Prefixes that can open a porcelain field line other than `worktree`. */
const NON_WORKTREE_FIELD = /^(?:HEAD |branch |bare$|locked(?: |$)|prunable(?: |$)|detached$)/;

/** Decode a Buffer/string/typed-array command output into text. */
function asText(input) {
  if (typeof input === "string") return input;
  if (input === null || input === undefined) return "";
  if (input instanceof Uint8Array) return new TextDecoder("utf-8").decode(input);
  return String(input);
}

/** Drop a single trailing CR and any trailing slashes (filesystem root kept intact). */
function trimPath(value) {
  const withoutCr = value.endsWith("\r") ? value.slice(0, -1) : value;
  if (withoutCr.length > 1) return withoutCr.replace(/\/+$/, "");
  return withoutCr;
}

/** Compare two absolute path spellings ignoring their trailing slash. */
function samePath(left, right) {
  return trimPath(left) === trimPath(right);
}

/** `refs/heads/x` becomes `x`; an empty ref becomes null. */
function normalizeBranch(ref) {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  return name.length === 0 ? null : name;
}

/**
 * Split one NUL-delimited chunk into field lines.
 *
 * `git worktree list --porcelain -z` has two shapes in the wild:
 * - every field line is NUL-terminated (git >= 2.7 prints an extra NUL for the
 *   blank record separator, so records look double-NUL separated), and
 * - some emulations terminate the whole record with NUL while separating its
 *   fields with newlines.
 *
 * A chunk therefore either holds exactly one field (possibly a path that
 * itself contains newlines) or a full newline-separated record. The presence
 * of a continuation line that looks like a porcelain field distinguishes the
 * two without losing paths that contain newlines.
 */
function splitChunk(chunk) {
  const text = chunk.endsWith("\r") ? chunk.slice(0, -1) : chunk;
  if (!text.includes("\n")) return [text];
  const lines = text.split("\n");
  const looksLikeRecord = lines.slice(1).some((line) => {
    const value = line.endsWith("\r") ? line.slice(0, -1) : line;
    return value.length > 0 && NON_WORKTREE_FIELD.test(value);
  });
  return looksLikeRecord ? lines : [text];
}

/**
 * Parse `git worktree list --porcelain -z` output.
 *
 * Field lines handled: `worktree <path>`, `HEAD <sha>`, `branch <ref>`,
 * `bare`, `detached`, `locked`, `locked <reason>`, `prunable`,
 * `prunable <reason>`.
 *
 * @param {Buffer|string|Uint8Array} input - raw command stdout.
 * @param {{ repoRoot?: string }} [options] - the workspace's repository root,
 *   used to mark the worktree that owns it as `main` (the first porcelain
 *   record is the fallback when no path matches).
 * @returns {{ repoRoot?: string, worktrees: Array<{
 *   path: string, branch: string|null, head: string|null, main: boolean,
 *   bare: boolean, locked: string|null, prunable: boolean
 * }> }}
 */
export function parseWorktreeList(input, options = {}) {
  const text = asText(input);
  const records = [];
  let current = null;

  const finalize = () => {
    if (current !== null) records.push(current);
    current = null;
  };

  const begin = (path) => {
    finalize();
    current = {
      path,
      head: null,
      branch: null,
      bare: false,
      locked: null,
      prunable: false,
    };
  };

  const applyField = (rawField) => {
    const line = rawField.endsWith("\r") ? rawField.slice(0, -1) : rawField;
    if (line.length === 0) {
      finalize();
      return;
    }
    if (line === "worktree") {
      begin("");
      return;
    }
    if (line.startsWith("worktree ")) {
      begin(line.slice("worktree ".length));
      return;
    }
    // Field lines can only follow a `worktree` header in valid porcelain output;
    // tolerate stray fields by ignoring them.
    if (current === null) return;
    if (line === "detached") {
      current.branch = null;
      return;
    }
    if (line === "bare") {
      current.bare = true;
      return;
    }
    if (line === "locked") {
      current.locked = "locked";
      return;
    }
    if (line.startsWith("locked ")) {
      const reason = line.slice("locked ".length);
      current.locked = reason.length > 0 ? reason : "locked";
      return;
    }
    if (line === "prunable") {
      current.prunable = true;
      return;
    }
    if (line.startsWith("prunable ")) {
      current.prunable = true;
      return;
    }
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
      return;
    }
    if (line.startsWith("branch ")) {
      current.branch = normalizeBranch(line.slice("branch ".length));
    }
  };

  for (const chunk of text.split("\0")) {
    if (chunk.length === 0) {
      // Blank record separator (the double-NUL layout).
      finalize();
      continue;
    }
    for (const field of splitChunk(chunk)) applyField(field);
  }
  finalize();

  const repoRoot =
    typeof options.repoRoot === "string" && options.repoRoot.length > 0 ? options.repoRoot : undefined;
  // The worktree that owns the workspace's repository root is the primary one;
  // the first porcelain record is the fallback when no path matches exactly
  // (symlinked spellings, emulated output).
  const rootMatches = repoRoot !== undefined && records.some((record) => samePath(record.path, repoRoot));

  const worktrees = records.map((record, index) => ({
    path: record.path,
    branch: record.bare ? null : record.branch,
    head: record.head,
    main: rootMatches ? samePath(record.path, repoRoot) : index === 0,
    bare: record.bare,
    locked: record.locked,
    prunable: record.prunable,
  }));

  return repoRoot === undefined ? { worktrees } : { repoRoot, worktrees };
}

/**
 * Interpret `git status --porcelain=v1` stdout: any record means a dirty tree.
 * NUL bytes are ignored so the parser also accepts `-z`-flavoured input.
 *
 * @param {Buffer|string|Uint8Array} input - raw command stdout.
 * @returns {boolean} whether the worktree has tracked or untracked changes.
 */
export function parseDirtyStatus(input) {
  return asText(input).replace(/\0/g, "").trim().length > 0;
}

/** Default cap on the number of session cwds reported in one snapshot. */
export const MAX_SESSION_CWDS = 5000;

/**
 * Merge the "current working directory" of every listed Session.
 *
 * A cold (not live) Session's `header.cwd` is only its original directory, so
 * callers supply two cheap readers for its live current value:
 * `liveLookup` (an in-memory projection of a connected Session) wins over
 * `cachedLookup` (the zero-log projection cache), which wins over the initial
 * header cwd. Missing, empty and non-string values are skipped.
 *
 * @param {Array<{ header?: { id?: string, cwd?: string } }>} records -
 *   `sessionQuery.listSessions()` records (or bare headers).
 * @param {(header: { id: string, cwd?: string }) => string|null|undefined} [liveLookup]
 * @param {(header: { id: string, cwd?: string }) => string|null|undefined} [cachedLookup]
 * @param {number} [limit] - maximum number of sessions to report.
 * @returns {Record<string, string>} session id to absolute working directory.
 */
export function mergeSessionCwds(records, liveLookup, cachedLookup, limit = MAX_SESSION_CWDS) {
  const cwds = {};
  if (!Array.isArray(records) || !Number.isSafeInteger(limit) || limit <= 0) return cwds;

  let accepted = 0;
  for (const record of records) {
    if (accepted >= limit) break;
    const header = record?.header ?? record;
    if (header === null || typeof header !== "object") continue;
    const id = typeof header.id === "string" ? header.id : undefined;
    if (id === undefined || id.length === 0) continue;

    let cwd = liveLookup?.(header);
    if (typeof cwd !== "string" || cwd.length === 0) cwd = cachedLookup?.(header);
    if (typeof cwd !== "string" || cwd.length === 0) cwd = header.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) continue;

    cwds[id] = cwd;
    accepted += 1;
  }
  return cwds;
}
