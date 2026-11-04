import assert from "node:assert/strict";
import { resolve as resolvePath } from "node:path";
import test from "node:test";
import { mergeSessionCwds, parseDirtyStatus, parseWorktreeList } from "../lib/parse.js";
import { CHANNEL, apply, inject, name } from "../lib/index.js";

// ---------------------------------------------------------------------------
// Fixtures: real `git worktree list --porcelain -z` spellings.
// ---------------------------------------------------------------------------

const SHA_MAIN = "1".repeat(40);
const SHA_FEAT = "2".repeat(40);
const SHA_LOCKED = "3".repeat(40);
const SHA_PRUNABLE = "4".repeat(40);

const MAIN_PATH = "/Users/example/src/my repo";
const FEAT_PATH = "/Users/example/worktrees/my repo/feat x";
const LOCKED_PATH = "/Users/example/worktrees/my repo/hotfix";
const PRUNABLE_PATH = "/Users/example/worktrees/my repo/gone";

const RECORD_MAIN = [`worktree ${MAIN_PATH}`, `HEAD ${SHA_MAIN}`, "branch refs/heads/main"];
const RECORD_FEAT = [`worktree ${FEAT_PATH}`, `HEAD ${SHA_FEAT}`, "branch refs/heads/feat/x"];
const RECORD_LOCKED = [
  `worktree ${LOCKED_PATH}`,
  `HEAD ${SHA_LOCKED}`,
  "branch refs/heads/hotfix/y",
  "locked locked by agent",
];
const RECORD_PRUNABLE = [`worktree ${PRUNABLE_PATH}`, `HEAD ${SHA_PRUNABLE}`, "detached", "prunable"];

/** Layout A: every field line NUL-terminated, an extra NUL for the record separator. */
function porcelainZ(records) {
  return records.map((lines) => lines.map((line) => `${line}\0`).join("") + "\0").join("");
}

/** Layout B: NUL after each field line, but no blank record separator between records. */
function porcelainLinesNul(records) {
  return records.flat().map((line) => `${line}\0`).join("");
}

/** Layout C: one record per NUL, fields separated by newlines. */
function porcelainRecordNul(records) {
  return records.map((lines) => `${lines.join("\n")}\0`).join("");
}

// ---------------------------------------------------------------------------
// parse.js: worktree list
// ---------------------------------------------------------------------------

test("parseWorktreeList parses the double-NUL porcelain layout", () => {
  const parsed = parseWorktreeList(porcelainZ([RECORD_MAIN, RECORD_FEAT, RECORD_LOCKED, RECORD_PRUNABLE]), {
    repoRoot: MAIN_PATH,
  });

  assert.equal(parsed.repoRoot, MAIN_PATH);
  assert.equal(parsed.worktrees.length, 4);

  const [main, feat, locked, prunable] = parsed.worktrees;
  assert.deepEqual(main, {
    path: MAIN_PATH,
    branch: "main",
    head: SHA_MAIN,
    main: true,
    bare: false,
    locked: null,
    prunable: false,
  });
  assert.deepEqual(feat, {
    path: FEAT_PATH,
    branch: "feat/x",
    head: SHA_FEAT,
    main: false,
    bare: false,
    locked: null,
    prunable: false,
  });
  assert.equal(locked.locked, "locked by agent");
  assert.equal(locked.branch, "hotfix/y");
  assert.equal(locked.main, false);
  assert.equal(prunable.branch, null, "detached HEAD has no branch");
  assert.equal(prunable.head, SHA_PRUNABLE);
  assert.equal(prunable.prunable, true);
  assert.equal(prunable.main, false);
});

test("parseWorktreeList accepts single-NUL field termination without blank separators", () => {
  const parsed = parseWorktreeList(porcelainLinesNul([RECORD_MAIN, RECORD_FEAT]));
  assert.equal(parsed.worktrees.length, 2);
  assert.deepEqual(parsed.worktrees.map((worktree) => worktree.path), [MAIN_PATH, FEAT_PATH]);
  assert.deepEqual(parsed.worktrees.map((worktree) => worktree.main), [true, false]);
});

test("parseWorktreeList accepts record-per-NUL with newline-separated fields", () => {
  const parsed = parseWorktreeList(porcelainRecordNul([RECORD_MAIN, RECORD_FEAT]));
  assert.equal(parsed.worktrees.length, 2);
  assert.equal(parsed.worktrees[1].branch, "feat/x");
  assert.equal(parsed.worktrees[1].head, SHA_FEAT);
});

test("parseWorktreeList returns no worktrees for an empty listing", () => {
  for (const input of ["", "\0", "\0\0", Buffer.alloc(0)]) {
    const parsed = parseWorktreeList(input);
    assert.deepEqual(parsed.worktrees, []);
    assert.equal("repoRoot" in parsed, false);
  }
});

test("parseWorktreeList handles a single worktree and bare repositories", () => {
  const single = parseWorktreeList(porcelainZ([[`worktree ${MAIN_PATH}`, `HEAD ${SHA_MAIN}`, "branch refs/heads/main"]]));
  assert.equal(single.worktrees.length, 1);
  assert.equal(single.worktrees[0].main, true);

  const bare = parseWorktreeList(porcelainZ([["worktree /srv/bare.git", `HEAD ${SHA_MAIN}`, "bare"]]));
  assert.equal(bare.worktrees.length, 1);
  assert.equal(bare.worktrees[0].bare, true);
  assert.equal(bare.worktrees[0].branch, null);
  assert.equal(bare.worktrees[0].main, true);
});

test("parseWorktreeList keeps locked/prunable reasons and bare flags", () => {
  const parsed = parseWorktreeList(
    porcelainZ([
      ["worktree /repo", `HEAD ${SHA_MAIN}`, "branch refs/heads/main", "locked"],
      ["worktree /repo/pruned", `HEAD ${SHA_FEAT}`, "detached", "prunable worktree directory is missing"],
    ]),
  );
  assert.equal(parsed.worktrees[0].locked, "locked");
  assert.equal(parsed.worktrees[1].prunable, true);
  assert.equal(parsed.worktrees[1].branch, null);
});

test("parseWorktreeList marks the repoRoot worktree as main instead of the first record", () => {
  const parsed = parseWorktreeList(porcelainRecordNul([RECORD_MAIN, RECORD_FEAT]), {
    repoRoot: `${FEAT_PATH}/`,
  });
  assert.deepEqual(parsed.worktrees.map((worktree) => worktree.main), [false, true]);
});

test("parseWorktreeList falls back to the first record when no path matches repoRoot", () => {
  const parsed = parseWorktreeList(porcelainRecordNul([RECORD_MAIN, RECORD_FEAT]), {
    repoRoot: "/elsewhere",
  });
  assert.deepEqual(parsed.worktrees.map((worktree) => worktree.main), [true, false]);
});

test("parseWorktreeList accepts Buffer input and preserves a path containing newlines", () => {
  const input = Buffer.from(`worktree /repo/pa\nth\0HEAD ${SHA_MAIN}\0branch refs/heads/main\0\0`, "utf8");
  const parsed = parseWorktreeList(input);
  assert.equal(parsed.worktrees.length, 1);
  assert.equal(parsed.worktrees[0].path, "/repo/pa\nth");
});

test("parseWorktreeList tolerates CRLF field termination", () => {
  const input = Buffer.from(`worktree /repo\r\nHEAD ${SHA_MAIN}\r\nbranch refs/heads/main\r\n\0`, "utf8");
  const parsed = parseWorktreeList(input);
  assert.equal(parsed.worktrees.length, 1);
  assert.equal(parsed.worktrees[0].path, "/repo");
  assert.equal(parsed.worktrees[0].branch, "main");
});

// ---------------------------------------------------------------------------
// parse.js: session cwd merge (contract v2)
// ---------------------------------------------------------------------------

test("mergeSessionCwds prefers live, then cache, then the initial header cwd", () => {
  const records = [
    { header: { id: "live", cwd: "/initial/live" } },
    { header: { id: "cached", cwd: "/initial/cached" } },
    { header: { id: "cold", cwd: "/initial/cold" } },
    { header: { id: "empty-cache", cwd: "/initial/empty" } },
  ];
  const liveById = { live: { id: "live" } };
  const merged = mergeSessionCwds(
    records,
    (header) => (liveById[header.id] === undefined ? undefined : "/live/live"),
    (header) =>
      header.id === "cached"
        ? "/cached/cached"
        : header.id === "empty-cache"
          ? undefined
          : undefined,
  );

  assert.deepEqual(merged, {
    live: "/live/live",
    cached: "/cached/cached",
    cold: "/initial/cold",
    "empty-cache": "/initial/empty",
  });
});

test("mergeSessionCwds skips empty ids and non-string cwds, accepts bare headers and caps entries", () => {
  const records = [
    { header: { id: "", cwd: "/empty-id" } },
    { header: { id: "no-cwd" } },
    { header: { id: "null-cwd", cwd: null } },
    { id: "bare-header", cwd: "/bare" },
    null,
    "not-a-record",
    { header: { id: "kept", cwd: "/kept" } },
  ];
  const merged = mergeSessionCwds(records, () => undefined, () => undefined);
  assert.deepEqual(merged, { "bare-header": "/bare", kept: "/kept" });

  const many = Array.from({ length: 8 }, (_, index) => ({ header: { id: `s${index}`, cwd: `/cwd/${index}` } }));
  assert.equal(Object.keys(mergeSessionCwds(many, () => undefined, () => undefined, 3)).length, 3);
  assert.deepEqual(mergeSessionCwds(many, () => undefined, () => undefined, 0), {});
});

// ---------------------------------------------------------------------------
// parse.js: dirty status
// ---------------------------------------------------------------------------

test("parseDirtyStatus treats empty output as clean", () => {
  for (const input of ["", "\n", "   \n", "\0", Buffer.alloc(0)]) {
    assert.equal(parseDirtyStatus(input), false);
  }
});

test("parseDirtyStatus treats any record as dirty", () => {
  assert.equal(parseDirtyStatus(" M README.md\n"), true);
  assert.equal(parseDirtyStatus("?? new-file.txt\n"), true);
  assert.equal(parseDirtyStatus(Buffer.from(" M a\n D b\n", "utf8")), true);
});

// ---------------------------------------------------------------------------
// Host plugin: fake Cordis context + fake subprocess provider.
// ---------------------------------------------------------------------------

function defaultGit(responses = {}) {
  const toplevels = responses.toplevels ?? {};
  const listings = responses.listings ?? {};
  const statuses = responses.statuses ?? {};
  return (args) => {
    const cIndex = args.indexOf("-C");
    const directory = cIndex >= 0 ? args[cIndex + 1] : undefined;
    const command = cIndex >= 0 ? args.slice(cIndex + 2) : args;
    if (command[0] === "rev-parse") {
      const stdout = toplevels[directory];
      return stdout === undefined
        ? { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }
        : { exitCode: 0, stdout, stderr: "" };
    }
    if (command[0] === "worktree") {
      const stdout = listings[directory];
      return stdout === undefined
        ? { exitCode: 128, stdout: "", stderr: "fatal: unable to read worktrees" }
        : { exitCode: 0, stdout, stderr: "" };
    }
    if (command[0] === "status") {
      const entry = statuses[directory];
      if (entry === undefined) return { exitCode: 128, stdout: "", stderr: "fatal: status failed" };
      if (typeof entry === "object" && entry !== null && typeof entry.exitCode === "number") {
        return { stdout: "", stderr: "", ...entry };
      }
      return { exitCode: 0, stdout: entry, stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected git subcommand ${command[0]}` };
  };
}

function createHarness({ workspaces, git, policy, confine, services } = {}) {
  const calls = [];
  const resolveCalls = [];
  const confineCalls = [];
  let handler = null;
  let channel = null;
  let active = 0;
  let maxActive = 0;
  const disposers = [];
  const run = git ?? defaultGit({});

  const spawn = (spec) => {
    calls.push(spec.argv);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const outcome = run(spec.argv.slice(1)) ?? { exitCode: 0, stdout: "", stderr: "" };
    const stdout = outcome.stdout ?? "";
    const stderr = outcome.stderr ?? "";
    const done = Promise.resolve(outcome).then((result) => {
      active -= 1;
      return { exitCode: result.exitCode ?? 0, signal: null };
    });
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
      },
      terminate() {},
      waitForExit: async () => {},
    };
  };

  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
      return () => {};
    },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ["connection"]);
      callback({
        effect: (fn) => ctx.effect(fn),
        connection: {
          rpc: {
            handle(registeredChannel, registeredHandler) {
              channel = registeredChannel;
              handler = registeredHandler;
              return () => {};
            },
          },
        },
      });
    },
    workspaceRegistry: { list: () => workspaces },
    get: (serviceName) => (services === undefined ? undefined : services[serviceName]),
    sandboxPolicy: {
      resolve: () => ({ ...(policy ?? { mode: "danger-full-access", workspaceRoot: "/tmp" }) }),
    },
    sandbox: {
      confine: async (argv, resolvedPolicy, signal) => {
        confineCalls.push({ argv, policy: resolvedPolicy, signal });
        if (confine) return confine(argv, resolvedPolicy, signal);
        return { argv };
      },
    },
    subprocess: {
      async resolveExecutable(command) {
        resolveCalls.push(command);
        return command;
      },
      spawn,
    },
  };

  apply(ctx);
  assert.equal(typeof handler, "function", "apply must register a snapshot handler");
  return {
    get channel() {
      return channel;
    },
    get handler() {
      return handler;
    },
    calls,
    resolveCalls,
    confineCalls,
    disposers,
    get maxActive() {
      return maxActive;
    },
  };
}

/** The multi-worktree repository used by the Host tests. */
function repoHarness(options = {}) {
  const listing = porcelainZ([RECORD_MAIN, RECORD_FEAT, RECORD_LOCKED, RECORD_PRUNABLE]);
  const git = defaultGit({
    toplevels: { [MAIN_PATH]: `${MAIN_PATH}\n` },
    listings: { [MAIN_PATH]: listing },
    statuses: {
      [MAIN_PATH]: " M README.md\n",
      [FEAT_PATH]: "",
      [LOCKED_PATH]: "?? scratch.txt\n",
      [PRUNABLE_PATH]: { exitCode: 128 },
    },
  });
  return createHarness({
    workspaces: [
      { id: "w1", path: MAIN_PATH, title: "My Repo" },
      { id: "w2", path: "/Users/example/notes", title: "Notes" },
    ],
    git,
    ...options,
  });
}

test("plugin metadata and channel match the Connection contract", () => {
  assert.equal(name, "worktree-tree");
  assert.deepEqual(inject, ["workspaceRegistry", "subprocess", "sandbox", "sandboxPolicy"]);
  assert.equal(CHANNEL, "/dsh-worktree-tree");
  assert.match(CHANNEL, /^\/[A-Za-z0-9._~-]+$/);
  assert.notEqual(CHANNEL, "/api");
});

test("snapshot reports worktrees, dirty state and per-workspace errors", async () => {
  const harness = repoHarness();
  assert.equal(harness.channel, CHANNEL);

  const result = await harness.handler("snapshot", {}, new AbortController().signal, {});
  assert.equal(result.ok, true);
  assert.equal(typeof result.value.generatedAt, "number");
  assert.ok(Math.abs(Date.now() - result.value.generatedAt) < 10_000);

  const [repo, notes] = result.value.workspaces;
  assert.deepEqual(
    { workspaceId: repo.workspaceId, path: repo.path, title: repo.title, repoRoot: repo.repoRoot },
    {
      workspaceId: "w1",
      path: resolvePath(MAIN_PATH),
      title: "My Repo",
      repoRoot: resolvePath(MAIN_PATH),
    },
  );
  assert.equal(repo.error, undefined);
  assert.equal(notes.workspaceId, "w2");
  assert.equal(notes.repoRoot, null);
  assert.deepEqual(notes.worktrees, []);
  assert.equal(notes.error, "not-a-git-repo");

  assert.equal(repo.worktrees.length, 4);
  assert.deepEqual(result.value.sessions, {}, "no session services degrade to an empty map");
  assert.deepEqual(repo.worktrees[0], {
    path: resolvePath(MAIN_PATH),
    branch: "main",
    head: SHA_MAIN,
    main: true,
    bare: false,
    locked: null,
    prunable: false,
    dirty: true,
  });
  assert.equal(repo.worktrees[1].branch, "feat/x");
  assert.equal(repo.worktrees[1].main, false);
  assert.equal(repo.worktrees[1].dirty, false);
  assert.equal(repo.worktrees[2].locked, "locked by agent");
  assert.equal(repo.worktrees[2].dirty, true);
  assert.equal(repo.worktrees[3].branch, null);
  assert.equal(repo.worktrees[3].prunable, true);
  assert.equal(repo.worktrees[3].dirty, null, "status failure becomes null");

  // 2 workspaces: rev-parse(w1), worktree list, 4 x status, rev-parse(w2).
  assert.equal(harness.calls.length, 7);
  assert.ok(harness.maxActive <= 4, `expected <= 4 concurrent git commands, saw ${harness.maxActive}`);
});

test("snapshot shares one cached result within the TTL", async () => {
  const harness = repoHarness();
  const first = await harness.handler("snapshot", {});
  const callsAfterFirst = harness.calls.length;
  const second = await harness.handler("snapshot", {});
  const third = await harness.handler("snapshot", {});

  assert.equal(harness.calls.length, callsAfterFirst, "cached snapshot must not spawn git again");
  assert.equal(first.ok && second.ok && third.ok, true);
  assert.equal(second.value.generatedAt, first.value.generatedAt);
  assert.equal(third.value.generatedAt, first.value.generatedAt);
});

test("snapshot merges live, cached and initial session working directories", async () => {
  const records = [
    { header: { id: "s-live", cwd: "/initial/live" } },
    { header: { id: "s-cached", cwd: "/initial/cached" } },
    { header: { id: "s-initial", cwd: "/initial/only" } },
    { header: { id: "s-dropped", cwd: "" } },
  ];
  const liveSessions = { "s-live": { id: "s-live" } };
  const cachedRecords = {
    "s-live": { asOfSeq: 4, values: { workingDirectory: "/cached/ignored" } },
    "s-cached": { asOfSeq: 3, values: { workingDirectory: "/cached/now" } },
  };
  const harness = createHarness({
    workspaces: [{ id: "w1", path: MAIN_PATH, title: "My Repo" }],
    git: defaultGit({
      toplevels: { [MAIN_PATH]: `${MAIN_PATH}\n` },
      listings: { [MAIN_PATH]: porcelainZ([RECORD_MAIN]) },
      statuses: { [MAIN_PATH]: "" },
    }),
    services: {
      sessionQuery: { listSessions: async () => records },
      sessions: { get: (id) => liveSessions[id] },
      workingDirectory: { get: (session) => (session.id === "s-live" ? "/live/now" : undefined) },
      sessionProjectionCache: {
        cachedSnapshot: (header, keys) => {
          assert.deepEqual(keys, ["workingDirectory"]);
          return cachedRecords[header.id];
        },
      },
    },
  });

  const result = await harness.handler("snapshot", {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.sessions, {
    "s-live": "/live/now",
    "s-cached": "/cached/now",
    "s-initial": "/initial/only",
  });
  assert.equal(result.value.workspaces[0].worktrees.length, 1);
});

test("session cwd failures degrade to an empty map and never break workspaces", async () => {
  const harness = repoHarness({
    services: {
      sessionQuery: {
        listSessions: async () => {
          throw new Error("persistence unavailable");
        },
      },
    },
  });
  const result = await harness.handler("snapshot", {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.sessions, {});
  assert.equal(result.value.workspaces.length, 2);
  assert.equal(result.value.workspaces[0].worktrees.length, 4);
});

test("snapshot runs every command through the sandbox when policy allows", async () => {
  const harness = repoHarness({
    policy: { mode: "workspace-write", workspaceRoot: MAIN_PATH },
    confine: (argv) => ({ argv: ["/fake/sandbox", ...argv] }),
  });
  const result = await harness.handler("snapshot", {});
  assert.equal(result.ok, true);
  assert.equal(harness.confineCalls.length, harness.calls.length, "every spawned command is confined");
  for (const argv of harness.calls) assert.equal(argv[0], "/fake/sandbox");
  assert.deepEqual(harness.confineCalls[0].policy.mode, "workspace-write");
});

test("snapshot falls back to plain git when the sandbox cannot wrap commands", async () => {
  const harness = repoHarness({
    policy: { mode: "workspace-write", workspaceRoot: MAIN_PATH },
    confine: () => {
      throw new Error("sandbox: no usable runner");
    },
  });
  const result = await harness.handler("snapshot", {});
  assert.equal(result.ok, true);
  assert.equal(result.value.workspaces[0].worktrees.length, 4);
  for (const argv of harness.calls) assert.equal(argv[0], "git");
});

test("snapshot honours the DSH_WORKTREE_TREE_GIT executable override", async () => {
  const previous = process.env.DSH_WORKTREE_TREE_GIT;
  process.env.DSH_WORKTREE_TREE_GIT = "/opt/custom-git";
  try {
    const harness = repoHarness();
    const result = await harness.handler("snapshot", {});
    assert.equal(result.ok, true);
    assert.ok(harness.resolveCalls.length > 0);
    for (const command of harness.resolveCalls) assert.equal(command, "/opt/custom-git");
    assert.equal(harness.calls[0][0], "/opt/custom-git");
  } finally {
    if (previous === undefined) delete process.env.DSH_WORKTREE_TREE_GIT;
    else process.env.DSH_WORKTREE_TREE_GIT = previous;
  }
});

test("snapshot caps one workspace at 40 worktrees", async () => {
  const records = [RECORD_MAIN];
  const statuses = { [MAIN_PATH]: "" };
  for (let index = 0; index < 44; index += 1) {
    const path = `/Users/example/worktrees/my repo/wt-${index}`;
    records.push([`worktree ${path}`, `HEAD ${String(index % 10).repeat(40)}`, `branch refs/heads/wt-${index}`]);
    statuses[path] = "";
  }
  const harness = createHarness({
    workspaces: [{ id: "w1", path: MAIN_PATH, title: "My Repo" }],
    git: defaultGit({ toplevels: { [MAIN_PATH]: `${MAIN_PATH}\n` }, listings: { [MAIN_PATH]: porcelainZ(records) }, statuses }),
  });
  const result = await harness.handler("snapshot", {});
  assert.equal(result.ok, true);
  assert.equal(result.value.workspaces[0].worktrees.length, 40);
  // rev-parse + worktree list + 40 status commands.
  assert.equal(harness.calls.length, 42);
});

test("snapshot reports an empty worktree list for a repository without worktrees", async () => {
  const harness = createHarness({
    workspaces: [{ id: "w1", path: MAIN_PATH, title: "My Repo" }],
    git: defaultGit({ toplevels: { [MAIN_PATH]: `${MAIN_PATH}\n` }, listings: { [MAIN_PATH]: "" } }),
  });
  const result = await harness.handler("snapshot", {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.workspaces[0].worktrees, []);
  assert.equal(result.value.workspaces[0].error, undefined);
});

test("unknown endpoints return a typed failure envelope", async () => {
  const harness = repoHarness();
  const result = await harness.handler("prune", {});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "worktree-tree/unknown-endpoint");
  assert.equal(typeof result.error.message, "string");
  assert.deepEqual(result.error.details, {});
});
