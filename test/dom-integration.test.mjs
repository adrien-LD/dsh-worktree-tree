/**
 * jsdom DOM integration harness for the `dsh-worktree-tree` client half.
 *
 * The bundle is a plain browser script: it registers a factory through
 * `window.__ModuleLoader__`, then the Web client calls `exports.apply(ctx)`.
 * This harness builds the sidebar DOM shape the official workspace browser
 * renders (`div[role=tree]` > `div.groupSection` > project row + session rows +
 * overflow button), loads the real bundle in jsdom, drives it with fake
 * `workspaces` / `sessions` / `connection` services and asserts what a user
 * would see.
 *
 * jsdom is intentionally NOT a dependency of this plugin. Install it once in a
 * throwaway directory:
 *   mkdir -p /tmp/dsh-wt-dom && cd /tmp/dsh-wt-dom && npm init -y && npm i jsdom
 * Run:
 *   node --test test/dom-integration.test.mjs
 * Point the harness elsewhere with DSH_WT_JSDOM_DIR when /tmp is not usable.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const HEADER_ATTR = 'data-dswt-header'
const STYLE_ID = 'dsh-worktree-tree/style'
const COLLAPSED_KEY = 'dsh.worktree-tree.collapsed.v1'
const CHANNEL = '/dsh-worktree-tree'
const CHILDREN = Symbol('children')

/** Resolve jsdom from the throwaway harness directory (never a plugin dep). */
function loadJsdom() {
	const candidates = []
	if (typeof process.env.DSH_WT_JSDOM_DIR === 'string' && process.env.DSH_WT_JSDOM_DIR !== '') {
		candidates.push(process.env.DSH_WT_JSDOM_DIR)
	}
	candidates.push('/tmp/dsh-wt-dom')
	let failure
	for (const dir of candidates) {
		try {
			return { JSDOM: createRequire(`${dir}/package.json`)('jsdom').JSDOM }
		} catch (error) {
			failure = error
		}
	}
	return { JSDOM: undefined, failure }
}

const { JSDOM, failure } = loadJsdom()
const skip =
	JSDOM === undefined
		? `jsdom unavailable — install it in /tmp/dsh-wt-dom (${failure?.message ?? 'unknown error'})`
		: undefined
const options = skip === undefined ? {} : { skip }

/* -------------------------------------------------------------------------- *
 * Fixture: the DOM the official workspace browser renders.
 *
 * `groupSection` direct children in the real app, in render order:
 *   project row (`workspace:<workspaceId>`), optionally a `div[role=group]`
 *   holding nested workspace sections, session rows (`session:<id>`) and the
 *   overflow button (`overflow:<groupKey>`). Search mode renders a second
 *   `role=tree` that only ever holds result rows.
 * -------------------------------------------------------------------------- */

const WORKSPACES = [
	{ workspaceId: 'w1', path: '/repo', title: 'repo' },
	{ workspaceId: 'w2', path: '/other', title: 'other' }
]

const SESSIONS = {
	's-main': { id: 's-main', projectionValues: { workingDirectory: '/repo' } },
	's-wt': { id: 's-wt', projectionValues: { workingDirectory: '/repo/.agents/worktrees/wt-abc' } },
	's-feat': { id: 's-feat', projectionValues: { workingDirectory: '/repo/.agents/worktrees/feat/x' } },
	's-other': { id: 's-other', projectionValues: { workingDirectory: '/other' } },
	's-nested': { id: 's-nested', projectionValues: { workingDirectory: '/repo/nested' } },
	's-search': { id: 's-search', projectionValues: { workingDirectory: '/elsewhere' } }
}

const SIDEBAR_HTML = `
	<div class="Kjh-qa_list" role="tree" aria-label="sessions">
		<div class="Kjh-qa_groupSection" style="--dsh-workspace-indent: 0px">
			<div class="Kjh-qa_projectRow" data-row-key="workspace:w1" role="treeitem" aria-expanded="true">repo</div>
			<div role="group">
				<div class="Kjh-qa_groupSection" style="--dsh-workspace-indent: 12px">
					<div class="Kjh-qa_projectRow" data-row-key="workspace:w3" role="treeitem" aria-expanded="true">nested repo</div>
					<div class="Kjh-qa_sessionRow" data-row-key="session:s-nested" role="treeitem">nested session</div>
				</div>
			</div>
			<div class="Kjh-qa_sessionRow" data-row-key="session:s-main" role="treeitem" aria-selected="false">main session</div>
			<div class="Kjh-qa_sessionRow" data-row-key="session:s-wt" role="treeitem">wt session</div>
			<div class="Kjh-qa_sessionRow" data-row-key="session:s-feat" role="treeitem">feat session</div>
			<button class="Kjh-qa_sessionOverflowButton" type="button" data-row-key="overflow:w1">expand 3</button>
		</div>
		<div class="Kjh-qa_groupSection" style="--dsh-workspace-indent: 0px">
			<div class="Kjh-qa_projectRow" data-row-key="workspace:w2" role="treeitem" aria-expanded="true">other</div>
			<div class="Kjh-qa_sessionRow" data-row-key="session:s-other" role="treeitem">other session</div>
		</div>
	</div>
	<div class="Kjh-qa_searchTree" role="tree" aria-label="search results">
		<div class="Kjh-qa_searchRow" data-row-key="session:s-search" role="treeitem">search hit</div>
	</div>
`

/* -------------------------------------------------------------------------- *
 * Harness
 * -------------------------------------------------------------------------- */

/** One live client instance in one jsdom page with fake Cordis services. */
function createHarness(t, harnessOptions = {}) {
	assert.ok(JSDOM !== undefined, 'jsdom must be available')
	const dom = new JSDOM(
		`<!doctype html><html lang="${harnessOptions.documentLang ?? 'en'}"><head></head><body>${harnessOptions.html ?? SIDEBAR_HTML}</body></html>`,
		{ url: 'http://127.0.0.1:56332/', runScripts: 'dangerously', pretendToBeVisual: true }
	)
	const { window } = dom
	const { document } = window

	if (harnessOptions.language !== undefined) {
		Object.defineProperty(window.navigator, 'language', {
			configurable: true,
			get: () => harnessOptions.language
		})
	}

	let registration
	window.__ModuleLoader__ = {
		load(definition) {
			registration = definition
		}
	}
	window.eval(SOURCE)
	assert.ok(registration !== undefined, 'client bundle did not register through window.__ModuleLoader__.load')
	assert.equal(registration.id, 'dsh-worktree-tree')
	const exports = registration.factory()

	const workspaceItems = harnessOptions.workspaces ?? WORKSPACES
	const sessionsById = { ...(harnessOptions.sessions ?? SESSIONS) }
	const workspaceListeners = []
	const sessionListeners = []
	const rpcCalls = []
	// A rejecting transport models a Host without the RPC half: the client must
	// fall back to the `<workspace>/.agents/worktrees/<branch>` convention.
	const rpc =
		harnessOptions.rpc ?? (() => Promise.reject(new Error('connection unavailable in harness')))

	const services = {
		workspaces: {
			list: {
				getSnapshot: () => ({ items: workspaceItems }),
				subscribe: (listener) => {
					workspaceListeners.push(listener)
					return () => {}
				}
			}
		},
		sessions: {
			list: {
				getSnapshot: () => ({ byId: sessionsById, ids: Object.keys(sessionsById) }),
				subscribe: (listener) => {
					sessionListeners.push(listener)
					return () => {}
				}
			}
		},
		connection:
			harnessOptions.connection === 'absent'
				? undefined
				: {
						rpc: {
							call: (channel, endpoint, payload, signal) => {
								rpcCalls.push({ channel, endpoint, payload, signal })
								return Promise.resolve().then(() => rpc(channel, endpoint, payload, signal))
							}
						}
					}
	}

	let cleanup
	const ctx = {
		get(name) {
			return services[name]
		},
		effect(fn) {
			cleanup = fn()
			return () => {
				cleanup?.()
			}
		}
	}

	const harness = {
		dom,
		window,
		document,
		exports,
		ctx,
		rpcCalls,
		workspaceListeners,
		sessionListeners,
		apply() {
			exports.apply(ctx)
			return harness
		},
		addSession(id, cwd) {
			sessionsById[id] = { id, projectionValues: { workingDirectory: cwd } }
			return harness
		},
		emitSessionChange() {
			for (const listener of sessionListeners) listener()
			return harness
		},
		settle(ms = 300) {
			return new Promise((resolve) => setTimeout(resolve, ms))
		},
		dispose() {
			cleanup?.()
			cleanup = undefined
		}
	}

	t.after(() => {
		try {
			harness.dispose()
		} catch {
			// Some tests deliberately dispose twice.
		}
		try {
			window.close()
		} catch {
			// jsdom may already be closed.
		}
	})
	return harness
}

/* -------------------------------------------------------------------------- *
 * DOM helpers
 * -------------------------------------------------------------------------- */

const directChildren = (element) => Array.from(element.children)
const rowsOf = (section) => directChildren(section).filter((el) => el.hasAttribute('data-row-key'))
const headersOf = (section) => directChildren(section).filter((el) => el.hasAttribute(HEADER_ATTR))
const rowOf = (section, key) =>
	directChildren(section).find((el) => el.getAttribute('data-row-key') === key)
const headerOf = (section, key) =>
	directChildren(section).find((el) => el.getAttribute(HEADER_ATTR) === key)

const sectionOf = (document, workspaceId) => {
	const row = document.querySelector(`[data-row-key="workspace:${workspaceId}"]`)
	assert.ok(row !== null, `fixture is missing the workspace row for ${workspaceId}`)
	return row.parentElement
}

const orderOf = (element) => (element.style.order === '' ? 0 : Number(element.style.order))

const nativeKeys = (section) => rowsOf(section).map((el) => el.getAttribute('data-row-key'))

const elementKey = (element) => {
	const rowKey = element.getAttribute('data-row-key')
	if (rowKey !== null) return rowKey
	const headerKey = element.getAttribute(HEADER_ATTR)
	if (headerKey !== null) return `header:${headerKey}`
	return `group:${element.getAttribute('role') ?? element.tagName.toLowerCase()}`
}

/** Children in the order a user sees them: CSS `order`, then DOM order. */
const visualKeys = (section) =>
	directChildren(section)
		.map((element, index) => ({ key: elementKey(element), order: orderOf(element), index }))
		.sort((left, right) => left.order - right.order || left.index - right.index)
		.map((entry) => entry.key)

const labelOf = (header) => header.querySelector('.dswt-label')?.textContent
const branchOf = (header) => header.querySelector('.dswt-branch')
const countOf = (header) => header.querySelector('.dswt-count')?.textContent
const dotOf = (header) => header.querySelector('.dswt-dot')

/* -------------------------------------------------------------------------- *
 * Tests: module contract
 * -------------------------------------------------------------------------- */

test('bundle registers and exposes apply / inject / __test', options, async (t) => {
	const h = createHarness(t)
	assert.equal(typeof h.exports.apply, 'function')
	assert.deepEqual([...h.exports.inject], ['workspaces', 'sessions', 'connection'])
	for (const name of ['normalizePath', 'insidePath', 'basename', 'deriveLocation', 'hostLocation', 'sessionCwd', 'buildSectionPlan', 'mainLabel']) {
		assert.equal(typeof h.exports.__test[name], 'function', `missing __test.${name}`)
	}
})

test('apply is a no-op when the workspace/session stores are absent', options, async (t) => {
	const h = createHarness(t)
	h.exports.apply({ get: () => undefined, effect: () => assert.fail('effect must not run') })
	await h.settle(150)
	assert.equal(h.document.querySelector(`[${HEADER_ATTR}]`), null)
	assert.equal(h.document.getElementById(STYLE_ID), null)
	assert.equal(h.rpcCalls.length, 0)
})

/* -------------------------------------------------------------------------- *
 * Tests: fallback (no Host RPC) grouping
 * -------------------------------------------------------------------------- */

test('fallback groups sessions by the worktree path convention and orders them with CSS order', options, async (t) => {
	const h = createHarness(t)
	const w1 = sectionOf(h.document, 'w1')
	const w2 = sectionOf(h.document, 'w2')
	const searchTree = h.document.querySelector('.Kjh-qa_searchTree')
	const beforeW1 = nativeKeys(w1)
	const beforeW2 = nativeKeys(w2)
	const beforeSearch = nativeKeys(searchTree)

	h.apply()
	await h.settle()

	// Header per derived group: primary checkout + each `.agents/worktrees/<branch>`.
	assert.deepEqual(
		headersOf(w1).map((el) => el.getAttribute(HEADER_ATTR)),
		['main', 'pool:feat/x', 'pool:wt-abc']
	)
	assert.deepEqual(headersOf(w1).map(orderOf), [100, 200, 300])
	assert.deepEqual(headersOf(w2).map((el) => el.getAttribute(HEADER_ATTR)), ['main'])
	assert.deepEqual(headersOf(w2).map(orderOf), [100])

	// Project row always stays above its headers; overflow button stays last.
	assert.equal(orderOf(rowOf(w1, 'workspace:w1')), 0)
	assert.equal(orderOf(rowOf(w1, 'overflow:w1')), 1e6)
	assert.equal(orderOf(rowOf(w2, 'workspace:w2')), 0)

	// Sessions sit below their own worktree header, groups increase downward.
	assert.equal(orderOf(rowOf(w1, 'session:s-main')), 101)
	assert.equal(orderOf(rowOf(w1, 'session:s-feat')), 201)
	assert.equal(orderOf(rowOf(w1, 'session:s-wt')), 301)
	assert.equal(orderOf(rowOf(w2, 'session:s-other')), 101)

	// What the user actually sees, in visual order.
	assert.deepEqual(visualKeys(w1), [
		'workspace:w1',
		'group:group',
		'header:main',
		'session:s-main',
		'header:pool:feat/x',
		'session:s-feat',
		'header:pool:wt-abc',
		'session:s-wt',
		'overflow:w1'
	])

	// Native rows are never moved: same DOM children, same native order.
	assert.deepEqual(nativeKeys(w1), beforeW1)
	assert.deepEqual(nativeKeys(w2), beforeW2)
	assert.deepEqual(nativeKeys(searchTree), beforeSearch)

	// Search results (a `role=tree` without a workspace row) are never touched.
	assert.equal(headersOf(searchTree).length, 0)
	assert.deepEqual(nativeKeys(searchTree), beforeSearch)
	assert.equal(h.document.querySelectorAll(`.Kjh-qa_searchTree [${HEADER_ATTR}]`).length, 0)

	// The one non-row child of a group section is the nested-workspace wrapper.
	const nestedWrapper = directChildren(w1).find((el) => el.getAttribute('role') === 'group')
	assert.ok(nestedWrapper !== undefined)
	assert.equal(orderOf(nestedWrapper), 1)

	// The group section becomes a flex column so `order` applies to its rows.
	assert.ok(w1.classList.contains('dswt-flex'))
	assert.deepEqual(nativeKeys(searchTree), beforeSearch)
})

test('the injected style only carries scoped layout rules (no !important hijack of display)', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const style = h.document.getElementById(STYLE_ID)
	assert.ok(style !== null, 'style tag was not injected')
	const css = style.textContent
	assert.ok(css.includes('flex-direction: column'))
	assert.ok(css.includes(`[${HEADER_ATTR}]`))
	assert.equal(css.includes('!important'), false, 'CSS must not use !important: it would overwrite sibling plugin display rules')
})

test('headers carry no data-row-key, expose a button role and describe the group', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	const main = headerOf(w1, 'main')
	const feat = headerOf(w1, 'pool:feat/x')

	for (const header of [main, feat]) {
		assert.equal(header.hasAttribute('data-row-key'), false, 'headers must not look like animated rows')
		assert.equal(header.getAttribute('role'), 'button')
		assert.equal(header.getAttribute('tabindex'), '0')
		assert.equal(header.getAttribute('aria-expanded'), 'true')
		assert.equal(header.dataset.dswtCollapsed, 'false')
		assert.equal(header.querySelector('.dswt-chevron')?.textContent, '▾')
	}

	// Primary checkout: localized label, no branch chip, no dirty marker yet.
	assert.equal(labelOf(main), 'Main')
	assert.equal(countOf(main), '1')
	assert.equal(branchOf(main).hidden, true)
	assert.equal(dotOf(main).hidden, true)
	assert.equal(main.title, 'Main')

	// Derived pool group: the branch doubles as the label, so no chip either.
	assert.equal(labelOf(feat), 'feat/x')
	assert.equal(countOf(feat), '1')
	assert.equal(branchOf(feat).hidden, true)
})

test('zh locale renders the localized primary label', options, async (t) => {
	const h = createHarness(t, { language: 'zh-CN' })
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	assert.equal(labelOf(headerOf(w1, 'main')), '主分支')
})

/* -------------------------------------------------------------------------- *
 * Tests: collapse interaction
 * -------------------------------------------------------------------------- */

test('clicking a header collapses its sessions, persists to localStorage and restores them', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	const main = headerOf(w1, 'main')
	const mainRow = rowOf(w1, 'session:s-main')
	const otherRow = rowOf(w1, 'session:s-feat')

	main.click()
	await h.settle(250)

	assert.equal(mainRow.style.display, 'none')
	assert.equal(mainRow.dataset.dswtHidden, 'true')
	assert.equal(main.style.display, '')
	assert.equal(main.getAttribute('aria-expanded'), 'false')
	assert.equal(main.dataset.dswtCollapsed, 'true')
	// Only the collapsed group is hidden.
	assert.equal(otherRow.style.display, '')
	assert.deepEqual(JSON.parse(h.window.localStorage.getItem(COLLAPSED_KEY)), ['main'])

	main.click()
	await h.settle(250)

	assert.equal(mainRow.style.display, '')
	assert.equal('dswtHidden' in mainRow.dataset, false)
	assert.equal(main.getAttribute('aria-expanded'), 'true')
	assert.ok(mainRow.style.order !== '')
	assert.deepEqual(JSON.parse(h.window.localStorage.getItem(COLLAPSED_KEY)), [])
})

test('a collapsed group key is honoured after a fresh apply (state restored from localStorage)', options, async (t) => {
	const h = createHarness(t)
	h.window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['pool:wt-abc']))
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	assert.equal(rowOf(w1, 'session:s-wt').style.display, 'none')
	assert.equal(headerOf(w1, 'pool:wt-abc').dataset.dswtCollapsed, 'true')
	assert.equal(rowOf(w1, 'session:s-main').style.display, '')
})

/* -------------------------------------------------------------------------- *
 * Tests: DOM / store reactivity
 * -------------------------------------------------------------------------- */

test('a session row appended by React is picked up by the MutationObserver', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const w2 = sectionOf(h.document, 'w2')
	assert.equal(countOf(headerOf(w2, 'main')), '1')
	const callsBefore = h.rpcCalls.length

	// Simulate React appending a native row without touching the stores.
	h.addSession('s-extra', '/other')
	const extra = h.document.createElement('div')
	extra.className = 'Kjh-qa_sessionRow'
	extra.setAttribute('data-row-key', 'session:s-extra')
	extra.setAttribute('role', 'treeitem')
	w2.appendChild(extra)
	await h.settle()

	assert.equal(countOf(headerOf(w2, 'main')), '2')
	assert.equal(extra.style.order, '102')
	assert.equal(h.rpcCalls.length, callsBefore, 'an ordinary row change must not refetch the Host snapshot')
})

test('a session store change re-renders and drops a group that became empty', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	assert.equal(headersOf(w1).length, 3)

	// s-main moves out of the primary checkout: the `main` group loses its last row.
	h.addSession('s-main', '/repo/.agents/worktrees/wt-abc')
	h.emitSessionChange()
	await h.settle()

	assert.deepEqual(headersOf(w1).map((el) => el.getAttribute(HEADER_ATTR)), ['pool:feat/x', 'pool:wt-abc'])
	assert.equal(headerOf(w1, 'main'), undefined, 'the orphaned header must be removed')
	// s-main now shares the deepest worktree and keeps its native row order.
	assert.equal(orderOf(rowOf(w1, 'session:s-main')), 201)
	assert.equal(orderOf(rowOf(w1, 'session:s-wt')), 202)
	assert.equal(countOf(headerOf(w1, 'pool:wt-abc')), '2')
})

/* -------------------------------------------------------------------------- *
 * Tests: teardown
 * -------------------------------------------------------------------------- */

test('dispose removes every injected node, style and inline override', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	assert.equal(headersOf(w1).length, 3)

	h.dispose()
	await h.settle(150)

	assert.equal(h.document.querySelector(`[${HEADER_ATTR}]`), null)
	assert.equal(h.document.getElementById(STYLE_ID), null)
	assert.equal(w1.classList.contains('dswt-flex'), false)
	for (const row of rowsOf(w1)) {
		assert.equal(row.style.order, '')
		assert.equal(row.style.display, '')
		assert.equal('dswtHidden' in row.dataset, false)
	}
	assert.equal(w1.querySelector('[role="group"]').style.order, '')

	// The MutationObserver is disconnected: a later DOM change is not re-processed.
	const extra = h.document.createElement('div')
	extra.setAttribute('data-row-key', 'session:s-late')
	w1.appendChild(extra)
	await h.settle(250)
	assert.equal(h.document.querySelector(`[${HEADER_ATTR}]`), null)
})

/* -------------------------------------------------------------------------- *
 * Tests: Host RPC contract
 * -------------------------------------------------------------------------- */

const HOST_SNAPSHOT = {
	generatedAt: 1,
	workspaces: [
		{
			workspaceId: 'w1',
			path: '/repo',
			title: 'repo',
			repoRoot: '/repo',
			worktrees: [
				{
					path: '/repo',
					branch: 'master',
					head: '1111111111111111111111111111111111111111',
					main: true,
					bare: false,
					locked: null,
					prunable: false,
					dirty: true
				},
				{
					path: '/repo/.agents/worktrees/feat/x',
					branch: 'feat/x',
					head: '2222222222222222222222222222222222222222',
					main: false,
					bare: false,
					locked: null,
					prunable: false,
					dirty: false
				},
				{
					path: '/repo/.agents/worktrees/empty',
					branch: 'empty',
					head: '3333333333333333333333333333333333333333',
					main: false,
					bare: false,
					locked: null,
					prunable: false,
					dirty: null
				}
			]
		},
		{
			workspaceId: 'w2',
			path: '/other',
			title: 'other',
			repoRoot: '/other',
			worktrees: [
				{
					path: '/other',
					branch: 'main',
					head: '4444444444444444444444444444444444444444',
					main: true,
					bare: false,
					locked: null,
					prunable: false,
					dirty: false
				}
			]
		}
	]
}

test('rpc.call is addressed to the documented channel/endpoint payload', options, async (t) => {
	const h = createHarness(t, {
		rpc: () => Promise.resolve({ ok: true, value: HOST_SNAPSHOT })
	})
	h.apply()
	await h.settle()
	assert.equal(h.rpcCalls.length, 1, 'the Host snapshot request must be de-duplicated')
	assert.equal(h.rpcCalls[0].channel, CHANNEL)
	assert.equal(h.rpcCalls[0].endpoint, 'snapshot')
	// Spread to cross the jsdom realm boundary before the strict deep compare.
	assert.deepEqual({ ...h.rpcCalls[0].payload }, {})
})

/**
 * Regression guard for the client/host wire contract.
 *
 * `connection.rpc.call()` resolves to the generic Connection envelope
 * `{ ok: true, value }` (see @deepseek-ai/dsh-client-connection
 * `createWebConnectionRpc().call` → `return full.result`). The client half must
 * therefore read `result.value.workspaces`. Guarded here after the client was
 * fixed to unwrap the envelope; it fails again if a bare `{ workspaces }`
 * shape is expected.
 */
test('a Host snapshot delivered in the real { ok, value } RPC envelope is applied', options, async (t) => {
	const h = createHarness(t, {
		rpc: () => Promise.resolve({ ok: true, value: HOST_SNAPSHOT })
	})
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')

	// The empty worktree only exists in the Host inventory.
	assert.deepEqual(headersOf(w1).map((el) => el.getAttribute(HEADER_ATTR)), [
		'host:/repo',
		'host:/repo/.agents/worktrees/empty',
		'host:/repo/.agents/worktrees/feat/x',
		'pool:wt-abc'
	])
	assert.deepEqual(headersOf(w1).map(orderOf), [100, 200, 300, 400])

	const primary = headerOf(w1, 'host:/repo')
	assert.equal(labelOf(primary), 'Main')
	assert.equal(branchOf(primary).textContent, 'master')
	assert.equal(branchOf(primary).hidden, false)
	assert.equal(dotOf(primary).hidden, false)
	assert.equal(countOf(primary), '1', 'the stale inventory row must not fold into the primary checkout')

	const empty = headerOf(w1, 'host:/repo/.agents/worktrees/empty')
	assert.equal(countOf(empty), '0')

	const feat = headerOf(w1, 'host:/repo/.agents/worktrees/feat/x')
	assert.equal(countOf(feat), '1')
	assert.equal(branchOf(feat).textContent, '2222222')
})

test('the Host snapshot session cwd map outranks the stale client-side session cwd', options, async (t) => {
	// The client store still points s-wt at the primary checkout; the Host
	// session map (live projection) knows it moved into feat/x.
	const sessions = {
		...SESSIONS,
		's-wt': { id: 's-wt', projectionValues: { workingDirectory: '/repo' } }
	}
	const h = createHarness(t, {
		sessions,
		rpc: () =>
			Promise.resolve({
				ok: true,
				value: { ...HOST_SNAPSHOT, sessions: { 's-wt': '/repo/.agents/worktrees/feat/x' } }
			})
	})
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	const primary = headerOf(w1, 'host:/repo')
	const feat = headerOf(w1, 'host:/repo/.agents/worktrees/feat/x')
	assert.equal(countOf(primary), '1')
	assert.equal(countOf(feat), '2')
	// feat/x is the third host group; its sessions keep native DOM order.
	assert.equal(orderOf(rowOf(w1, 'session:s-wt')), 301)
	assert.equal(orderOf(rowOf(w1, 'session:s-feat')), 302)
})

/* -------------------------------------------------------------------------- *
 * Tests: sibling plugin interop (dsh-workspace-group-tabs)
 * -------------------------------------------------------------------------- */

test('an inline display:none from a sibling plugin is never overridden by the flex class', options, async (t) => {
	// dsh-workspace-group-tabs hides non-active workspace sections with
	// `section.style.display = 'none'`. Inline style outranks a class rule, so
	// the injected `.dswt-flex` must not resurrect a hidden section.
	const h = createHarness(t)
	const w1 = sectionOf(h.document, 'w1')
	w1.style.display = 'none'
	h.apply()
	await h.settle()

	assert.equal(w1.style.display, 'none', 'the plugin must not clear a sibling inline display')
	assert.equal(h.window.getComputedStyle(w1).display, 'none')
	assert.equal(headersOf(w1).length, 3, 'rows inside a hidden section are still prepared')

	// Restoring the section (tab switch) lets the injected flex layout apply.
	w1.style.display = ''
	assert.equal(h.window.getComputedStyle(w1).display, 'flex')
})

/* -------------------------------------------------------------------------- *
 * Tests: mode switches
 * -------------------------------------------------------------------------- */

test('switching to search mode and back (tree removed then re-added) re-injects cleanly', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const list = h.document.querySelector('div[role="tree"][aria-label="sessions"]')
	assert.ok(list !== null)
	assert.equal(h.document.querySelectorAll(`[${HEADER_ATTR}]`).length, 4)

	// Search mode replaces the whole tree: React unmounts the workspace list.
	list.remove()
	await h.settle(200)
	assert.equal(h.document.querySelectorAll(`[${HEADER_ATTR}]`).length, 0)
	// The shared stylesheet stays mounted while the tree is away.
	assert.ok(h.document.getElementById(STYLE_ID) !== null)

	// Back to workspace mode: a fresh tree mounts with the same native rows.
	h.document.body.appendChild(list)
	await h.settle()

	const w1 = sectionOf(h.document, 'w1')
	assert.equal(headersOf(w1).length, 3)
	assert.equal(labelOf(headerOf(w1, 'main')), 'Main')
	assert.equal(orderOf(rowOf(w1, 'session:s-main')), 101)
})

/* -------------------------------------------------------------------------- *
 * Tests: layout repair after React className rewrites (F3 regression)
 * -------------------------------------------------------------------------- */

test('a React className rewrite on the group section is repaired', options, async (t) => {
	const h = createHarness(t)
	h.apply()
	await h.settle()
	const w1 = sectionOf(h.document, 'w1')
	assert.ok(w1.classList.contains('dswt-flex'))

	// The official groupSection className is `clsx(groupSection, dragMarkers)`;
	// dragging a workspace over it makes React overwrite the whole class
	// attribute, dropping the injected class. The observer watches `class`
	// mutations and the `intact` guard includes the flex class now, so the next
	// render restores both the class and the CSS `order` assignment.
	w1.className = 'Kjh-qa_groupSection Kjh-qa_workspaceDropBefore'
	await h.settle(300)
	assert.ok(w1.classList.contains('dswt-flex'), 'the injected flex class must be restored after a className rewrite')

	// Grouping layout is still effective: header above its rows, orders intact.
	assert.deepEqual(headersOf(w1).map(orderOf), [100, 200, 300])
	assert.deepEqual(visualKeys(w1).slice(0, 3), ['workspace:w1', 'group:group', 'header:main'])
	assert.equal(orderOf(rowOf(w1, 'session:s-main')), 101)
})
