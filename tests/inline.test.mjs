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
	// One click trigger: the entry button. It listens in the capture phase, which is
	// the point — it runs before any handler above the button (in another plugin's
	// React root) could consume the gesture.
	assert.equal(clicks.length, 1, 'the entry button listens for clicks')
	assert.equal(clicks.every((entry) => entry.capture === true), true, 'in the capture phase')

	// A click elsewhere must not do anything.
	doc.fireClick(ui.searchButton)
	assert.equal(storage.trail().some((line) => line.includes('panel open')), false, 'the magnifier is not the trigger')
	// A click on the injected button reaches the entry action, whatever React does.
	doc.fireClick(host)
	assert.equal(storage.trail().some((line) => line.includes('click document')), true, 'the click was seen at the document')
	assert.equal(storage.trail().some((line) => line.includes('panel open')), true, 'and it opened the panel')
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
	const opened = () => storage.trail().some((line) => line.includes('panel open'))

	// The reported failure exactly: the press lands on the button, Chromium never
	// generates the click (the gesture turned into a drag), and the button looks
	// dead. The release must act on its own.
	doc.fire('pointerdown', host, { x: 158, y: 164 })
	assert.equal(opened(), false, 'the press alone does nothing')
	doc.fire('pointerup', host, { x: 158, y: 164 })
	assert.equal(storage.trail().some((line) => line.includes('up open')), true, 'the release runs the entry action')
	assert.equal(opened(), true, 'and the panel reports itself open')

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
	assert.equal(doc.listeners.length, 3, 'the document triggers (click + pointerdown + pointerup) are registered')
	assert.equal(doc.listeners.every((entry) => entry.capture === true), true, 'all listen in the capture phase')

	const teardown = disposes.find((entry) => entry.label.includes('inline host teardown'))
	assert.ok(teardown !== undefined, 'teardown effect registered')
	teardown.dispose()
	assert.equal(observers[0].disconnected, true, 'the observer is disconnected')
	assert.equal(doc.listeners.length, 0, 'the document triggers are removed with the plugin')
	assert.equal(bundle.existingHost(), null, 'the injected host is removed')
})

const rowLayout = { computedStyle: () => ({ paddingInlineStart: '8px', position: 'static' }) };




