/**
 * dsh-worktree-tree — client half.
 *
 * Groups the Sessions of every Workspace by Git worktree in the Web sidebar.
 * It keeps the official workspace browser: native Session rows, hover cards,
 * context menus, drag & drop, archive, rename and search all stay native. The
 * plugin only adds one non-React header per worktree and reorders the native
 * rows with CSS `order` inside their existing `groupSection` (no DOM moves).
 *
 * Worktree data:
 *  - Host half exposes `ctx.connection.rpc` channel `/dsh-worktree-tree`
 *    endpoint `snapshot` with the real `git worktree list` inventory (branch,
 *    HEAD, locked, prunable, dirty) per Workspace.
 *  - Without the host half (or while it fails) the plugin falls back to the
 *    DSH worktree path convention `<workspace>/.agents/worktrees/<branch>`
 *    discovered from each Session's recorded working directory.
 *
 * Only the "Workspace" / "Workspace tree" list modes are enriched. Flat list,
 * search results and the collapsed sidebar are left untouched.
 */

window.__ModuleLoader__.load({
	id: 'dsh-worktree-tree',
	factory: () => {
		var module = { exports: {} }
		var exports = module.exports

		const STYLE_ID = 'dsh-worktree-tree/style'
		const HEADER_ATTR = 'data-dswt-header'
		const FLEX_CLASS = 'dswt-flex'
		const COLLAPSED_KEY = 'dsh.worktree-tree.collapsed.v1'
		const POOL_SEGMENT = '/.agents/worktrees/'
		const CHANNEL = '/dsh-worktree-tree'
		const HOST_REFRESH_MS = 60 * 1000
		const HOST_TIMEOUT_MS = 10 * 1000
		const RENDER_DEBOUNCE_MS = 80
		const ORDER_PROJECT = 0
		const ORDER_NESTED_GROUPS = 1
		const ORDER_HEADER_BASE = 100
		const ORDER_HEADER_STEP = 100
		const ORDER_SESSION_OFFSET = 1
		const ORDER_OVERFLOW = 1e6

		/* ------------------------------------------------------------------ *
		 * Pure helpers (also exposed through exports.__test for Node tests)
		 * ------------------------------------------------------------------ */

		/** Normalize a display path: forward slashes, no trailing slash. */
		function normalizePath(value) {
			if (typeof value !== 'string') return ''
			const slashed = value.replaceAll('\\', '/')
			if (slashed === '') return ''
			const trimmed = slashed.replace(/\/+$/, '')
			return trimmed === '' ? '/' : trimmed
		}

		/** True when `child` equals `parent` or sits below it on a segment boundary. */
		function insidePath(child, parent) {
			const c = normalizePath(child)
			const p = normalizePath(parent)
			if (c === '' || p === '') return false
			if (p === '/') return c.startsWith('/')
			return c === p || c.startsWith(p + '/')
		}

		/** Final non-empty path segment. */
		function basename(value) {
			const normalized = normalizePath(value)
			const index = normalized.lastIndexOf('/')
			return index === -1 ? normalized : normalized.slice(index + 1)
		}

		/** Localized label for the primary checkout group. */
		function mainLabel(isZh) {
			return isZh ? '主分支' : 'Main'
		}

		/**
		 * Derive the worktree of a Session directory from the DSH worktree
		 * convention alone (no git): `<workspace>/.agents/worktrees/<branch>`.
		 * The relative remainder below the pool is the branch name, including
		 * slashed names such as `feat/retire`.
		 * @param cwd - recorded current working directory of the Session.
		 * @param workspacePath - registered Workspace directory.
		 * @returns one of `{kind:'main'}`, `{kind:'pool', branch}`, `{kind:'other'}`.
		 */
		function deriveLocation(cwd, workspacePath) {
			const dir = normalizePath(cwd)
			const root = normalizePath(workspacePath)
			if (dir === '' || root === '') return { kind: 'other' }
			const pool = normalizePath(root + POOL_SEGMENT)
			if (dir === pool) return { kind: 'main' }
			if (insidePath(dir, pool)) {
				const branch = dir.slice(pool.length + 1)
				return { kind: 'pool', branch }
			}
			if (insidePath(dir, root)) return { kind: 'main' }
			return { kind: 'other' }
		}

		/**
		 * Resolve a Session directory against an authoritative Host worktree
		 * list, choosing the deepest containing worktree.
		 * @param cwd - recorded current working directory.
		 * @param worktrees - Host worktrees (`{path, branch, head, main, ...}`).
		 * @param workspacePath - registered Workspace directory.
		 * @returns `{kind:'worktree', worktree}`, `{kind:'main'}`, or `undefined`.
		 */
		function hostLocation(cwd, worktrees, workspacePath) {
			const dir = normalizePath(cwd)
			if (dir === '') return undefined
			let best
			for (const worktree of worktrees ?? []) {
				const path = normalizePath(worktree?.path)
				if (path === '' || !insidePath(dir, path)) continue
				if (best === undefined || path.length > normalizePath(best.path).length) best = worktree
			}
			if (best !== undefined) {
				// The primary checkout contains the whole tree, including the worktree
				// pool; a Session inside the pool belongs to the pool entry when the
				// Host inventory lists one, and never to the primary checkout itself.
				const bestPath = normalizePath(best.path)
				const poolRoot = normalizePath(workspacePath + POOL_SEGMENT)
				const fromPool = dir !== poolRoot && insidePath(dir, poolRoot)
				const isPrimary = best.main === true || bestPath === normalizePath(workspacePath)
				if (!(fromPool && isPrimary)) return { kind: 'worktree', worktree: best }
			}
			if (insidePath(dir, workspacePath)) return { kind: 'main' }
			return undefined
		}

		function sessionCwd(summary) {
			if (summary === undefined || summary === null) return ''
			const projected = summary.projectionValues?.workingDirectory
			if (typeof projected === 'string' && projected !== '') return projected
			if (typeof summary.cwd === 'string' && summary.cwd !== '') return summary.cwd
			return ''
		}

		/**
		 * Build the display plan for one Workspace group section.
		 *
		 * @param options.workspace - client Workspace item (`workspaceId`, `path`, `title`).
		 * @param options.sessionRows - `{id, cwd}` in native DOM order.
		 * @param options.hostWorktrees - Host inventory for this Workspace, or null.
		 * @param options.collapsed - set of collapsed group keys.
		 * @param options.isZh - localized labels.
		 * @returns `{groups}` where each group carries `key`, `title`, `branch`,
		 * `head`, `main`, `dirty`, `sessionIds`, `count`, `collapsed`.
		 */
		function buildSectionPlan(options) {
			const workspace = options.workspace
			const workspacePath = normalizePath(workspace?.path)
			const rows = Array.isArray(options.sessionRows) ? options.sessionRows : []
			const hostWorktrees = Array.isArray(options.hostWorktrees) && options.hostWorktrees.length > 0 ? options.hostWorktrees : null
			const collapsed = options.collapsed !== undefined && options.collapsed !== null && typeof options.collapsed.has === 'function' ? options.collapsed : new Set()
			const isZh = options.isZh === true

			const groups = []
			const byKey = new Map()
			const register = (key, init) => {
				let group = byKey.get(key)
				if (group === undefined) {
					group = { sessionIds: [], count: 0, dirty: false, head: '', main: false, branch: '', ...init }
					byKey.set(key, group)
					groups.push(group)
				}
				return group
			}

			let mainKey = 'main'
			// 1. Host groups: primary checkout first, then every real worktree.
			if (hostWorktrees !== null) {
				const primary = hostWorktrees.find((worktree) => worktree.main === true || normalizePath(worktree.path) === workspacePath) ?? hostWorktrees[0]
				const primaryPath = normalizePath(primary?.path) || workspacePath
				mainKey = 'host:' + primaryPath
				register(mainKey, {
					key: mainKey,
					title: mainLabel(isZh),
					branch: typeof primary?.branch === 'string' ? primary.branch : '',
					head: typeof primary?.head === 'string' ? primary.head : '',
					main: true,
					dirty: primary?.dirty === true
				})
				for (const worktree of hostWorktrees) {
					if (worktree === primary) continue
					const key = 'host:' + normalizePath(worktree.path)
					register(key, {
						key,
						title: typeof worktree.branch === 'string' && worktree.branch !== '' ? worktree.branch : basename(worktree.path),
						branch: typeof worktree.branch === 'string' ? worktree.branch : '',
						head: typeof worktree.head === 'string' ? worktree.head : '',
						main: false,
						dirty: worktree.dirty === true
					})
				}
			}

			// 2. Assign every native row, falling back to the path convention.
			for (const row of rows) {
				const cwd = normalizePath(row.cwd)
				let key
				let title
				let branch = ''
				let head = ''
				let main = false
				let dirty = false
				if (hostWorktrees !== null) {
					const location = hostLocation(cwd, hostWorktrees, workspacePath)
					if (location?.kind === 'worktree') {
						const worktree = location.worktree
						key = 'host:' + normalizePath(worktree.path)
						title = typeof worktree.branch === 'string' && worktree.branch !== '' ? worktree.branch : basename(worktree.path)
						branch = typeof worktree.branch === 'string' ? worktree.branch : ''
						head = typeof worktree.head === 'string' ? worktree.head : ''
						dirty = worktree.dirty === true
						register(key, { key, title, branch, head, main: false, dirty })
					} else {
						// The Host inventory can lag a freshly created worktree: fall back
						// to the path convention instead of folding the row into the primary
						// checkout group.
						const derived = deriveLocation(cwd, workspacePath)
						if (derived.kind === 'pool') {
							key = 'pool:' + derived.branch
							title = derived.branch
							branch = derived.branch
							register(key, { key, title, branch, head, main: false, dirty })
						} else {
							key = mainKey
							title = mainLabel(isZh)
							main = true
						}
					}
				} else {
					const location = deriveLocation(cwd, workspacePath)
					if (location.kind === 'pool') {
						key = 'pool:' + location.branch
						title = location.branch
						branch = location.branch
					} else if (location.kind === 'main') {
						key = 'main'
						title = mainLabel(isZh)
						main = true
					} else if (cwd === '') {
						key = 'unknown'
						title = isZh ? '未知位置' : 'Unknown'
					} else {
						key = 'other:' + cwd
						title = basename(cwd) || cwd
					}
					register(key, { key, title, branch, head, main, dirty })
				}
				const group = byKey.get(key)
				if (group !== undefined) group.sessionIds.push(row.id)
			}

			// 3. Keep empty Host groups (real worktrees without Sessions), drop
			//    empty derived placeholders, then order primary → worktrees → rest.
			const result = []
			for (const group of groups) {
				group.count = group.sessionIds.length
				if (group.count === 0 && !group.key.startsWith('host:')) continue
				result.push({
					key: group.key,
					title: group.title,
					branch: group.branch,
					head: group.head,
					main: group.main === true,
					dirty: group.dirty === true,
					sessionIds: group.sessionIds,
					count: group.count,
					collapsed: collapsed.has(group.key)
				})
			}
			const rank = (group) => (group.main ? 0 : group.key.startsWith('host:') ? 1 : 2)
			result.sort((a, b) => {
				const ra = rank(a)
				const rb = rank(b)
				if (ra !== rb) return ra - rb
				return a.title.localeCompare(b.title)
			})
			return { groups: result }
		}

		/* ------------------------------------------------------------------ *
		 * Runtime
		 * ------------------------------------------------------------------ */

		function readLocaleFlag() {
			const language = (typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : '').toLowerCase()
			if (language.startsWith('zh')) return true
			const lang = typeof document !== 'undefined' ? String(document.documentElement.getAttribute('lang') ?? '').toLowerCase() : ''
			return lang.startsWith('zh')
		}

		function loadCollapsed() {
			try {
				const raw = window.localStorage.getItem(COLLAPSED_KEY)
				if (raw === null) return new Set()
				const parsed = JSON.parse(raw)
				return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [])
			} catch {
				return new Set()
			}
		}

		function saveCollapsed(set) {
			try {
				window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]))
			} catch {
				// Quota or a locked profile: keep the in-memory state usable.
			}
		}

		function ensureStyles() {
			if (document.getElementById(STYLE_ID) !== null) return
			const style = document.createElement('style')
			style.id = STYLE_ID
			style.textContent = `
				.${FLEX_CLASS} { display: flex; flex-direction: column; }
				[${HEADER_ATTR}] {
					flex: none; display: flex; align-items: center; gap: 6px;
					height: 28px; padding: 0 8px 0 calc(8px + var(--dsh-workspace-indent, 0px) + 2px);
					margin-top: 2px; border-radius: var(--dsw-radius-md, 6px);
					cursor: pointer; user-select: none;
					color: var(--dsw-alias-label-tertiary, #9aa0a6);
					font-size: 11px; line-height: 16px; letter-spacing: 0.02em;
				}
				[${HEADER_ATTR}]:hover { color: var(--dsw-alias-label-secondary, #b6bcc2); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
				[${HEADER_ATTR}] .dswt-chevron {
					flex: none; width: 14px; display: inline-flex; align-items: center; justify-content: center;
					transition: transform .15s ease;
				}
				[${HEADER_ATTR}][data-dswt-collapsed="true"] .dswt-chevron { transform: rotate(-90deg); }
				[${HEADER_ATTR}] .dswt-label { flex: none; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				[${HEADER_ATTR}] .dswt-branch {
					flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
					padding: 0 5px; border-radius: 4px;
					background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14));
					color: var(--dsw-alias-label-secondary, #b6bcc2);
					font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; line-height: 16px;
				}
				[${HEADER_ATTR}] .dswt-branch[hidden] { display: none; }
				[${HEADER_ATTR}] .dswt-count { flex: none; margin-left: auto; font-variant-numeric: tabular-nums; }
				[${HEADER_ATTR}] .dswt-dot {
					flex: none; width: 6px; height: 6px; border-radius: 50%;
					background: var(--dsw-alias-state-warning-primary, #f2b34c);
				}
				[${HEADER_ATTR}] .dswt-dot[hidden] { display: none; }
				[${HEADER_ATTR}] .dswt-spacer { flex: 1 1 auto; min-width: 0; }
			`
			document.head.appendChild(style)
		}

		function createRuntime(ctx) {
			const workspaces = ctx.get('workspaces')
			const sessions = ctx.get('sessions')
			const connection = ctx.get('connection')
			if (workspaces === undefined || workspaces === null || workspaces.list === undefined) return undefined
			if (sessions === undefined || sessions === null || sessions.list === undefined) return undefined

			const collapsed = loadCollapsed()
			const sectionState = new Map()
			let started = false
			let observer
			let hostSnapshot = null
			let hostFetchedAt = 0
			let hostPending
			let hostPendingAt = 0
			let disposers = []
			let debounceTimer
			let refreshTimer
			let localeFlag = readLocaleFlag()

			const workspaceItems = () => {
				const snapshot = workspaces.list.getSnapshot()
				return Array.isArray(snapshot?.items) ? snapshot.items : []
			}

			const sessionStore = () => sessions.list.getSnapshot()

			const hostWorktreesFor = (workspaceId) => {
				if (hostSnapshot === null) return null
				const entry = (hostSnapshot.workspaces ?? []).find((workspace) => workspace.workspaceId === workspaceId)
				if (entry === undefined || !Array.isArray(entry.worktrees) || entry.worktrees.length === 0) return null
				return entry.worktrees
			}

			/** Host-read current directory for a Session, when the Host half served one. */
			const hostSessionCwd = (sessionId) => {
				const map = hostSnapshot?.sessions
				if (map === null || typeof map !== 'object') return ''
				const cwd = map[sessionId]
				return typeof cwd === 'string' ? cwd : ''
			}

			const requestHostSnapshot = () => {
				if (connection === undefined || connection === null || connection.rpc === undefined || typeof connection.rpc.call !== 'function') return Promise.resolve(undefined)
				const now = Date.now()
				if (hostPending !== undefined && now - hostPendingAt < HOST_TIMEOUT_MS) return hostPending
				hostPendingAt = now
				const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(HOST_TIMEOUT_MS) : undefined
				hostPending = Promise.resolve()
					.then(() => connection.rpc.call(CHANNEL, 'snapshot', {}, signal))
					.then((response) => {
						// The Host unary result is an envelope: {ok:true, value} or {ok:false, error}.
						const payload = response !== null && typeof response === 'object' && response.ok === true && 'value' in response ? response.value : response
						if (payload !== null && typeof payload === 'object' && Array.isArray(payload.workspaces)) {
							hostSnapshot = payload
							hostFetchedAt = Date.now()
						}
						return hostSnapshot
					})
					.catch(() => undefined)
					.finally(() => {
						hostPending = undefined
					})
				return hostPending
			}

			const schedule = () => {
				if (!started) return
				if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
				debounceTimer = window.setTimeout(() => {
					debounceTimer = undefined
					render()
				}, RENDER_DEBOUNCE_MS)
			}

			const collectLists = () => {
				const lists = []
				for (const list of document.querySelectorAll('[role="tree"]')) {
					if (list.querySelector('[data-row-key^="workspace:"]') !== null) lists.push(list)
				}
				return lists
			}

			const sectionSessions = (section) => {
				const rows = []
				for (const child of section.children) {
					const key = child.getAttribute('data-row-key')
					if (key === null || !key.startsWith('session:')) continue
					rows.push({ id: key.slice('session:'.length), element: child })
				}
				return rows
			}

			const makeHeader = (section, group) => {
				const header = document.createElement('div')
				header.setAttribute(HEADER_ATTR, group.key)
				header.setAttribute('role', 'button')
				header.setAttribute('tabindex', '0')
				const chevron = document.createElement('span')
				chevron.className = 'dswt-chevron'
				chevron.textContent = '▾'
				const label = document.createElement('span')
				label.className = 'dswt-label'
				const branch = document.createElement('span')
				branch.className = 'dswt-branch'
				const spacer = document.createElement('span')
				spacer.className = 'dswt-spacer'
				const dirty = document.createElement('span')
				dirty.className = 'dswt-dot'
				const count = document.createElement('span')
				count.className = 'dswt-count'
				header.append(chevron, label, branch, spacer, dirty, count)
				header.addEventListener('click', () => toggleCollapsed(group.key))
				header.addEventListener('keydown', (event) => {
					if (event.key !== 'Enter' && event.key !== ' ') return
					event.preventDefault()
					toggleCollapsed(group.key)
				})
				section.appendChild(header)
				return header
			}

			const updateHeader = (header, group) => {
				const label = header.querySelector('.dswt-label')
				const branch = header.querySelector('.dswt-branch')
				const count = header.querySelector('.dswt-count')
				const dirty = header.querySelector('.dswt-dot')
				if (label !== null) label.textContent = group.title
				if (branch !== null) {
					const text = group.branch !== '' && group.branch !== group.title ? group.branch : group.head !== '' ? group.head.slice(0, 7) : ''
					branch.textContent = text
					branch.hidden = text === ''
				}
				if (count !== null) count.textContent = String(group.count)
				if (dirty !== null) dirty.hidden = group.dirty !== true
				header.dataset.dswtCollapsed = group.collapsed ? 'true' : 'false'
				header.setAttribute('aria-expanded', group.collapsed ? 'false' : 'true')
				header.title = group.branch !== '' ? group.branch : group.title
			}

			const toggleCollapsed = (key) => {
				if (collapsed.has(key)) collapsed.delete(key)
				else collapsed.add(key)
				saveCollapsed(collapsed)
				for (const state of sectionState.values()) state.signature = undefined
				schedule()
			}

			const applySection = (section, workspace, plan, sessionRows) => {
				const indexOf = new Map()
				plan.groups.forEach((group, index) => indexOf.set(group.key, index))
				const previous = sectionState.get(section)
				const signature = JSON.stringify({
					plan: plan.groups.map((group) => [group.key, group.title, group.branch, group.head, group.count, group.dirty, group.collapsed]),
					rows: sessionRows.map((row) => row.id),
					workspace: workspace.workspaceId,
					host: hostWorktreesFor(workspace.workspaceId) === null ? 0 : 1,
					hostCwd: sessionRows.map((row) => hostSessionCwd(row.id)).join('|')
				})
				if (previous !== undefined && previous.signature === signature) {
					let intact = section.querySelector('[data-dswt-header]') !== null && section.classList.contains(FLEX_CLASS)
					if (intact) {
						for (const row of sessionRows) {
							if (row.element.style.order === '') {
								intact = false
								break
							}
						}
					}
					if (intact) return
				}
				const headers = previous?.headers ?? new Set()
				sectionState.set(section, { signature, groupIndex: indexOf, headers, workspaceId: workspace.workspaceId })

				let projectRow = null
				for (const child of section.children) {
					const rowKey = child.getAttribute('data-row-key')
					if (rowKey !== null && rowKey.startsWith('workspace:')) {
						projectRow = child
						break
					}
				}
				// A collapsed Workspace unmounts its Session rows; keep the injected
				// headers hidden in that state instead of showing empty groups.
				const workspaceCollapsed = projectRow !== null && projectRow.getAttribute('aria-expanded') === 'false'

				section.classList.add(FLEX_CLASS)
				for (const child of section.children) {
					const rowKey = child.getAttribute('data-row-key')
					if (rowKey === null) {
						if (child.getAttribute(HEADER_ATTR) === null) child.style.order = String(ORDER_NESTED_GROUPS)
						continue
					}
					if (rowKey.startsWith('workspace:')) child.style.order = String(ORDER_PROJECT)
					else if (rowKey.startsWith('overflow:')) child.style.order = String(ORDER_OVERFLOW)
				}

				const bySession = new Map(sessionRows.map((row) => [row.id, row]))
				const seen = new Set()
				plan.groups.forEach((group, groupIndex) => {
					let header = null
					for (const child of section.children) {
						if (child.getAttribute(HEADER_ATTR) === group.key) {
							header = child
							break
						}
					}
					if (header === null) {
						header = makeHeader(section, group)
						headers.add(header)
					}
					updateHeader(header, group)
					// Keep injected headers in plan order in the DOM (visual order is CSS
					// `order`); appending an already-last child is a no-op.
					section.appendChild(header)
					header.style.display = workspaceCollapsed ? 'none' : ''
					const headerOrder = ORDER_HEADER_BASE + groupIndex * ORDER_HEADER_STEP
					header.style.order = String(headerOrder)
					group.sessionIds.forEach((sessionId, sessionIndex) => {
						const row = bySession.get(sessionId)
						if (row === undefined) return
						seen.add(sessionId)
						row.element.style.order = String(headerOrder + ORDER_SESSION_OFFSET + sessionIndex)
						if (group.collapsed) {
							row.element.style.display = 'none'
							row.element.dataset.dswtHidden = 'true'
						} else if (row.element.dataset.dswtHidden === 'true') {
							row.element.style.display = ''
							delete row.element.dataset.dswtHidden
						}
					})
				})
				// A row the plan could not resolve stays in native order below the groups.
				sessionRows.forEach((row, rowIndex) => {
					if (seen.has(row.id)) return
					row.element.style.order = String(ORDER_OVERFLOW - 1 + rowIndex)
					if (row.element.dataset.dswtHidden === 'true') {
						row.element.style.display = ''
						delete row.element.dataset.dswtHidden
					}
				})
				// Drop headers of groups that no longer exist (collapsed worktree removed).
				for (const header of [...headers]) {
					if (!header.isConnected) {
						headers.delete(header)
						continue
					}
					const key = header.getAttribute(HEADER_ATTR)
					if (!indexOf.has(key)) {
						header.remove()
						headers.delete(header)
					}
				}
			}

			const cleanupSection = (section) => {
				const state = sectionState.get(section)
				if (state === undefined) return
				for (const header of state.headers) header.remove()
				section.classList.remove(FLEX_CLASS)
				for (const child of section.children) {
					if (child.style === undefined) continue
					child.style.order = ''
					if (child.dataset?.dswtHidden === 'true') {
						child.style.display = ''
						delete child.dataset.dswtHidden
					}
				}
				sectionState.delete(section)
			}

			const render = () => {
				if (!started) return
				localeFlag = readLocaleFlag()
				const liveSections = new Set()
				const sessionSnapshot = sessionStore()
				const byWorkspaceId = new Map(workspaceItems().map((item) => [item.workspaceId, item]))
				for (const list of collectLists()) {
					for (const section of list.children) {
						let projectRow = null
						for (const child of section.children) {
							const key = child.getAttribute('data-row-key')
							if (key !== null && key.startsWith('workspace:')) {
								projectRow = child
								break
							}
						}
						if (projectRow === null) continue
						liveSections.add(section)
						const workspaceId = projectRow.getAttribute('data-row-key').slice('workspace:'.length)
						const workspace = byWorkspaceId.get(workspaceId)
						if (workspace === undefined) {
							cleanupSection(section)
							continue
						}
						const rows = sectionSessions(section).map((row) => ({
							id: row.id,
							element: row.element,
							cwd: hostSessionCwd(row.id) || sessionCwd(sessionSnapshot?.byId?.[row.id])
						}))
						const plan = buildSectionPlan({
							workspace,
							sessionRows: rows,
							hostWorktrees: hostWorktreesFor(workspaceId),
							collapsed,
							isZh: localeFlag
						})
						applySection(section, workspace, plan, rows)
					}
				}
				for (const section of [...sectionState.keys()]) {
					if (!liveSections.has(section)) cleanupSection(section)
				}
			}

			const start = () => {
				started = true
				ensureStyles()
				render()
				const unsubscribeWorkspaces = workspaces.list.subscribe(schedule)
				const unsubscribeSessions = sessions.list.subscribe(schedule)
				disposers = [unsubscribeWorkspaces, unsubscribeSessions]
				observer = new MutationObserver(() => schedule())
				// Observe child-list churn and class resets (React rewrites className);
				// our own writes are style-only and do not feed this observer.
				observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
				const refresh = () => {
					if (Date.now() - hostFetchedAt < 15 * 1000) return
					requestHostSnapshot().then(() => schedule())
				}
				const onFocus = () => refresh()
				const onVisibility = () => {
					if (document.visibilityState === 'visible') refresh()
				}
				window.addEventListener('focus', onFocus)
				document.addEventListener('visibilitychange', onVisibility)
				refreshTimer = window.setInterval(() => {
					if (document.visibilityState === 'visible') requestHostSnapshot().then(() => schedule())
				}, HOST_REFRESH_MS)
				requestHostSnapshot().then(() => schedule())
				return () => {
					started = false
					if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
					if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
					if (observer !== undefined) observer.disconnect()
					window.removeEventListener('focus', onFocus)
					document.removeEventListener('visibilitychange', onVisibility)
					for (const dispose of disposers) {
						try {
							dispose()
						} catch {
							// The store may already be disposed with the client tree.
						}
					}
					disposers = []
					for (const section of [...sectionState.keys()]) cleanupSection(section)
					const style = document.getElementById(STYLE_ID)
					if (style !== null) style.remove()
				}
			}

			return { start, schedule }
		}

		function apply(ctx) {
			const runtime = createRuntime(ctx)
			if (runtime === undefined) return
			ctx.effect(() => runtime.start(), 'worktree-tree')
		}

		exports.apply = apply
		exports.inject = ['workspaces', 'sessions', 'connection']
		exports.__test = {
			normalizePath,
			insidePath,
			basename,
			deriveLocation,
			hostLocation,
			sessionCwd,
			buildSectionPlan,
			mainLabel
		}
		return module.exports
	}
})
