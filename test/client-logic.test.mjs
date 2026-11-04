/**
 * Pure-logic tests for the dsh-worktree-tree client half.
 *
 * The browser bundle is a plain script that registers a factory through
 * `window.__ModuleLoader__`; this harness evaluates it in a VM, captures the
 * factory and exercises the exported `__test` helpers without a DOM.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadClientModule() {
	let captured
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(definition) {
					captured = definition
				}
			}
		},
		navigator: { language: 'zh-CN' },
		document: { documentElement: { getAttribute: () => 'zh-CN' } }
	}
	vm.createContext(sandbox)
	vm.runInContext(source, sandbox)
	assert.ok(captured !== undefined, 'client bundle did not register a module')
	const moduleExports = captured.factory()
	assert.equal(captured.id, 'dsh-worktree-tree')
	return moduleExports
}

const client = loadClientModule()
const t = client.__test

/** Cross-realm values (vm) are converted to plain JSON for deep equality. */
const plain = (value) => JSON.parse(JSON.stringify(value))

test('normalizePath strips trailing slashes and separators', () => {
	assert.equal(t.normalizePath('/a/repo/'), '/a/repo')
	assert.equal(t.normalizePath('C:\\work\\repo\\'), 'C:/work/repo')
	assert.equal(t.normalizePath('/'), '/')
	assert.equal(t.normalizePath(''), '')
	assert.equal(t.normalizePath(undefined), '')
})

test('insidePath respects segment boundaries', () => {
	assert.equal(t.insidePath('/a/repo', '/a/repo'), true)
	assert.equal(t.insidePath('/a/repo/src', '/a/repo'), true)
	assert.equal(t.insidePath('/a/repo2', '/a/repo'), false)
	assert.equal(t.insidePath('/a/repo-suffix', '/a/repo'), false)
	assert.equal(t.insidePath('/a', '/'), true)
	assert.equal(t.insidePath('/a/repo', '/'), true)
})

test('deriveLocation recognises the DSH worktree path convention', () => {
	assert.deepEqual(plain(t.deriveLocation('/repo', '/repo')), { kind: 'main' })
	assert.deepEqual(plain(t.deriveLocation('/repo/src', '/repo')), { kind: 'main' })
	assert.deepEqual(plain(t.deriveLocation('/repo/.agents/worktrees/wt-1', '/repo')), { kind: 'pool', branch: 'wt-1' })
	assert.deepEqual(plain(t.deriveLocation('/repo/.agents/worktrees/feat/x', '/repo')), { kind: 'pool', branch: 'feat/x' })
	assert.deepEqual(plain(t.deriveLocation('/elsewhere', '/repo')), { kind: 'other' })
	assert.deepEqual(plain(t.deriveLocation('', '/repo')), { kind: 'other' })
})

test('hostLocation picks the deepest containing worktree', () => {
	const worktrees = [
		{ path: '/repo', main: true },
		{ path: '/repo/.agents/worktrees/feat/x', main: false },
		{ path: '/repo/.agents/worktrees/feat', main: false }
	]
	const location = t.hostLocation('/repo/.agents/worktrees/feat/x/src', worktrees, '/repo')
	assert.equal(location.kind, 'worktree')
	assert.equal(location.worktree.path, '/repo/.agents/worktrees/feat/x')
	assert.equal(t.hostLocation('/repo/src', worktrees, '/repo').kind, 'worktree')
	assert.equal(t.hostLocation('/elsewhere', worktrees, '/repo'), undefined)
})

test('sessionCwd prefers the live workingDirectory projection', () => {
	assert.equal(t.sessionCwd({ cwd: '/initial', projectionValues: { workingDirectory: '/current' } }), '/current')
	assert.equal(t.sessionCwd({ cwd: '/initial' }), '/initial')
	assert.equal(t.sessionCwd({ projectionValues: { workingDirectory: null } , cwd: '/initial' }), '/initial')
	assert.equal(t.sessionCwd(undefined), '')
})

test('plan without host data groups by the path convention', () => {
	const workspace = { workspaceId: 'w1', path: '/repo', title: 'repo' }
	const rows = [
		{ id: 's-main', cwd: '/repo' },
		{ id: 's-wt', cwd: '/repo/.agents/worktrees/wt-abc' },
		{ id: 's-feat', cwd: '/repo/.agents/worktrees/feat/x' },
		{ id: 's-unknown', cwd: '' }
	]
	const plan = t.buildSectionPlan({ workspace, sessionRows: rows, hostWorktrees: null, collapsed: new Set(), isZh: true })
	const keys = plan.groups.map((group) => group.key)
	assert.deepEqual(plain(keys), ['main', 'pool:feat/x', 'pool:wt-abc', 'unknown'])
	assert.deepEqual(plain(plan.groups.map((group) => group.title)), ['主分支', 'feat/x', 'wt-abc', '未知位置'])
	assert.deepEqual(plain(plan.groups.map((group) => group.count)), [1, 1, 1, 1])
	assert.deepEqual(plain(plan.groups.map((group) => group.main)), [true, false, false, false])
	assert.deepEqual(plain(plan.groups.map((group) => group.branch)), ['', 'feat/x', 'wt-abc', ''])
})

test('plan without host data keeps primary checkout first and drops empty groups', () => {
	const workspace = { workspaceId: 'w1', path: '/repo', title: 'repo' }
	const plan = t.buildSectionPlan({
		workspace,
		sessionRows: [{ id: 'a', cwd: '/repo/.agents/worktrees/zeta' }, { id: 'b', cwd: '/repo' }],
		hostWorktrees: null,
		collapsed: new Set(),
		isZh: false
	})
	assert.deepEqual(plain(plan.groups.map((group) => group.key)), ['main', 'pool:zeta'])
	assert.equal(plan.groups[0].title, 'Main')
})

test('plan with host data exposes branch, head, dirty and empty worktrees', () => {
	const workspace = { workspaceId: 'w1', path: '/repo', title: 'repo' }
	const hostWorktrees = [
		{ path: '/repo', branch: 'master', head: '1111111111111111111111111111111111111111', main: true, dirty: true },
		{ path: '/repo/.agents/worktrees/feat/x', branch: 'feat/x', head: '2222222222222222222222222222222222222222', main: false, dirty: false },
		{ path: '/repo/.agents/worktrees/empty', branch: 'empty', head: '3333333333333333333333333333333333333333', main: false, dirty: null }
	]
	const rows = [
		{ id: 's-main', cwd: '/repo' },
		{ id: 's-feat', cwd: '/repo/.agents/worktrees/feat/x' }
	]
	const plan = t.buildSectionPlan({ workspace, sessionRows: rows, hostWorktrees, collapsed: new Set(), isZh: true })
	assert.deepEqual(plain(plan.groups.map((group) => group.key)), [
		'host:/repo',
		'host:/repo/.agents/worktrees/empty',
		'host:/repo/.agents/worktrees/feat/x'
	])
	const [primary, empty, feat] = plan.groups
	assert.deepEqual(plain(primary.sessionIds), ['s-main'])
	assert.equal(primary.title, '主分支')
	assert.equal(primary.branch, 'master')
	assert.equal(primary.main, true)
	assert.equal(primary.dirty, true)
	assert.equal(empty.count, 0)
	assert.equal(feat.sessionIds.length, 1)
	assert.equal(feat.head, '2222222222222222222222222222222222222222')
	assert.equal(feat.collapsed, false)
})

test('plan honours collapsed keys and session directory subpaths with host data', () => {
	const workspace = { workspaceId: 'w1', path: '/repo', title: 'repo' }
	const hostWorktrees = [
		{ path: '/repo', branch: 'main', main: true },
		{ path: '/repo/.agents/worktrees/feat/x', branch: 'feat/x', main: false }
	]
	const plan = t.buildSectionPlan({
		workspace,
		sessionRows: [
			{ id: 's1', cwd: '/repo' },
			{ id: 's2', cwd: '/repo/.agents/worktrees/feat/x/src/deep' }
		],
		hostWorktrees,
		collapsed: new Set(['host:/repo/.agents/worktrees/feat/x']),
		isZh: false
	})
	assert.equal(plan.groups.length, 2)
	assert.equal(plan.groups[1].collapsed, true)
	assert.deepEqual(plain(plan.groups[1].sessionIds), ['s2'])
})

test('plan keeps sessions whose cwd is unknown inside the primary checkout', () => {
	const workspace = { workspaceId: 'w1', path: '/repo', title: 'repo' }
	const hostWorktrees = [{ path: '/repo', branch: 'main', main: true }]
	const plan = t.buildSectionPlan({
		workspace,
		sessionRows: [{ id: 's1', cwd: '' }],
		hostWorktrees,
		collapsed: new Set(),
		isZh: false
	})
	assert.deepEqual(plain(plan.groups.map((group) => group.key)), ['host:/repo'])
	assert.deepEqual(plain(plan.groups[0].sessionIds), ['s1'])
})

test('plan derives slashed branch names from nested session directories', () => {
	// Without host data the deepest directory is not knowable; the convention
	// treats the whole remainder as the branch, which is exact for Sessions
	// started at the worktree root (the normal DSH flow).
	const workspace = { workspaceId: 'w1', path: '/repo', title: 'repo' }
	const plan = t.buildSectionPlan({
		workspace,
		sessionRows: [{ id: 's1', cwd: '/repo/.agents/worktrees/feat/x' }],
		hostWorktrees: null,
		collapsed: new Set(),
		isZh: false
	})
	assert.deepEqual(plain(plan.groups.map((group) => group.key)), ['pool:feat/x'])
})
