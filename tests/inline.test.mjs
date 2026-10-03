/**
 * Tests for the session-list header injection.
 *
 * The target toolbar belongs to another plugin, so this code is the one part of
 * the bundle that must survive an unfamiliar DOM. These tests pin the behaviors
 * that make that safe: placement before the search control, idempotence across
 * re-renders, a harmless `false` when the target is missing, and teardown.
 *
 * Run: node --test tests/inline.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

// --- minimal DOM stand-in ---------------------------------------------------

/** Create an element stand-in carrying only what the injection code touches. */
function makeElement(tag, attrs = {}) {
	const element = {
		tagName: tag.toUpperCase(),
		attributes: { ...attrs },
		children: [],
		parentElement: null,
		style: {},
		dataset: {},
		// Layout stand-in: a zero box unless a test hands this element a real one.
		box: null,
		getBoundingClientRect() {
			return element.box ?? { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }
		},
		get classList() {
			const read = () => (element.attributes.class ?? '').split(' ').filter(Boolean)
			return {
				contains: (name) => read().includes(name),
				add: (name) => { if (!read().includes(name)) element.attributes.class = [...read(), name].join(' ') },
				remove: (name) => { element.attributes.class = read().filter((entry) => entry !== name).join(' ') }
			}
		},
		setAttribute(name, value) { element.attributes[name] = String(value) },
		getAttribute(name) { return element.attributes[name] ?? null },
		removeAttribute(name) { delete element.attributes[name] },
		get firstChild() { return element.children[0] ?? null },
		get firstElementChild() { return element.children[0] ?? null },
		closest(selector) {
			for (let node = element; node !== null; node = node.parentElement) {
				if (matches(node, selector)) return node
			}
			return null
		},
		appendChild(child) {
			child.parentElement = element
			element.children.push(child)
			return child
		},
		insertBefore(child, anchor) {
			// Real DOM semantics: a node that is already in the tree is moved, not
			// duplicated — the re-assert pass relies on exactly that.
			child.remove()
			const index = element.children.indexOf(anchor)
			child.parentElement = element
			if (index === -1) element.children.push(child)
			else element.children.splice(index, 0, child)
			return child
		},
		remove() {
			if (element.parentElement === null) return
			const siblings = element.parentElement.children
			const index = siblings.indexOf(element)
			if (index !== -1) siblings.splice(index, 1)
			element.parentElement = null
		},
		contains(node) {
			if (node === element) return true
			return element.children.some((child) => child.contains?.(node) === true)
		},
		get nextSibling() {
			if (element.parentElement === null) return null
			const siblings = element.parentElement.children
			return siblings[siblings.indexOf(element) + 1] ?? null
		},
		querySelectorAll(selector) {
			const found = []
			// Descendants of a node are its direct children plus each child's own
			// descendants, so the walk recurses into EVERY child — matching only
			// is not enough to reach deeper nodes.
			const visit = (node) => {
				for (const child of node.children) {
					if (matches(child, selector)) found.push(child)
					visit(child)
				}
			}
			visit(element)
			return found
		},
		querySelector(selector) {
			return element.querySelectorAll(selector)[0] ?? null
		},
	}
	return element
}

/** Minimal selector support: tag, [attr], [attr="v"], tag[attr="v"], tag[attr*="v"], tag[attr^="v"]. */
function matches(element, selector) {
	const attrEquals = /^([a-zA-Z]*)\[([\w-]+)=("?)(.*?)\3\]$/u.exec(selector)
	if (attrEquals !== null) {
		const [, tag, name, , value] = attrEquals
		if (tag !== '' && element.tagName !== tag.toUpperCase()) return false
		return element.getAttribute(name) === value
	}
	const attrPresent = /^([a-zA-Z]*)\[([\w-]+)\]$/u.exec(selector)
	if (attrPresent !== null) {
		const [, tag, name] = attrPresent
		if (tag !== '' && element.tagName !== tag.toUpperCase()) return false
		return element.getAttribute(name) !== null
	}
	const attrContains = /^([a-zA-Z]*)\[([\w-]+)\*=("?)(.*?)\3\]$/u.exec(selector)
	if (attrContains !== null) {
		const [, tag, name, , value] = attrContains
		if (tag !== '' && element.tagName !== tag.toUpperCase()) return false
		return (element.getAttribute(name) ?? '').includes(value)
	}
	// The session rows are located by the prefix of their data-row-key.
	const attrPrefix = /^([a-zA-Z]*)\[([\w-]+)\^=("?)(.*?)\3\]$/u.exec(selector)
	if (attrPrefix !== null) {
		const [, tag, name, , value] = attrPrefix
		if (tag !== '' && element.tagName !== tag.toUpperCase()) return false
		return (element.getAttribute(name) ?? '').startsWith(value)
	}
	return element.tagName === selector.toUpperCase()
}

/**
 * Install a fresh document stand-in and record created elements for assertions.
 * @param options - optional `layout` hook; elements this plugin creates report
 * their boxes through it, which is how the placement measurement is exercised.
 */
function installDocument({ layout } = {}) {
	const created = []
	const listeners = []
	const body = makeElement('body')
	const head = makeElement('head')
	const documentStub = {
		body,
		head,
		createElement(tag) {
			const element = makeElement(tag)
			if (layout !== undefined) element.getBoundingClientRect = () => layout.rectOf(element)
			created.push(element)
			return element
		},
		querySelector: (selector) => body.querySelector(selector),
		querySelectorAll: (selector) => body.querySelectorAll(selector),
		// The plugin's document-level click trigger needs a real listener
		// registry: whether it fires, and in which phase, is the behaviour under
		// test here.
		addEventListener(type, fn, capture) { listeners.push({ type, fn, capture }) },
		removeEventListener(type, fn, capture) {
			const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === capture)
			if (index !== -1) listeners.splice(index, 1)
		}
	}
	// Replacing the global outright (rather than mutating it) is what keeps one
	// test's injected host out of the next test's document.
	globalThis.document = documentStub
	return {
		body,
		head,
		created,
		document: documentStub,
		listeners,
		/** Deliver an event the way the browser would, to every listener. */
		fire(type, target, point = {}, extra = {}) {
			// The event carries what the handlers actually use: the phase controls
			// (a row click is consumed) and the modifier keys (Shift sweeps a range).
			const event = {
				type,
				target,
				clientX: point.x ?? 0,
				clientY: point.y ?? 0,
				key: extra.key,
				shiftKey: extra.shiftKey === true,
				ctrlKey: extra.ctrlKey === true,
				metaKey: extra.metaKey === true,
				defaultPrevented: false,
				propagationStopped: false,
				preventDefault() { event.defaultPrevented = true },
				stopPropagation() { event.propagationStopped = true }
			}
			for (const entry of [...listeners]) {
				if (entry.type === type) entry.fn(event)
			}
			return event
		},
		fireClick(target, point, extra) {
			return this.fire('click', target, point, extra)
		}
	}
}

/** session-storage stand-in, so the diagnostic ring can be read back. */
function installSessionStorage() {
	const map = new Map()
	globalThis.sessionStorage = {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => { map.set(key, String(value)) },
		removeItem: (key) => { map.delete(key) }
	}
	return {
		/** Every note the bundle wrote, oldest first. */
		trail() {
			const raw = map.get('dsh.session.multiselect.diag')
			return raw === undefined ? [] : JSON.parse(raw)
		}
	}
}

/** Minimal snapshot store: the shape `createSnapshotStore` returns. */
function makePanelStore(init = { open: false }) {
	let state = init
	const listeners = new Set()
	return {
		getSnapshot: () => state,
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
		set(next) { state = next; for (const fn of [...listeners]) fn() }
	}
}

/** Fake Cordis client context; `disposes` collects the effect teardowns. */
function makeApplyCtx({ disposes } = {}) {
	return {
		effect(fn, label) {
			const dispose = fn()
			if (disposes !== undefined) disposes.push({ label, dispose })
			return () => {}
		},
		locale: { register: () => () => {}, subscribe: () => () => {} },
		slots: { inject: () => () => {}, register: (options, component) => ({ options, component }) },
		sessions: {
			list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} },
			get: () => ({
				open: async () => {},
				loadOlder: async () => {},
				getSnapshot: () => ({ hasMore: false }),
				events: { entries: () => [] },
				prompt: async () => ({ ok: true })
			}),
			delete: async () => {},
			fork: async () => {},
			create: async () => 'x',
			open: () => {}
		}
	}
}

/** Build the session-list header as the workspace plugin renders it. */
function makeHeader() {
	const header = makeElement('div', { class: 'header' })
	const label = makeElement('span', { class: 'sectionLabel' })
	const searchSlot = makeElement('div', { class: 'searchSlot' })
	const search = makeElement('div', { class: 'search' })
	const tooltip = makeElement('span', { class: 'tooltipWrap' })
	const searchButton = makeElement('button', { 'aria-label': '搜索会话', class: 'bhn1Oq_searchButton' })
	const input = makeElement('input', { class: 'bhn1Oq_searchInput' })
	tooltip.appendChild(searchButton)
	search.appendChild(tooltip)
	search.appendChild(input)
	searchSlot.appendChild(search)
	const actions = makeElement('div', { class: 'headerActions' })
	header.appendChild(label)
	header.appendChild(searchSlot)
	header.appendChild(actions)
	return { header, searchSlot, search, tooltip, searchButton, actions }
}

/**
 * Minimal layout for the header line.
 *
 * The elements report the boxes a real flex row would give them, and the host's
 * box follows whatever its `style.right` currently resolves to, so the placement
 * correction runs end to end. `base` is the px value `100%` resolves to: the
 * search line's own width normally, or a bigger number when a transformed
 * ancestor — as themes add — hijacks the containing block.
 * @param options - `base`, `hostWidth`, and the spacing DSH's own icons get.
 * @returns the layout hook, carrying the boxes the assertions compare.
 */
function installLayout({ base = 28, hostWidth = 28, nativeGap = 4 } = {}) {
	const slotLeft = 72
	const slotRight = slotLeft + 28
	const box = (left, right) => ({ left, right, top: 4, bottom: 32, width: right - left, height: 28 })
	/** The px `right` currently resolves to, as a browser would report it. */
	const usedRight = (element) => {
		const raw = element.style.right ?? ''
		const calc = /^calc\(100% \+ (-?[\d.]+)px\)$/u.exec(raw)
		if (calc !== null) return base + Number.parseFloat(calc[1])
		const plain = /^(-?[\d.]+)px$/u.exec(raw)
		return plain === null ? base : Number.parseFloat(plain[1])
	}
	return {
		slot: box(slotLeft, slotRight),
		magnifier: box(slotLeft, slotLeft + 28),
		next: box(slotLeft + 28 + nativeGap, slotLeft + 56 + nativeGap),
		usedRight,
		rectOf(element) {
			// The host is recognised by the marker attribute the bundle sets on it.
			if (element.getAttribute?.('data-dsh-msel-host') === 'session-multiselect') {
				const right = slotRight - usedRight(element)
				return box(right - hostWidth, right)
			}
			return element.box ?? box(0, 0)
		},
		computedStyle(element) {
			return { columnGap: `${nativeGap}px`, right: `${usedRight(element)}px` }
		}
	}
}

/**
 * Build the session list the way `dsh-client-ui-workspace` renders it.
 *
 * The header the entry button hangs on and the rows inline mode ticks live in
 * one container, and each row carries the shell's own `data-row-key` — the only
 * stable handle on a session row (class names are build-hashed).
 * @param ids - session ids, in paint order.
 */
function makeSessionList(ids = ['a', 'b', 'c']) {
	const root = makeElement('div', { class: 'bhn1Oq_root' })
	const parts = makeHeader()
	root.appendChild(parts.header)
	const rows = ids.map((id, index) => {
		const row = makeElement('div', { 'data-row-key': `session:${id}`, role: 'treeitem', class: 'sessionRow' })
		row.appendChild(makeElement('span', { class: 'slot' }))
		const title = makeElement('span', { class: 'title' })
		title.textContent = `会话 ${String(index + 1)}`
		row.appendChild(title)
		// The row's own actions menu: a button that must keep working in this mode.
		const menu = makeElement('button', { class: 'rowMenu', 'aria-label': '更多' })
		row.appendChild(menu)
		root.appendChild(row)
		return { row, title, menu, id }
	})
	return { root, rows, parts }
}

/** Give the header stub the boxes and the second icon a real layout would. */function wireHeaderLayout(ui, layout) {
	const action = makeElement('button', { 'aria-label': '新建会话' })
	action.box = layout.next
	ui.actions.appendChild(action)
	ui.searchSlot.box = layout.slot
	ui.search.box = layout.slot
	ui.searchButton.box = layout.magnifier
	return action
}

// --- bundle loading with a DOM and react-dom stub ---------------------------

/** Load the bundle with a fake module table; returns the bundle exports. */
function loadBundle({ reactDom, layout } = {}) {
	const source = readFileSync(bundlePath, 'utf8')
	let registration
	const window = {
		__ModuleLoader__: { load: (value) => { registration = value } },
		requestAnimationFrame: (fn) => { fn(); return 1 },
		cancelAnimationFrame: () => {}
	}
	// The placement code measures the live row through the window it finds.
	if (layout !== undefined) window.getComputedStyle = (element) => layout.computedStyle(element)
	globalThis.window = window
	// eslint-disable-next-line no-new-func -- the bundle is CJS-formatted browser code
	new Function('window', 'globalThis', source)(window, globalThis)

	const FRAGMENT = Symbol('Fragment')
	const react = {
		useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
		useRef: (init) => ({ current: init }),
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useEffect: () => {},
		useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
		// The panel's error boundary is a class component.
		Component: class Component {
			constructor(props) { this.props = props; this.state = {} }
			setState(next) { this.state = { ...this.state, ...next } }
		},
		Fragment: FRAGMENT
	}
	const stub = reactDom ?? { default: { createRoot: makeRootFactory() }, createRoot: makeRootFactory() }
	const table = new Map([
		['@deepseek-ai/dsh-client-store', {
			defineStore: (decl) => ({
				spec: decl,
				create: () => {
					// Every declared mutator exists, so the entry can call the ones it
					// needs (marking the injected button as proven) without guarding.
					const actions = {}
					for (const key of Object.keys(decl.actions ?? {})) actions[key] = () => {}
					return {
						getSnapshot: () => decl.init(),
						subscribe: () => () => {},
						actions,
						store: {}
					}
				}
			}),
			createSnapshotStore: (init) => {
				let state = init
				const listeners = new Set()
				return {
					getSnapshot: () => state,
					subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
					set(next) { state = next; for (const fn of [...listeners]) fn() }
				}
			}
		}],
		['@deepseek-ai/dsh-client-ui-primitives', new Proxy({}, { get: () => () => null })],
		['react', react],
		['react-dom/client', stub],
		['react/jsx-runtime', {
			jsx: (type, props) => ({ type, props: { ...props } }),
			jsxs: (type, props) => ({ type, props: { ...props } }),
			Fragment: FRAGMENT
		}]
	])
	return registration.factory((spec) => {
		if (!table.has(spec)) throw new Error(`unexpected require(${spec})`)
		return table.get(spec)
	})
}

/** react-dom/client stub recording every (host, element) render. */
function makeRootFactory() {
	const rendered = []
	return {
		rendered,
		createRoot(host) {
			return {
				render(element) { rendered.push({ host, element }) },
				unmount() { rendered.push({ host, element: null }) }
			}
		}
	}
}

// --- tests ------------------------------------------------------------------

test('places the button left of the control without joining its flex row', () => {
	installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()

	const placed = exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })
	assert.equal(placed, true)

	const host = exports.existingHost()
	assert.ok(host !== null, 'a host element is attached')
	// The control is `width:100%` + `overflow:hidden`; the line above it only
	// budgets 28px for the search slot. A button that JOINED that flex row would
	// push the magnifier sideways, so the host is absolutely positioned inside
	// the line instead and costs the row no space at all.
	assert.equal(host.parentElement, ui.searchSlot, 'the host lives on the control’s line')
	assert.equal(host.nextSibling, ui.search, 'the host precedes the control in document order')
	assert.equal(host.style.position, "absolute", 'the host is out of flow')
	// Hung a full button-gap left of the control's edge. The 4px is the row's own
	// spacing, and alignInlineHost re-measures it against the live row whenever
	// the environment reports boxes (see the spacing tests below).
	assert.equal(host.style.right, "calc(100% + 4px)", 'the host clears the magnifier by one gap')
	assert.equal(host.style.top, "50%", 'vertically centred on the line')
	assert.equal(host.style.transform, "translateY(-50%)")
	// The line itself needs a positioning context and must not clip the button.
	assert.equal(ui.searchSlot.style.position, "relative")
	assert.equal(ui.searchSlot.style.overflow, "visible")
	assert.equal(ui.searchSlot.getAttribute("data-dsh-msel-host-row"), "session-multiselect")
})

test('the magnifier stays exactly where DSH put it', () => {
	installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()
	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })

	const host = exports.existingHost()
	assert.ok(host !== null)
	// Regression guard for the reported bug: the icon must remain the control's
	// first item, the control must keep exactly its own two children, and the
	// injected host must not be a child of the control.
	assert.equal(ui.tooltip.children[0], ui.searchButton, 'the magnifier keeps its place in the row')
	assert.equal(ui.search.children.length, 2, 'the control still holds exactly the icon row and the input')
	assert.equal(ui.search.contains(host), false, 'the host is never inside the control')
	assert.equal(host.contains(ui.searchButton), false, 'the host never contains the icon')
	// The control is a flex item that ignores the out-of-flow host entirely.
	assert.equal(ui.searchSlot.children.includes(ui.search), true, 'the control stays mounted on the line')
	assert.equal(ui.searchSlot.children.includes(host), true, 'the host is mounted as a sibling of the control')
})

test('copies the spacing the row gives DSH’s own icons', () => {
	// The row's spacing is 6px here, not this build's 4px: the number must be read
	// off the rendered line, or the injected button would sit out of step with the
	// buttons beside it.
	const layout = installLayout({ nativeGap: 6 })
	installDocument({ layout })
	const ui = makeHeader()
	wireHeaderLayout(ui, layout)
	document.body.appendChild(ui.header)
	const exports = loadBundle({ layout })

	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })

	const host = exports.existingHost()
	assert.ok(host !== null)
	assert.equal(host.style.right, 'calc(100% + 6px)', 'the host is hung the row’s own spacing away')
	// The property the user sees: both gaps in the run of four buttons match.
	const nativeGap = layout.next.left - layout.magnifier.right
	assert.equal(nativeGap, 6, 'the stub really does space the native icons by 6px')
	assert.equal(layout.magnifier.left - layout.rectOf(host).right, nativeGap, 'the injected button keeps that spacing')
})

test('measures past a hijacked containing block instead of trusting the percentage', () => {
	// Themes animate these headers, and a `transform` on an ancestor silently
	// becomes the containing block of an absolutely positioned element — so `100%`
	// stops meaning "the search line's width". The measurement must win.
	const layout = installLayout({ base: 260 })
	installDocument({ layout })
	const ui = makeHeader()
	wireHeaderLayout(ui, layout)
	document.body.appendChild(ui.header)
	const exports = loadBundle({ layout })

	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })

	const host = exports.existingHost()
	assert.ok(host !== null)
	// The estimate resolved to 260px and would have thrown the button far off; the
	// corrected value is the real distance from the line's right edge.
	assert.equal(host.style.right, '32px', 'the estimate is replaced by a measured offset')
	assert.equal(layout.magnifier.left - layout.rectOf(host).right, 4, 'and the rendered spacing is right')
})

test('repeated placement reuses one host and never duplicates it', () => {
	installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()

	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })
	const first = exports.existingHost()
	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })
	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })
	assert.equal(exports.existingHost(), first, 'the same host element is reused')
	assert.equal(document.body.querySelectorAll('[data-dsh-msel-host]').length, 1, 'no duplicate host is created')

	// A layout shift that keeps the anchor in the tree: the host must be reused
	// and moved back, not re-created.
	ui.tooltip.appendChild(ui.searchButton)
	const afterShift = exports.existingHost()
	assert.equal(afterShift, first, 'the host survives a sibling reshuffle')
	assert.equal(document.body.querySelectorAll('[data-dsh-msel-host]').length, 1)
})

test('re-asserts placement when the header re-renders a fresh control', () => {
	installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()

	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })
	const first = exports.existingHost()
	assert.equal(first?.nextSibling, ui.search, 'placed ahead of the original control')

	// Simulate the workspace plugin swapping the control: the old node leaves the
	// document. The host is a sibling of the control, not part of its subtree, so
	// it survives the swap — but its position must be re-asserted.
	const replacementTooltip = makeElement('span', { class: 'tooltipWrap' })
	const replacementButton = makeElement('button', { 'aria-label': '搜索会话', class: 'bhn1Oq_searchButton' })
	replacementTooltip.appendChild(replacementButton)
	const replacementSearch = makeElement('div', { class: 'search' })
	replacementSearch.appendChild(replacementTooltip)
	replacementSearch.appendChild(makeElement('input', { class: 'bhn1Oq_searchInput' }))
	ui.searchSlot.insertBefore(replacementSearch, ui.search)
	ui.search.remove()

	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })
	const after = exports.existingHost()
	assert.equal(after, first, 'the surviving host element is reused, never duplicated')
	assert.equal(after.parentElement, ui.searchSlot, 'the host stays on the header line')
	assert.equal(after.nextSibling, replacementSearch, 'the host is re-positioned ahead of the new control')
	assert.equal(replacementSearch.contains(after), false, 'the host stays outside the control')
	assert.equal(document.body.querySelectorAll('[data-dsh-msel-host]').length, 1, 'exactly one host exists')
})

test('falls back harmlessly when the session list is absent', () => {
	installDocument()
	document.body.appendChild(makeElement('div'))
	const exports = loadBundle()
	assert.equal(exports.findSearchButton(), null)
	assert.equal(exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} }), false)
	assert.equal(exports.existingHost(), null, 'nothing is injected without a target')
})

test('locates the search button by accessible name and by class prefix', () => {
	installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()
	assert.equal(exports.findSearchButton(), ui.searchButton)

	// Class-prefix fallback covers a localized or renamed accessible name.
	ui.searchButton.setAttribute('aria-label', 'Szukaj sesji')
	assert.equal(exports.findSearchButton(), ui.searchButton)
	ui.searchButton.removeAttribute('aria-label')
	assert.equal(exports.findSearchButton(), ui.searchButton)
})

test('teardown unmounts the React root and removes the host', () => {
	installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const roots = makeRootFactory()
	const exports = loadBundle({ reactDom: { createRoot: (host) => roots.createRoot(host) } })

	exports.placeInlineHost({ t: (key) => key, actions: {}, hooks: {} })
	assert.equal(roots.rendered.length, 1, 'the inline entry was rendered once')
	const host = exports.existingHost()
	assert.ok(host !== null)
	assert.equal(ui.searchSlot.style.position, "relative", 'the line was prepared for placement')
	exports.removeInlineHost()
	assert.equal(exports.existingHost(), null, 'the host is detached')
	assert.equal(roots.rendered.at(-1).element, null, 'the root was unmounted')
	// No trace may be left in another plugin's DOM.
	assert.equal(ui.searchSlot.style.position, "", 'the line’s positioning is restored')
	assert.equal(ui.searchSlot.style.overflow, "", 'the line’s overflow is restored')
	assert.equal(ui.searchSlot.getAttribute("data-dsh-msel-host-row"), null, 'the marker attribute is removed')
})

test('the footer fallback button hides only when placement succeeded', () => {
	installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()

	/** Render the footer view with a placement report. */
	const renderFooter = (inline) => exports.MultiSelectEntry({
		t: (key) => key,
		actions: {},
		// The slot passes the resolved icons and the tooltip helper exactly as
		// `apply` built them; a stub here keeps the test about visibility.
		icons: { checklist: () => null, search: () => null, loading: () => null },
		tip: (label, child) => ({ type: 'tooltip', props: { label, children: child } }),
		hooks: {
			sessions: { subscribe: () => () => {}, getSnapshot: () => ({ items: [] }) },
			placement: { subscribe: () => () => {}, getSnapshot: () => ({ inline }) },
			panel: makePanelStore(),
			store: makePanelStore({ mode: 'inline', inlineProven: false }),
			// The footer view also reads the two inline-mode seats: the button has
			// to know whether the ticks (not the dialog) are what is on.
			inline: makePanelStore({ active: false, busy: false, confirming: false, status: null }),
			marks: makePanelStore({ pinnedIds: [], archivedIds: [], real: false })
		}
	})

	// Unplaced: the fallback is the only entry, so it must be visible.
	assert.equal(renderFooter(false).props.children[0].props.children.props.style, undefined,
		'the fallback button shows while unplaced')
	// Placed: the header button is the entry point the user asked for, so the
	// sidebar must not carry a second one.
	const placed = renderFooter(true)
	assert.deepEqual(placed.props.children[0].props.children.props.style, { display: 'none' },
		'the fallback button hides once the header button is placed')
	assert.ok(placed.props.children[1] !== undefined, 'the modal view stays mounted so a dialog survives')
})

test('the document-level trigger drives the entry without a React click', () => {
	const doc = installDocument()
	const storage = installSessionStorage()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()
	exports.apply(makeApplyCtx())

	const host = exports.existingHost()
	assert.ok(host !== null, 'the inline button was placed')
	const clicks = doc.listeners.filter((entry) => entry.type === 'click')
	// Two click triggers: the row ticks of inline mode, and the entry button. Both
	// listen in the capture phase, which is the point — it runs before any handler
	// above the button (in another plugin's React root) could consume the gesture.
	assert.equal(clicks.length, 2, 'the inline ticks and the entry button both listen')
	assert.equal(clicks.every((entry) => entry.capture === true), true, 'both listen in the capture phase')

	// A click elsewhere must not do anything.
	doc.fireClick(ui.searchButton)
	assert.equal(storage.trail().some((line) => line.includes('inline on')), false, 'the magnifier is not the trigger')
	// A click on the injected button reaches the entry action, whatever React does.
	// The default mode is inline ticks, so that is what the press turns on.
	doc.fireClick(host)
	assert.equal(storage.trail().some((line) => line.includes('click document')), true, 'the click was seen at the document')
	assert.equal(storage.trail().some((line) => line.includes('inline on')), true, 'and it turned inline mode on')
	// Pressing it again leaves the mode, so one button toggles it.
	doc.fireClick(host)
	assert.equal(storage.trail().some((line) => line.includes('inline off')), true, 'a second press leaves inline mode')
})

test('a press that never becomes a click still drives the entry', () => {
	const doc = installDocument()
	const storage = installSessionStorage()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const exports = loadBundle()
	exports.apply(makeApplyCtx())

	const host = exports.existingHost()
	assert.ok(host !== null, 'the inline button was placed')
	const opened = () => storage.trail().some((line) => line.includes('inline on'))

	// The reported failure exactly: the press lands on the button, Chromium never
	// generates the click (the gesture turned into a drag), and the button looks
	// dead. The release must act on its own.
	doc.fire('pointerdown', host, { x: 158, y: 164 })
	assert.equal(opened(), false, 'the press alone does nothing')
	doc.fire('pointerup', host, { x: 158, y: 164 })
	assert.equal(storage.trail().some((line) => line.includes('up open')), true, 'the release runs the entry action')
	assert.equal(opened(), true, 'and inline mode is on')

	// A release on the button after pressing somewhere else is not a click on it.
	doc.fire('pointerdown', ui.searchButton, { x: 190, y: 164 })
	doc.fire('pointerup', host, { x: 158, y: 164 })
	const opens = storage.trail().filter((line) => line.includes('up open')).length
	assert.equal(opens, 1, 'a drag onto the button does not count as clicking it')
})

test('apply mounts an observer and tears the inline host down on dispose', () => {
	const doc = installDocument()
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const observers = []
	globalThis.MutationObserver = class {
		constructor(callback) { this.callback = callback; observers.push(this) }
		observe() {}
		disconnect() { this.disconnected = true }
	}
	const disposes = []
	const bundle = loadBundle()
	const ctx = makeApplyCtx({ disposes })
	bundle.apply(ctx)
	assert.equal(observers.length, 1, 'one MutationObserver watches for the session list')
	assert.equal(bundle.existingHost() !== null, true, 'the inline host was placed during mount')
	assert.equal(doc.listeners.length, 5, 'the document triggers (ticks click + keydown, entry click + pointerdown + pointerup) are registered')
	assert.equal(doc.listeners.every((entry) => entry.capture === true), true, 'all listen in the capture phase')

	const teardown = disposes.find((entry) => entry.label.includes('inline host teardown'))
	assert.ok(teardown !== undefined, 'teardown effect registered')
	teardown.dispose()
	assert.equal(observers[0].disconnected, true, 'the observer is disconnected')
	assert.equal(doc.listeners.length, 0, 'the document triggers are removed with the plugin')
	assert.equal(bundle.existingHost(), null, 'the injected host is removed')
})

// --- inline mode: the ticks and the bar -------------------------------------

/** A layout where the rows report a resolved inline-start padding of 8px. */
const rowLayout = { computedStyle: () => ({ paddingInlineStart: '8px', position: 'static' }) };

test('inline mode draws one tick per session row and leaves no trace', () => {
	installDocument()
	const list = makeSessionList(['a', 'b'])
	document.body.appendChild(list.root)
	const exports = loadBundle({ layout: rowLayout })

	const painted = exports.paintInlineMarks(new Set(['b']))
	assert.deepEqual(painted, ['a', 'b'], 'the ids come back in paint order — that is what "all" means here')
	assert.equal(document.body.classList.contains('dsh-msel-picking'), true, 'the page knows inline mode is on')
	// The body must NOT carry the entry button's own class: that one styles a 28px
	// inline-flex button, so the window would be laid out as a single button.
	assert.equal(document.body.classList.contains('dsh-msel-inline'), false, 'the body is not styled as the button')
	for (const entry of list.rows) {
		const mark = entry.row.querySelector('[data-dsh-msel-mark]')
		assert.ok(mark !== null, `row ${entry.id} carries a tick host`)
		assert.equal(mark.parentElement, entry.row, 'the tick sits inside the row it belongs to')
		// The gutter is reserved out of the row's OWN resolved padding (8px + 22px),
		// so the status dot, the title, and the time keep their places — and the row
		// is pinned to border-box first, or a flex-item row would grow by the gutter
		// and push the list wider than its column (the sidebar then scrolls sideways).
		assert.equal(entry.row.style.paddingInlineStart, '30px', 'the row reserves the tick gutter')
		assert.equal(entry.row.style.boxSizing, 'border-box', 'the gutter cannot widen the row')
		assert.equal(entry.row.style.position, 'relative', 'and becomes the tick’s containing block')
		const box = mark.children[0]
		assert.equal(box.getAttribute('role'), 'checkbox', 'the tick is announced as a checkbox')
		assert.equal(box.getAttribute('data-selected'), entry.id === 'b' ? 'true' : 'false')
		assert.equal(entry.row.getAttribute('data-dsh-msel-selected'), entry.id === 'b' ? 'true' : 'false')
		assert.equal(exports.closestRow(entry.title), entry.row, 'a row is found from anything inside it')
	}

	// Idempotent: a pass after any DOM churn repaints the same rows, and neither
	// stacks a second tick nor widens the gutter again.
	exports.paintInlineMarks(new Set(['a', 'b']))
	assert.deepEqual(exports.sessionRows().map((entry) => entry.id), ['a', 'b'])
	for (const entry of list.rows) {
		assert.equal(entry.row.querySelectorAll('[data-dsh-msel-mark]').length, 1, 'exactly one tick per row')
		assert.equal(entry.row.style.paddingInlineStart, '30px', 'the gutter is not widened twice')
		assert.equal(entry.row.querySelector('[data-dsh-msel-mark]').children[0].getAttribute('data-selected'), 'true')
	}

	exports.clearInlineMarks()
	for (const entry of list.rows) {
		assert.equal(entry.row.querySelector('[data-dsh-msel-mark]'), null, 'the tick is gone')
		assert.equal(entry.row.getAttribute('data-dsh-msel-selected'), null, 'the selection marker is gone')
		assert.equal(entry.row.style.paddingInlineStart, undefined, 'the row is back to what the shell rendered')
		assert.equal(entry.row.style.position, undefined, 'including its positioning')
		assert.equal(entry.row.style.boxSizing ?? '', '', 'and its box model')
	}
	assert.equal(document.body.classList.contains('dsh-msel-picking'), false, 'and the page leaves the mode')
})

test('inline mode hands over to the panel when there is no row to tick', () => {
	const doc = installDocument()
	const storage = installSessionStorage()
	// A list shaped differently from what the ticks expect: the header is there,
	// the session rows are not.
	const ui = makeHeader()
	document.body.appendChild(ui.header)
	const timers = []
	const exports = loadBundle()
	// The bundle's own window, with a timer that is only recorded — the check runs
	// when the test says so.
	globalThis.window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
	globalThis.window.clearTimeout = () => {}
	exports.apply(makeApplyCtx())

	doc.fireClick(exports.existingHost())
	assert.equal(timers.length, 1, 'entering inline mode schedules one "did anything appear?" check')
	assert.equal(storage.trail().some((line) => line.includes('inline on')), true)
	timers[0].fn()
	// Nothing to tick: the mode the user asked for cannot be drawn, so the plugin
	// hands over to the panel instead of leaving them with an empty promise.
	assert.equal(storage.trail().some((line) => line.includes('inline fallback')), true, 'the handover is recorded')
	assert.equal(storage.trail().some((line) => line.includes('panel open')), true, 'and the panel is what opens')
	assert.equal(exports.existingBarHost(), null, 'no bar is left behind on a list that has no rows')
})

test('inline mode takes the row click instead of opening the conversation', () => {
	const doc = installDocument()
	const storage = installSessionStorage()
	const list = makeSessionList(['a', 'b', 'c'])
	document.body.appendChild(list.root)
	const exports = loadBundle({ layout: rowLayout })
	exports.apply(makeApplyCtx())

	const tickOf = (index) => list.rows[index].row.querySelector('[data-dsh-msel-mark]')?.children[0] ?? null
	// The default mode is inline ticks, so the entry button turns them on.
	doc.fireClick(exports.existingHost())
	assert.equal(storage.trail().some((line) => line.includes('inline on')), true, 'the entry button turned inline mode on')
	assert.ok(tickOf(0) !== null, 'the rows got their ticks')

	// A click on a row is consumed before it can reach the shell's own handler —
	// which would open that conversation and lose the selection.
	const first = doc.fireClick(list.rows[0].title)
	assert.equal(first.defaultPrevented, true, 'the row click is consumed')
	assert.equal(first.propagationStopped, true, 'and it does not travel on to React')
	assert.equal(tickOf(0).getAttribute('data-selected'), 'true', 'the tick flipped')
	assert.equal(list.rows[0].row.getAttribute('data-dsh-msel-selected'), 'true')
	// Clicking it again unticks it, so the row is its own toggle.
	doc.fireClick(list.rows[0].title)
	assert.equal(tickOf(0).getAttribute('data-selected'), 'false')

	// The row's own buttons keep working: the actions menu is not a tick.
	const menu = doc.fireClick(list.rows[1].menu)
	assert.equal(menu.defaultPrevented, false, 'the row menu is left alone')
	assert.equal(tickOf(1).getAttribute('data-selected'), 'false', 'and did not tick that row')

	// Shift+click sweeps the range between the anchor and the clicked row.
	doc.fireClick(list.rows[0].title)
	doc.fireClick(list.rows[2].title, {}, { shiftKey: true })
	assert.deepEqual([0, 1, 2].map((index) => tickOf(index).getAttribute('data-selected')), ['true', 'true', 'true'])
})

test('inline mode hangs the action bar on the list, and Esc leaves the mode', () => {
	const doc = installDocument()
	const storage = installSessionStorage()
	const list = makeSessionList(['a', 'b'])
	document.body.appendChild(list.root)
	const exports = loadBundle({ layout: rowLayout })
	exports.apply(makeApplyCtx())
	assert.equal(exports.findListRoot(list.parts.searchButton), list.root, 'the list root is found from the header')

	doc.fireClick(exports.existingHost())
	const host = exports.existingBarHost()
	assert.ok(host !== null, 'the bar host is attached')
	assert.equal(host.parentElement, list.root, 'and it belongs to the session list, not to the page')
	assert.equal(host.style.position, 'absolute', 'out of flow, so the list keeps its layout')
	assert.equal(host.style.bottom, '6px', 'hung at the bottom of the list')
	assert.equal(host.style.insetInlineEnd, '6px', 'and inset from both sides')
	// The bar needs the list as its containing block, and the list gets it back.
	assert.equal(list.root.style.position, 'relative', 'the list became the containing block')
	// Placement is idempotent: the pass after any DOM churn reuses this host.
	assert.equal(exports.ensureBarHost(list.root), host, 'the same host is reused')
	assert.equal(list.root.querySelectorAll('[data-dsh-msel-bar]').length, 1, 'exactly one bar host per list')

	// Esc leaves the mode and takes both the ticks and the bar with it. (The bar's
	// own buttons are covered where they are built: node --test cannot run React.)
	const escape = doc.fire('keydown', list.rows[0].title, {}, { key: 'Escape' })
	assert.equal(escape.defaultPrevented, true, 'Esc is consumed by the mode, not by the app')
	assert.equal(storage.trail().some((line) => line.includes('inline off')), true, 'inline mode is off')
	assert.equal(exports.existingBarHost(), null, 'the bar is gone')
	assert.equal(list.rows[0].row.querySelector('[data-dsh-msel-mark]'), null, 'the ticks are gone')
	assert.equal(list.root.style.position ?? '', '', 'and the list’s own positioning is handed back')
})
