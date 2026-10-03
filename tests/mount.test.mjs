/**
 * Mount tests for the dsh-session-multiselect client bundle.
 *
 * These drive the real bundle the way the page does: a fake
 * `window.__ModuleLoader__` captures the registration, `factory()` is invoked
 * with a fake `require` backed by stand-ins for the module table, and the
 * exported `apply(ctx)` runs against a fake Cordis client context. That covers
 * what unit tests of the pure helpers cannot: the dictionary key set, the slot
 * registration, the store shape, the rendered panel, and that a batch action
 * reaches the service layer.
 *
 * Run: node --test tests/mount.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

// --- stand-ins for the browser module table ---------------------------------

/** Store factory stand-in with real snapshot/subscribe semantics. */
function makeStore(initState, persistedKey) {
	let state = initState
	const listeners = new Set()
	return {
		getSnapshot: () => state,
		subscribe(fn) {
			listeners.add(fn)
			return () => listeners.delete(fn)
		},
		update(mutator) {
			const draft = JSON.parse(JSON.stringify(state))
			mutator(draft)
			state = draft
			if (persistedKey !== undefined) globalThis.localStorage?.setItem(persistedKey, JSON.stringify(state))
			for (const fn of [...listeners]) fn()
		},
		set(next) {
			state = next
			for (const fn of [...listeners]) fn()
		}
	}
}

const clientStore = {
	defineStore(decl) {
		return {
			spec: decl,
			create(scopeKey) {
				const persistKey = decl.persist === undefined ? undefined : scopeKey === undefined ? decl.persist : `${decl.persist}.${scopeKey}`
				const store = makeStore(decl.init(), persistKey)
				const actions = {}
				for (const key of Object.keys(decl.actions)) {
					actions[key] = (...params) => {
						store.update((draft) => {
							decl.actions[key](draft, ...params)
						})
					}
				}
				return { actions, getSnapshot: () => store.getSnapshot(), subscribe: (fn) => store.subscribe(fn), store }
			}
		}
	},
	createSnapshotStore(init, opts) {
		return makeStore(init, opts?.persist?.name)
	}
}

/** Fragment identity shared by the React and jsx-runtime stand-ins. */
const FRAGMENT = Symbol('Fragment')

/** Primitives stand-in: every required export exists, is named, and records props. */
function makePrimitives(rendered) {
	/** Build a named component function so assertions can identify it. */
	const named = (name) => {
		const component = (props) => {
			rendered.push({ name, props })
			return { type: component, props }
		}
		Object.defineProperty(component, 'name', { value: name })
		return component
	}
	const required = [
		// The 0.10 names: this stub mirrors what the installed primitives ship, so
		// a test that silently depended on an older spelling would fail here.
		'Modal', 'Button', 'Input', 'Tooltip',
		'IconSearchOutlineRegular', 'IconChecklistOutlineRegular', 'IconLoadingOutlineRegular'
	]
	const table = {}
	for (const name of required) table[name] = named(name)
	return table
}

/**
 * React stand-in with real state semantics, so a test can drive a component the
 * way a user does: call a setter, then re-render. Hooks are namespaced per
 * component, because real React keeps a separate hook slot per component 鈥攐ne
 * shared cursor would wrongly collide a child's `useState` with its parent's.
 */
function makeReact() {
	const runtime = {
		slots: new Map(),
		active: 'anonymous',
		cursor: 0,
		effects: [],
		/**
		 * One hook cell per call position, in call order 鈥攖he same discipline
		 * React enforces. `useState` and `useRef` must therefore not share a
		 * cursor, or a ref would read a state's slot.
		 */
		hook(make) {
			const slot = runtime.slot()
			const index = runtime.cursor
			runtime.cursor += 1
			if (slot.hooks.length <= index) slot.hooks.push(make())
			return { slot, index }
		},
		useState(init) {
			const { slot, index } = runtime.hook(() => ({
				kind: 'state',
				value: typeof init === 'function' ? init() : init
			}))
			if (slot.hooks[index].setter === undefined) {
				slot.hooks[index].setter = (next) => {
					const cell = slot.hooks[index]
					cell.value = typeof next === 'function' ? next(cell.value) : next
				}
			}
			return [slot.hooks[index].value, slot.hooks[index].setter]
		},
		useRef(init) {
			const { slot, index } = runtime.hook(() => ({ kind: 'ref', value: { current: init } }))
			return slot.hooks[index].value
		},
		useMemo(fn) { return fn() },
		useCallback(fn) { return fn },
		useEffect(fn) { runtime.effects.push(fn) },
		useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
		// The panel's error boundary is a class component; React ships the base
		// class on the same module, so the stand-in must too.
		Component: class Component {
			constructor(props) { this.props = props; this.state = {} }
			setState(next) { this.state = { ...this.state, ...next } }
		},
		Fragment: FRAGMENT,
		/** Current component's hook slot, created on first use. */
		slot() {
			let slot = runtime.slots.get(runtime.active)
			if (slot === undefined) {
				slot = { hooks: [] }
				runtime.slots.set(runtime.active, slot)
			}
			return slot
		},
		/** Run one component body as its own hook namespace. */
		withHooks(name, fn) {
			const previous = runtime.active
			runtime.active = name
			runtime.cursor = 0
			try {
				return fn()
			} finally {
				runtime.active = previous
			}
		},
		/** Setter of the nth `useState` call of one component, in call order. */
		setterOf(name, stateIndex) {
			const states = (runtime.slots.get(name)?.hooks ?? []).filter((cell) => cell.kind === 'state')
			return states[stateIndex]?.setter
		}
	}
	return runtime
}

/**
 * jsx-runtime stand-in. The bundle passes children on `props` and uses the
 * trailing argument for `key`, so elements are recorded verbatim; inventing
 * extra folding here would diverge from what React actually receives.
 */
const jsxRuntime = {
	jsx: (type, props) => ({ type, props: { ...props } }),
	jsxs: (type, props) => ({ type, props: { ...props } }),
	Fragment: FRAGMENT
}

/** Load the bundle once and hand back an instantiator bound to fresh modules. */
function loadBundle() {
	const source = readFileSync(bundlePath, 'utf8')
	let registration
	// The frame clock and observer are inert here: this suite covers the panel,
	// not the header injection (see inline.test.mjs for that path).
	const window = {
		__ModuleLoader__: { load: (value) => { registration = value } },
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {}
	}
	globalThis.window = window
	globalThis.MutationObserver = class {
		observe() {}
		disconnect() {}
	}
	// eslint-disable-next-line no-new-func -- the bundle is CJS-formatted browser code
	new Function('window', 'globalThis', source)(window, globalThis)
	return {
		registration,
		/**
		 * Materialize the bundle with the given primitives table and React
		 * runtime. Each call gets its own module table, so hook state never
		 * leaks between tests.
		 */
		instantiate(primitives, reactRuntime = makeReact()) {
			const table = new Map([
				['@deepseek-ai/dsh-client-store', clientStore],
				['@deepseek-ai/dsh-client-ui-primitives', primitives],
				['react', reactRuntime],
				// react-dom/client is only used for the header injection, which the
				// mount suite does not exercise; a stub keeps the module table whole.
				['react-dom/client', { createRoot: () => ({ render() {}, unmount() {} }) }],
				['react/jsx-runtime', jsxRuntime]
			])
			return {
				exports: registration.factory((spec) => {
					if (!table.has(spec)) throw new Error(`unexpected require(${spec})`)
					return table.get(spec)
				}),
				react: reactRuntime
			}
		}
	}
}

/** Fake Cordis client context capturing every effect and registration. */
function makeCtx({ sessions, workspaces }) {
	const registrations = []
	const dictionaries = new Map()
	const effects = []
	const ctx = {
		effect(fn, label) {
			effects.push({ label, dispose: fn() })
			return () => {}
		},
		locale: {
			register(ns, dicts) {
				dictionaries.set(ns, dicts)
				return () => {}
			},
			subscribe: () => () => {}
		},
		slots: {
			inject(key, fn) {
				registrations.push({ key, entry: fn() })
				return () => {}
			},
			register(options, component) {
				return { options, component }
			}
		},
		// The workspace service is fetched lazily, never injected (a build without
		// it must still mount), so the stand-in answers `get` like Cordis does:
		// the service, or undefined.
		get: (name) => (name === 'workspaces' ? workspaces : undefined),
		sessions
	}
	return { ctx, registrations, dictionaries, effects }
}

/**
 * Fake `sessions` service matching the Session Controller client surface.
 *
 * `shape` picks the snapshot the controller actually hands out: the normalized
 * `{ ids, byId, 鈥?}` one (what the workspace and other clients read) or the
 * flattened `{ items, 鈥?}` projection. Both must list sessions.
 */
function makeSessions({ items = [], records = {}, onCreate = () => 'new-session', shape = 'normalized' } = {}) {
	const calls = { deleted: [], forked: [], created: [], prompted: [], opened: [] }
	let summaries = [...items]
	/** Rebuild the snapshot in the shape under test. */
	const buildState = () => {
		const base = { current: undefined, state: 'idle', phase: 'ready', error: null }
		if (shape === 'items') return { ...base, items: summaries }
		const byId = {}
		for (const summary of summaries) {
			// Faithful to the controller's projection: each value carries the id as
			// `id` and a derived `displayTitle`; `sessionId` and `title` are not part
			// of it. Fixtures keeping the friendly names would hide exactly the bug
			// where every row ends up keyed on a missing `sessionId` 鈥?one click
			// then selects every row.
			const { sessionId, title, ...rest } = summary
			byId[sessionId] = {
				id: sessionId,
				...(title === undefined ? {} : { displayTitle: title }),
				...rest
			}
		}
		return { ...base, ids: summaries.map((summary) => summary.sessionId), byId }
	}
	let listState = buildState()
	const listListeners = new Set()
	const service = {
		list: {
			getSnapshot: () => listState,
			subscribe(fn) {
				listListeners.add(fn)
				return () => listListeners.delete(fn)
			}
		},
		get(sessionId) {
			const entries = (records[sessionId] ?? []).map((event) => ({ event }))
			return {
				open: async () => { calls.opened.push(sessionId) },
				loadOlder: async () => {},
				getSnapshot: () => ({ hasMore: false, openState: 'open' }),
				get events() {
					return { entries: () => entries }
				},
				prompt: async (content, mode) => {
					calls.prompted.push({ sessionId, content, mode })
					return { ok: true, value: { accepted: true } }
				}
			}
		},
		async delete(sessionId) {
			calls.deleted.push(sessionId)
			const index = summaries.findIndex((item) => item.sessionId === sessionId)
			if (index === -1) throw Object.assign(new Error('unknown session'), { code: 'session/not-found' })
			summaries = summaries.filter((item) => item.sessionId !== sessionId)
			listState = buildState()
			for (const fn of [...listListeners]) fn()
		},
		async fork(opts) {
			calls.forked.push(opts.sessionId)
			return `${opts.sessionId}-fork`
		},
		async create(opts) {
			calls.created.push(opts)
			return onCreate(opts)
		},
		open(sessionId) { calls.opened.push(sessionId) },
		calls
	}
	return service
}

/**
 * Fake `workspaces` service, matching the client Workspace Controller.
 *
 * Pinning and archiving live here rather than on `sessions`: this is the service
 * that moves a row into DSH's own pinned group or archive section, and the
 * snapshot is where the panel reads that membership from.
 * @param options - `pinned`/`archived` seed the sets the host would report.
 */
function makeWorkspaces({ pinned = [], archived = [] } = {}) {
	const calls = { pinned: [], unpinned: [], archived: [], unarchived: [] }
	const listeners = new Set()
	let state = { pinnedSessionIds: [...pinned], archivedSessionIds: [...archived] }
	const publish = (next) => {
		state = next
		for (const fn of [...listeners]) fn()
	}
	return {
		calls,
		list: {
			getSnapshot: () => state,
			subscribe(fn) {
				listeners.add(fn)
				return () => listeners.delete(fn)
			}
		},
		async pinSession(sessionId) {
			calls.pinned.push(sessionId)
			publish({ ...state, pinnedSessionIds: [sessionId, ...state.pinnedSessionIds.filter((id) => id !== sessionId)] })
		},
		async unpinSession(sessionId) {
			calls.unpinned.push(sessionId)
			publish({ ...state, pinnedSessionIds: state.pinnedSessionIds.filter((id) => id !== sessionId) })
		},
		async archiveSession(sessionId) {
			calls.archived.push(sessionId)
			publish({ ...state, archivedSessionIds: [...state.archivedSessionIds.filter((id) => id !== sessionId), sessionId] })
		},
		async unarchiveSession(sessionId) {
			calls.unarchived.push(sessionId)
			publish({ ...state, archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId) })
		}
	}
}

/** Let queued microtasks (the async batch actions) settle. */
const flush = () => new Promise((resolve) => { setImmediate(resolve) })

/** Mount the plugin and return everything a test needs to drive it. */
function mount({ items = [], records, onCreate, shape, workspaces } = {}) {
	const bundle = loadBundle()
	const primitives = makePrimitives([])
	const react = makeReact()
	const { exports } = bundle.instantiate(primitives, react)
	const sessions = makeSessions({ items, records, onCreate, shape })
	const { ctx, registrations, dictionaries, effects } = makeCtx({ sessions, workspaces })
	exports.apply(ctx)
	const registration = registrations[0]
	const face = registration.entry.options.inject()
	const props = {
		actions: face.actions,
		hooks: face.hooks,
		// The slot hands the component exactly what `inject()` returned; the
		// resolved icons and the tooltip helper travel with it.
		icons: face.icons,
		tip: face.tip,
		t: (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)
	}
	const renderEntry = () => react.withHooks('MultiSelectEntry', () => registration.entry.component(props))
	/**
	 * Open the panel the way the document-level trigger does 鈥?through the
	 * plugin's own store 鈥?then render the entry that should show it.
	 */
	const openAndRender = () => {
		face.hooks.panel.set({ open: true })
		return renderEntry()
	}
	/**
	 * The panel element the open entry renders: the modal holds the error
	 * boundary, and the boundary holds the panel.
	 */
	const panelElementOf = () => openAndRender().props.children[1].props.children.props.children
	/**
	 * Render the open entry and return the rendered panel body. The jsx
	 * stand-in records elements without invoking them (React does that at
	 * commit), so the panel is driven explicitly here.
	 */
	const renderPanelBody = (overrides = {}) => {
		const panelElement = panelElementOf()
		return react.withHooks('MultiSelectPanel', () => panelElement.type({ ...panelElement.props, ...overrides }))
	}
	return {
		exports,
		registration: bundle.registration,
		primitives,
		react,
		sessions,
		workspaces,
		dictionaries,
		effects,
		slotKey: registration.key,
		entry: registration.entry,
		/** The registration for one slot name (the footer entry is registered first). */
		registrationFor: (key) => registrations.find((item) => item.key === key),
		face,
		props,
		renderEntry,
		panelElementOf,
		openAndRender,
		renderPanelBody
	}
}

// --- tests ------------------------------------------------------------------

test('apply registers dictionaries, a store, and the footer slot entry', () => {
	const world = mount()
	assert.deepEqual(world.exports.inject, ['slots', 'locale', 'sessions'])
	assert.equal(world.registration.id, 'dsh-session-multiselect')

	const options = world.entry.options
	assert.equal(world.slotKey, 'sidebar.footer.action')
	assert.equal(options.name, 'sidebar.footer.action')
	assert.equal(options.id, 'session-multiselect')
	assert.equal(options.locale, 'sessionMultiselect')
	assert.equal(typeof world.entry.component, 'function')

	for (const method of ['deleteSessions', 'markInlineProven']) {
		assert.equal(typeof world.face.actions[method], 'function', `actions.${method}`)
	}
	assert.equal(typeof world.face.hooks.sessions.getSnapshot, 'function')
	assert.equal(typeof world.face.hooks.sessions.subscribe, 'function')
	assert.equal(typeof world.face.hooks.store.getSnapshot, 'function')
	assert.equal(typeof world.face.hooks.store.actions.setArchived, 'function')

	const dicts = world.dictionaries.get('sessionMultiselect')
	assert.ok(dicts.zh !== undefined && dicts.en !== undefined)
	assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), 'zh and en must share a key set')
	for (const key of Object.keys(dicts.zh)) {
		assert.equal(typeof dicts.zh[key], 'string', `zh.${key}`)
		assert.equal(typeof dicts.en[key], 'string', `en.${key}`)
	}
	assert.ok(world.effects.some((effect) => effect.label.includes('dictionaries')))
})

test('every locale key the panel asks for exists in both dictionaries', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30 },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20, running: true }
		]
	})
	const dicts = world.dictionaries.get('sessionMultiselect')
	const asked = new Set()
	const record = (key, params) => {
		asked.add(key)
		return params === undefined ? key : `${key}${JSON.stringify(params)}`
	}
	world.renderPanelBody({ t: record })
	// The other surfaces ask for copy too: the bar over the list, and both settings
	// entries. A key that only one of them knows is a raw key in front of the user.
	world.react.withHooks('InlineBar', () => world.exports.InlineBar({
		t: record,
		hooks: world.face.hooks,
		handlers: {
			onToggleAll() {}, onDelete() {}, onCancel() {}, onConfirm() {},
			onArchive() {}, onPin() {}, onPanel() {}, onExit() {}
		}
	}))
	for (const view of ['summary', 'page']) {
		world.react.withHooks('SessionModeSettings', () => world.exports.SessionModeSettings({ t: record, view, hooks: { store: world.face.hooks.store, setMode() {} } }))
	}
	world.react.withHooks('SessionModeRow', () => world.exports.SessionModeRow({ t: record, hooks: { store: world.face.hooks.store, setMode() {} } }))
	assert.deepEqual([...asked].filter((key) => !(key in dicts.zh)), [], 'keys missing from the zh dictionary')
	assert.deepEqual([...asked].filter((key) => !(key in dicts.en)), [], 'keys missing from the en dictionary')
	assert.ok(asked.size > 20, `the surfaces should ask for a real set of labels, saw ${String(asked.size)}`)
})

test('apply refuses to mount when a structural primitive is missing', () => {
	const bundle = loadBundle()
	const primitives = makePrimitives([])
	delete primitives.Modal
	const { exports } = bundle.instantiate(primitives, makeReact())
	const { ctx } = makeCtx({ sessions: makeSessions() })
	assert.throws(() => exports.apply(ctx), /Modal/u)
})

test('a renamed or missing icon falls back to its own artwork instead of failing the mount', () => {
	const bundle = loadBundle()
	const primitives = makePrimitives([])
	// DSH 0.10 renamed every icon; a build that renames them again must cost a
	// glyph, not the feature.
	delete primitives.IconChecklistOutlineRegular
	delete primitives.IconSearchOutlineRegular
	delete primitives.IconLoadingOutlineRegular
	const { exports } = bundle.instantiate(primitives, makeReact())
	const { ctx, registrations } = makeCtx({ sessions: makeSessions() })
	exports.apply(ctx)
	const face = registrations[0].entry.options.inject()
	assert.equal(typeof face.icons.checklist, 'function')
	assert.notEqual(face.icons.checklist, primitives.IconChecklistOutlineRegular)
	// The fallback is a real inline icon: an svg with the shipped path data.
	const rendered = face.icons.checklist({ size: 16 })
	assert.equal(rendered.type, 'svg')
	assert.equal(rendered.props.viewBox, '0 0 16 16')
	assert.ok(rendered.props.children.length > 0)
})

test('a primitives table without Tooltip still renders a working entry button', () => {
	const bundle = loadBundle()
	const primitives = makePrimitives([])
	delete primitives.Tooltip
	const { exports } = bundle.instantiate(primitives, makeReact())
	const { ctx, registrations } = makeCtx({ sessions: makeSessions() })
	exports.apply(ctx)
	const face = registrations[0].entry.options.inject()
	const button = face.tip('tip text', { type: 'button' })
	assert.equal(button.type, 'button', 'the tooltip wrapper is skipped, the button is not')
})

test('store setArchived adds and removes ids, and nothing else', () => {
	const world = mount()
	const store = world.face.hooks.store

	assert.deepEqual(store.getSnapshot().archivedIds, [], 'nothing is archived to begin with')
	store.actions.setArchived(['a', 'b'], true)
	assert.deepEqual([...store.getSnapshot().archivedIds].sort(), ['a', 'b'])
	store.actions.setArchived(['b'], false)
	assert.deepEqual([...store.getSnapshot().archivedIds], ['a'])
	// The pin mark has no local fallback (it is either a real pin or nothing), so
	// the plugin store holds: the fallback archive mark, the mode preference, the
	// grouping preference, and the proof flag.
	assert.deepEqual(Object.keys(store.getSnapshot()).sort(), ['archivedIds', 'groupByWorkspace', 'inlineProven', 'mode', 'pinnedIds'])
	assert.deepEqual(store.getSnapshot().pinnedIds, [], 'pinning never writes a private mark')
})

test('the store remembers which mode the entry button drives', () => {
	const world = mount()
	const store = world.face.hooks.store
	assert.equal(store.getSnapshot().mode, 'inline', 'inline ticks are the default')
	store.actions.setMode('panel')
	assert.equal(store.getSnapshot().mode, 'panel')
	store.actions.setMode('inline')
	assert.equal(store.getSnapshot().mode, 'inline')
	// Exactly two modes: anything else is inline, so the field cannot drift.
	store.actions.setMode('nonsense')
	assert.equal(store.getSnapshot().mode, 'inline')
})

test('deleteSessions reports per-session failures without aborting the batch', async () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'A', updatedAt: 3 },
			{ sessionId: 'b', title: 'B', updatedAt: 2 }
		]
	})
	const result = await world.face.actions.deleteSessions(['a', 'missing', 'b'])
	assert.equal(result.ok, 2)
	assert.equal(result.failed.length, 1)
	assert.equal(result.failed[0].id, 'missing')
	assert.match(result.failed[0].reason, /session\/not-found/u)
	assert.deepEqual(world.sessions.calls.deleted, ['a', 'missing', 'b'])
})

test('the entry renders closed, and opening it reveals the panel', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30 },
			{ sessionId: 'blank', blank: true, updatedAt: 20 }
		]
	})
	const closed = world.renderEntry()
	const [wrapper, modal] = closed.props.children
	assert.equal(wrapper.type, world.primitives.Tooltip, 'the footer entry is tooltipped')
	assert.equal(modal.type, world.primitives.Modal)
	assert.equal(modal.props.open, false, 'the modal starts closed')
	assert.equal(modal.props.children, null, 'a closed modal renders no panel body')

	const open = world.openAndRender()
	const openModal = open.props.children[1]
	assert.equal(openModal.props.open, true)
	assert.equal(openModal.props.title, 'panel.title')
	assert.ok(openModal.props.children !== null, 'an open modal renders the panel body')
	// The panel sits inside the error boundary: a render crash then shows as a
	// message in the dialog instead of unmounting the button that opened it.
	const boundary = openModal.props.children
	assert.equal(boundary.type, world.exports.PanelBoundary, 'the panel is wrapped in the error boundary')
	assert.equal(boundary.props.children.type, world.exports.MultiSelectPanel, 'and the boundary holds the panel')
	assert.equal(typeof boundary.props.format, 'function', 'the boundary can phrase the failure')
})

test('a crashed panel reports the reason instead of unmounting the view', () => {
	const world = mount()
	const Boundary = world.exports.PanelBoundary
	const healthy = new Boundary({ format: (reason) => `failed: ${reason}`, children: null })
	assert.equal(healthy.render(), null, 'a healthy boundary renders its children')
	healthy.state = { error: new Error('boom') }
	const fallback = healthy.render()
	assert.equal(fallback.props['data-tone'], 'error', 'the fallback reads as an error')
	assert.match(fallback.props.children, /failed: boom/u, 'and it carries the reason')
})

/**
 * The panel's list element, plus readers for the two kinds of child it paints.
 *
 * Grouping interleaves workspace headings with rows, so a test that wants rows
 * has to ask for rows: positional indexing into the child array would silently
 * start reading headings after a layout change like that one.
 */
function listOf(body) {
	return body.props.children[1]
}

/** The list's children as an array; the empty state is a single element. */
function listChildren(body) {
	const children = listOf(body).props.children
	return Array.isArray(children) ? children : []
}

function listRows(body) {
	return listChildren(body).filter((node) => node.props.className === 'dsh-msel-row')
}

function listGroups(body) {
	return listChildren(body).filter((node) => node.props.className === 'dsh-msel-group')
}

/** The conversation title a rendered row shows. */
function rowTitle(row) {
	return row.props.children[1].props.children[0].props.children
}

test('both session-list snapshot shapes list the same sessions', () => {
	const rowsOf = (shape) => {
		const world = mount({
			shape,
			items: [
				{ sessionId: 'a', title: 'Alpha', updatedAt: 30, cwd: 'D:\\x' },
				{ sessionId: 'b', blank: true, updatedAt: 20 },
				{ sessionId: 'c', title: 'Gamma', updatedAt: 10 }
			]
		})
		return listRows(world.renderPanelBody()).map(rowTitle)
	}
	const normalized = rowsOf('normalized')
	// The controller hands the UI `{ ids, byId }`; reading only a flattened
	// `items` array is how the panel ends up listing nothing at all.
	assert.deepEqual(normalized, ['Alpha', 'Gamma'], 'the controller鈥檚 { ids, byId } snapshot lists sessions')
	assert.deepEqual(rowsOf('items'), normalized, 'and so does the flattened projection')
})

test('selecting one row selects exactly that row, not every row', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30, cwd: 'D:\\x' },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20 },
			{ sessionId: 'c', title: 'Gamma', updatedAt: 10 }
		]
	})
	const rows = listRows(world.renderPanelBody())
	// Drive the row the way a user does. Every row used to share one key because
	// the snapshot files sessions under `id` while the panel read `sessionId`,
	// so this single toggle marked all three.
	rows[0].props.onClick({ shiftKey: false, ctrlKey: false, metaKey: false })
	const after = listRows(world.renderPanelBody())
	const selected = after.filter((row) => row.props['aria-selected'] === true)
	assert.equal(selected.length, 1, 'exactly one row is selected')
	assert.equal(rowTitle(selected[0]), 'Alpha')
	assert.equal(after[1].props['aria-selected'], false, 'and the others are not')
})

test('the panel shows localized copy even when no slot provides a translator', () => {
	const helpers = globalThis.__DSH_SESSION_MULTISELECT__
	const english = helpers.makeTranslator({ zh: helpers.dicts.zh, en: helpers.dicts.en, active: () => 'en' })
	const chinese = helpers.makeTranslator({ zh: helpers.dicts.zh, en: helpers.dicts.en, active: () => 'zh' })
	// The header panel used to fall back to the identity function, which put
	// `panel.title` on screen verbatim.
	assert.notEqual(english('panel.title'), 'panel.title')
	assert.equal(chinese('panel.title'), helpers.dicts.zh['panel.title'])
	assert.equal(english('panel.title'), helpers.dicts.en['panel.title'])
	// `{name}` interpolation, and an unknown key surviving as itself.
	assert.match(chinese('count.selected', { n: 2, m: 5 }), /2/u)
	assert.equal(chinese('no.such.key'), 'no.such.key')
})

test('a summary filed under `id` still lists with its title', () => {
	const world = mount({ items: [{ sessionId: 'a', title: 'Alpha', updatedAt: 30 }] })
	const rows = listRows(world.renderPanelBody())
	assert.equal(rows.length, 1, 'the real byId shape lists a row')
	assert.equal(rowTitle(rows[0]), 'Alpha', 'its displayTitle is used')
})

test('the open panel lists one row per selectable session and hides blank ones', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30, cwd: 'D:\\x' },
			{ sessionId: 'blank', blank: true, updatedAt: 20 },
			{ sessionId: 'b', title: 'Beta', updatedAt: 10, running: true }
		]
	})
	const body = world.renderPanelBody()
	const list = listOf(body)
	const rows = listRows(body)
	assert.equal(rows.length, 2, 'blank sessions must not render a row')
	assert.deepEqual(rows.map(rowTitle), ['Alpha', 'Beta'])
	assert.match(rows[0].props.className, /dsh-msel-row/u)
	assert.equal(rows[0].props['aria-selected'], false)
	assert.equal(rows[0].props['data-selected'], 'false')
	assert.equal(list.props.role, 'listbox')
	assert.equal(list.props['aria-multiselectable'], 'true')
})

test('the panel heads every workspace group and selects one with a single click', () => {
	const items = [
		{ sessionId: 'a', title: 'Alpha', updatedAt: 30, cwd: 'D:\\alpha' },
		{ sessionId: 'b', title: 'Beta', updatedAt: 20, cwd: 'D:\\beta' },
		{ sessionId: 'c', title: 'Gamma', updatedAt: 10, cwd: 'D:\\alpha' },
		{ sessionId: 'd', title: 'Delta', updatedAt: 5 }
	]
	const world = mount({ items })
	const body = world.renderPanelBody()
	const groups = listGroups(body)
	assert.equal(groups.length, 3, 'one heading per workspace, plus the unnamed remainder')
	// The workspace whose newest conversation is newest leads; sessions with no
	// workspace trail, so the named headings stay meaningful.
	assert.deepEqual(groups.map((group) => group.props['data-workspace']), ['D:\\alpha', 'D:\\beta', ''])
	// The heading carries the whole path 鈥?two workspaces can share a last segment.
	assert.deepEqual(groups.map((group) => group.props.children[1].props.children), ['D:\\alpha', 'D:\\beta', 'group.noWorkspace'])
	assert.match(groups[1].props.children[0].props['aria-label'], /beta$/u, 'the accessible name stays short and readable')
	assert.deepEqual(listRows(body).map(rowTitle), ['Alpha', 'Gamma', 'Beta', 'Delta'], 'each row stays under its own heading')
	assert.equal(listOf(body).props.children.length, 7, 'headings and rows are interleaved, nothing else paints')

	groups[0].props.onClick()
	const after = listRows(world.renderPanelBody())
	assert.deepEqual(after.map((row) => row.props['aria-selected']), [true, true, false, false], 'one click takes the whole workspace')
	assert.equal(listGroups(world.renderPanelBody())[1].props['data-complete'], 'false', 'an untouched group is not marked complete')
	assert.equal(listGroups(world.renderPanelBody())[0].props['data-complete'], 'true')
})

test('turning grouping off paints one flat recency list', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30, cwd: 'D:\\alpha' },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20, cwd: 'D:\\beta' },
			{ sessionId: 'c', title: 'Gamma', updatedAt: 10, cwd: 'D:\\alpha' }
		]
	})
	const body = world.renderPanelBody()
	const toggle = body.props.children[0].props.children
		.find((node) => Array.isArray(node.props.children) && node.props.children[1] === 'option.group')
	assert.equal(toggle.props.children[0].props.checked, true, 'grouping is the default')
	toggle.props.children[0].props.onChange({ target: { checked: false } })
	const flat = world.renderPanelBody()
	assert.equal(listGroups(flat).length, 0, 'no headings once grouping is off')
	assert.deepEqual(listRows(flat).map(rowTitle), ['Alpha', 'Beta', 'Gamma'], 'and rows fall back to plain recency')
})

test('a selected row updates the count and enables the batch actions', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30 },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20 }
		]
	})
	world.renderPanelBody() // first paint, so the panel's own setters exist
	// Panel hook order: [0] query, [1] showArchived, [2] selection, [3] cursor.
	world.react.setterOf('MultiSelectPanel', 2)((current) => new Set([...current, 'a']))
	const body = world.renderPanelBody()
	const rows = listRows(body)
	assert.equal(rows[0].props['aria-selected'], true, 'the selected row reports selection')
	assert.equal(rows[0].props['data-selected'], 'true')
	assert.equal(rows[1].props['aria-selected'], false)
	const toolbar = body.props.children[0]
	const count = toolbar.props.children[toolbar.props.children.length - 1]
	assert.match(count.props.children, /count\.selected/u)
	assert.match(count.props.children, /"n":1/u)
	const actionRow = body.props.children[3]
	assert.equal(actionRow.props.children[0].props.disabled, false, 'delete is enabled with a selection')
})

test('the panel shows the empty state for an empty list', () => {
	const world = mount()
	const body = world.renderPanelBody()
	const list = listOf(body)
	assert.equal(list.type, 'div', 'the list container is a plain element')
	assert.equal(list.props.children.type, 'div', 'a single empty-state element renders as one child')
	assert.match(list.props.children.props.className, /dsh-msel-empty/u)
	assert.equal(list.props.children.props.children, 'list.empty')
	// With nothing selectable, every batch action stays disabled.
	const actionRow = body.props.children[3]
	for (const button of actionRow.props.children) {
		assert.equal(button.props.disabled, true, 'batch actions stay disabled with no selection')
	}
})

test('select-all selects every visible row and then offers to clear', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30 },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20 }
		]
	})
	world.renderEntry()
	const body = world.renderPanelBody()
	const selectAll = body.props.children[0].props.children[1]
	assert.equal(selectAll.props.children, 'all.select')
	assert.equal(selectAll.props.disabled, false)
	selectAll.props.onClick()
	const next = world.renderPanelBody()
	const rows = listRows(next)
	assert.deepEqual(rows.map((row) => row.props['aria-selected']), [true, true])
	const toolbar = next.props.children[0]
	assert.equal(toolbar.props.children[1].props.children, 'all.clear')
	assert.match(toolbar.props.children[toolbar.props.children.length - 1].props.children, /"n":2/u)
})

test('delete asks for confirmation before touching the service', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30 },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20 }
		]
	})
	world.renderPanelBody() // first paint, so the panel's own setters exist
	world.react.setterOf('MultiSelectPanel', 2)(new Set(['a']))
	const before = world.renderPanelBody()
	assert.equal(before.props.children[2], null, 'no confirmation panel before the click')

	// The delete button only arms the confirmation.
	before.props.children[3].props.children[0].props.onClick()
	const armed = world.renderPanelBody()
	const confirmPanel = armed.props.children[2]
	assert.ok(confirmPanel !== null, 'the confirmation panel appears')
	assert.match(confirmPanel.props.children[0].props.children, /confirm\.delete/u)
	assert.deepEqual(world.sessions.calls.deleted, [], 'nothing is deleted before confirmation')

	// Confirming starts the deletion (the batch runs asynchronously).
	confirmPanel.props.children[1].props.children[0].props.onClick()
	assert.deepEqual(world.sessions.calls.deleted, ['a'])
})

test('the panel offers three actions, and the last two work in both directions', async () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30 },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20 }
		]
	})
	world.renderPanelBody() // first paint, so the panel's own setters exist
	world.react.setterOf('MultiSelectPanel', 2)(new Set(['a', 'b']))
	const body = world.renderPanelBody()
	const actionRow = body.props.children[3]
	assert.deepEqual(actionRow.props.children.map((button) => button.props.children),
		['action.delete', 'action.archive', 'action.pin'], 'delete, archive, pin — nothing else')
	// The toolbar carries the way into the other mode (tooltipped, so the label
	// sits on the button inside the tooltip wrapper).
	const switchButton = body.props.children[0].props.children[3]
	assert.equal(switchButton.props.children.props.children, 'mode.inline',
		'the panel can switch the entry button over to inline ticks')

	// Archiving hides the rows (the panel lists unarchived rows only), and the
	// button flips to the reverse direction for the archived selection.
	actionRow.props.children[1].props.onClick()
	await flush()
	// No workspace service in this mount, so the mark is this plugin's own — and
	// the status line has to say so rather than claim a real archive.
	assert.deepEqual([...world.face.hooks.marks.getSnapshot().archivedIds].sort(), ['a', 'b'])
	assert.equal(world.face.hooks.marks.getSnapshot().real, false)
	assert.equal(listRows(world.renderPanelBody()).length, 0, 'archived rows leave the default list')

	world.react.setterOf('MultiSelectPanel', 1)(true) // "show archived"
	const shown = world.renderPanelBody()
	assert.equal(listRows(shown).length, 2)
	const shownActions = shown.props.children[3]
	assert.equal(shownActions.props.children[1].props.children, 'action.unarchive', 'the button offers the way back')
	assert.equal(shownActions.props.children[1].props.disabled, false, 'the selection is still there')
	shownActions.props.children[1].props.onClick()
	await flush()
	assert.deepEqual([...world.face.hooks.marks.getSnapshot().archivedIds], [])
})

test('archive and pin reach the workspace service when the build has one', async () => {
	const workspaces = makeWorkspaces()
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha', updatedAt: 30 },
			{ sessionId: 'b', title: 'Beta', updatedAt: 20 }
		],
		workspaces
	})
	assert.equal(world.face.hooks.marks.getSnapshot().real, true, 'the panel reads the service’s marks')
	world.renderPanelBody()
	world.react.setterOf('MultiSelectPanel', 2)(new Set(['a', 'b']))
	world.renderPanelBody().props.children[3].props.children[1].props.onClick()
	await flush()
	assert.deepEqual(workspaces.calls.archived, ['a', 'b'], 'archiving goes through archiveSession')
	// The service publishes the new set, so the panel follows DSH's own list.
	assert.deepEqual([...world.face.hooks.marks.getSnapshot().archivedIds].sort(), ['a', 'b'])
	assert.equal(world.face.hooks.marks.getSnapshot().real, true)
	assert.equal(listRows(world.renderPanelBody()).length, 0, 'the archived rows leave the list')

	// The same service answers the pin button, in both directions.
	workspaces.calls.archived.length = 0
	const fresh = mount({
		items: [{ sessionId: 'a', title: 'Alpha', updatedAt: 30 }],
		workspaces: makeWorkspaces()
	})
	fresh.renderPanelBody()
	fresh.react.setterOf('MultiSelectPanel', 2)(new Set(['a']))
	const pinRow = fresh.renderPanelBody().props.children[3]
	assert.equal(pinRow.props.children[2].props.children, 'action.pin')
	pinRow.props.children[2].props.onClick()
	await flush()
	assert.deepEqual(fresh.workspaces.calls.pinned, ['a'], 'pinning goes through pinSession')
	const pinnedRow = fresh.renderPanelBody()
	assert.equal(pinnedRow.props.children[3].props.children[2].props.children, 'action.unpin', 'and the button flips')
	// Row meta: the tags come first, so a pinned row is recognisable even when the
	// pinned group heading is out of view.
	const meta = listRows(pinnedRow)[0].props.children[1].props.children[1]
	assert.equal(meta.props.children[0].props.children, 'row.pinned', 'the row carries the pinned tag')
	pinnedRow.props.children[3].props.children[2].props.onClick()
	await flush()
	assert.deepEqual(fresh.workspaces.calls.unpinned, ['a'])
})

test('a build without a pinning API says so instead of pretending', async () => {
	const world = mount({ items: [{ sessionId: 'a', title: 'Alpha', updatedAt: 30 }] })
	world.renderPanelBody()
	world.react.setterOf('MultiSelectPanel', 2)(new Set(['a']))
	world.renderPanelBody().props.children[3].props.children[2].props.onClick()
	await flush()
	assert.deepEqual(world.face.hooks.marks.getSnapshot().pinnedIds, [], 'nothing was pinned')
	assert.match(world.face.hooks.store.getSnapshot().mode, /inline/u, 'and nothing else changed')
})

test('the entry action follows the stored mode, and both switches move it', () => {
	const world = mount()
	const store = world.face.hooks.store
	const panel = world.face.hooks.panel
	const inline = world.face.hooks.inline

	// Inline is the default, so the entry button turns the ticks on — it does not
	// open a dialog, and pressing it again leaves the mode.
	world.face.actions.entry()
	assert.equal(inline.getSnapshot().active, true, 'the ticks are on')
	assert.equal(panel.getSnapshot().open, false, 'and no dialog was opened')
	world.face.actions.entry()
	assert.equal(inline.getSnapshot().active, false, 'the same button turns them off')

	// The bar's switch: panel mode, and the dialog the entry button now opens.
	world.face.actions.usePanel()
	assert.equal(store.getSnapshot().mode, 'panel')
	assert.equal(panel.getSnapshot().open, true)
	assert.equal(inline.getSnapshot().active, false)
	world.face.actions.entry()
	assert.equal(panel.getSnapshot().open, true, 'in panel mode the entry opens the dialog')
	assert.equal(inline.getSnapshot().active, false, 'and never the ticks')

	// The panel's switch: back to inline ticks, and the dialog closes with them.
	world.face.actions.useInline()
	assert.equal(store.getSnapshot().mode, 'inline')
	assert.equal(panel.getSnapshot().open, false, 'the dialog closes as the ticks take over')
	assert.equal(inline.getSnapshot().active, true)

	// And the one gesture that is always available: right-clicking the entry button
	// asks for whichever mode is NOT current.
	world.face.actions.entryOther()
	assert.equal(store.getSnapshot().mode, 'panel', 'from inline it offers the panel')
	assert.equal(panel.getSnapshot().open, true)
	world.face.actions.entryOther()
	assert.equal(store.getSnapshot().mode, 'inline', 'from the panel it offers the ticks')
	assert.equal(inline.getSnapshot().active, true)
})

test('both entry buttons offer the other mode on right-click', () => {
	const world = mount()
	const calls = []
	const props = {
		...world.props,
		actions: {
			...world.face.actions,
			entry: () => { calls.push('entry') },
			entryOther: () => { calls.push('other') }
		}
	}
	const rightClick = () => {
		const event = { preventDefault() { event.prevented = true } }
		return event
	}
	// The footer view (the fallback entry) …
	const footer = world.react.withHooks('MultiSelectEntry', () => world.exports.MultiSelectEntry(props))
	const footerButton = footer.props.children[0].props.children
	assert.equal(typeof footerButton.props.onContextMenu, 'function', 'the footer button handles right-click')
	const footerEvent = rightClick()
	footerButton.props.onContextMenu(footerEvent)
	assert.deepEqual(calls, ['other'], 'the right-click asks for the other mode')
	assert.equal(footerEvent.prevented, true, 'and the browser’s own menu does not open')

	// … and the injected header button do the same thing.
	const inlineView = world.react.withHooks('InlineEntry', () => world.exports.InlineEntry(props))
	const inlineButton = inlineView.props.children[0].props.children
	inlineButton.props.onContextMenu(rightClick())
	assert.deepEqual(calls, ['other', 'other'], 'the header button offers it too')
})

test('the inline bar carries the count, all three actions, and the way back', () => {
	const world = mount()
	const hooks = world.face.hooks
	const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)
	const calls = []
	const handlers = {
		onToggleAll: () => { calls.push('all') },
		onDelete: () => { calls.push('delete') },
		onCancel: () => { calls.push('cancel') },
		onConfirm: () => { calls.push('confirm') },
		onArchive: () => { calls.push('archive') },
		onPin: () => { calls.push('pin') },
		onPanel: () => { calls.push('panel') },
		onExit: () => { calls.push('exit') }
	}
	const bar = () => world.exports.InlineBar({ t, hooks, handlers })

	// Nothing ticked: the bar says so, and every batch action is inert.
	const empty = bar()
	assert.equal(empty.props.children[0].props.children[0].props.children, 'bar.selected{"n":0}')
	assert.deepEqual(empty.props.children[2].props.children.map((button) => button.props.children),
		['action.delete', 'action.archive', 'action.pin'], 'the same three actions as the panel')
	assert.equal(empty.props.children[2].props.children.every((button) => button.props.disabled), true,
		'they wait for a selection')
	// The top line still works with nothing ticked: the mode switch and the exit.
	empty.props.children[0].props.children[2].props.onClick()
	empty.props.children[0].props.children[3].props.onClick()
	assert.deepEqual(calls, ['panel', 'exit'])

	// Two ticked, one of them pinned: the pin button reads as its own reverse.
	hooks.pick.set({ ids: ['a', 'b'] })
	hooks.marks.set({ pinnedIds: ['a'], archivedIds: [], real: true })
	const mixed = bar()
	assert.equal(mixed.props.children[0].props.children[0].props.children, 'bar.selected{"n":2}')
	const actions = mixed.props.children[2].props.children
	assert.deepEqual(actions.map((button) => button.props.children), ['action.delete', 'action.archive', 'action.pin'])
	assert.equal(actions.every((button) => button.props.disabled), false, 'a selection enables them')

	// Both ticked and both pinned: one button, the other direction — the same rule
	// the archive button follows.
	hooks.pick.set({ ids: ['a', 'b'] })
	hooks.marks.set({ pinnedIds: ['a', 'b'], archivedIds: ['a', 'b'], real: true })
	const all = bar()
	assert.deepEqual(all.props.children[2].props.children.map((button) => button.props.children),
		['action.delete', 'action.unarchive', 'action.unpin'])
	all.props.children[2].props.children[1].props.onClick()
	all.props.children[2].props.children[2].props.onClick()
	assert.deepEqual(calls.slice(2), ['archive', 'pin'], 'the bar drives the same batch actions as the panel')

	// The confirmation replaces the action line and says what it will destroy.
	hooks.inline.set({ active: true, busy: false, confirming: true, status: null })
	const confirming = bar()
	assert.match(confirming.props.children[1].props.children[0].props.children, /confirm\.delete/u)
	assert.deepEqual(confirming.props.children[2].props.children.map((button) => button.props.children),
		['confirm.yes', 'confirm.no'])
	confirming.props.children[2].props.children[0].props.onClick()
	assert.equal(calls.at(-1), 'confirm')

	// A report from a finished batch lands in the bar, and Esc-state is readable.
	hooks.inline.set({ active: true, busy: false, confirming: false, status: { text: 'status.pinned{"n":2}', tone: 'info' } })
	assert.equal(bar().props.children[4].props.children, 'status.pinned{"n":2}')
	hooks.inline.set({ active: true, busy: true, confirming: false, status: null })
	assert.equal(bar().props.children[3].props.children, 'busy.working')
})

test('the official settings offer both modes, and the plugin card names the one in force', () => {
	const world = mount()
	const general = world.registrationFor('settings.general.item')
	const page = world.registrationFor('plugins.item')
	assert.ok(general !== undefined, 'the General tab row is registered')
	assert.ok(page !== undefined, 'the Plugins page entry is registered')
	assert.equal(general.entry.options.name, 'settings.general.item')
	assert.equal(general.entry.options.id, 'session-multiselect-mode')
	assert.equal(page.entry.options.name, 'plugins.item')
	assert.equal(page.entry.options.id, 'session-multiselect')
	assert.equal(page.entry.options.locale, 'sessionMultiselect', 'the pages read this bundle’s dictionary')
	assert.equal(typeof page.entry.options.label, 'function', 'the Plugins card takes its label from the plugin')
	// The card's title is translated, so a build that switches language shows it in
	// that language rather than as a raw key.
	assert.equal(page.entry.options.label(), world.dictionaries.get('sessionMultiselect').zh['settings.cardTitle'])

	const t = (key) => key
	const face = page.entry.options.inject()
	const summaryOf = () => world.react.withHooks('SessionModeSettings', () => world.exports.SessionModeSettings({ t, view: 'summary', ...face }))
	const bodyOf = () => world.react.withHooks('SessionModeSettings', () => world.exports.SessionModeSettings({ t, view: 'page', ...face }))
	/** Render the mode choices out of whichever surface holds them. */
	const choicesOf = (element) => {
		const choices = (element.props.children ?? []).find((child) => child !== null && child !== undefined && child.type === world.exports.ModeChoices)
		assert.ok(choices !== undefined, 'the surface carries the mode choices')
		return world.react.withHooks('ModeChoices', () => choices.type(choices.props))
	}
	const labelsOf = (choices) => choices.props.children.map((button) => button.props.children[0].props.children)
	const marksOf = (choices) => choices.props.children.map((button) => button.props['data-active'])
	const pick = (choices, index) => { choices.props.children[index].props.onClick() }

	// The card's one-liner states the mode in force; the page carries the choice.
	assert.equal(summaryOf(), 'settings.summary.inline')
	assert.deepEqual(labelsOf(choicesOf(bodyOf())), ['mode.inline', 'mode.panel'])
	assert.deepEqual(marksOf(choicesOf(bodyOf())), ['true', 'false'])

	// Picking the other one writes the same preference the entry button reads.
	pick(choicesOf(bodyOf()), 1)
	assert.equal(world.face.hooks.store.getSnapshot().mode, 'panel')
	assert.deepEqual(marksOf(choicesOf(bodyOf())), ['false', 'true'])
	assert.equal(summaryOf(), 'settings.summary.panel')

	// The General row shows and sets exactly the same thing.
	const row = world.react.withHooks('SessionModeRow', () => world.exports.SessionModeRow({ t, ...general.entry.options.inject() }))
	assert.equal(row.props.children[0].props.children, 'settings.title')
	assert.deepEqual(marksOf(choicesOf(row)), ['false', 'true'])
	pick(choicesOf(row), 0)
	assert.equal(world.face.hooks.store.getSnapshot().mode, 'inline', 'and back again')
})

test('choosing the panel in settings takes the ticks down with the mode', () => {
	const world = mount()
	world.face.actions.entry()
	assert.equal(world.face.hooks.inline.getSnapshot().active, true, 'the ticks are up')
	const general = world.registrationFor('settings.general.item')
	const t = (key) => key
	const row = world.react.withHooks('SessionModeRow', () => world.exports.SessionModeRow({ t, ...general.entry.options.inject() }))
	const choices = row.props.children.find((child) => child !== null && child !== undefined && child.type === world.exports.ModeChoices)
	world.react.withHooks('ModeChoices', () => choices.type(choices.props)).props.children[1].props.onClick()
	assert.equal(world.face.hooks.store.getSnapshot().mode, 'panel')
	assert.equal(world.face.hooks.inline.getSnapshot().active, false, 'a mode does not leave its own UI behind')
})

test('searching filters the rows and reports an empty result', () => {
	const world = mount({
		items: [
			{ sessionId: 'a', title: 'Alpha work', updatedAt: 30 },
			{ sessionId: 'b', title: 'Beta work', updatedAt: 20 }
		]
	})
	world.renderEntry()
	world.renderPanelBody()
	// Panel hook order: [0] query.
	world.react.setterOf('MultiSelectPanel', 0)('beta')
	const body = world.renderPanelBody()
	const rows = listRows(body)
	assert.equal(rows.length, 1)
	assert.equal(rowTitle(rows[0]), 'Beta work')

	world.react.setterOf('MultiSelectPanel', 0)('nothing matches this')
	const empty = world.renderPanelBody()
	assert.equal(listOf(empty).props.children.props.children, 'list.emptyFiltered')
})
