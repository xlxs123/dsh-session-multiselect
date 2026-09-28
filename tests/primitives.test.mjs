/**
 * Mount the bundle against the primitives table this machine actually ships.
 *
 * The other suites use a stub whose export names are whatever the test author
 * wrote down, which is exactly how DSH 0.10 broke this plugin unnoticed: it
 * renamed every icon (`IconSearchOutline16` → `IconSearchOutlineRegular`), the
 * stub kept the old names, and the shipped plugin threw at mount — no button, no
 * panel, no message. This suite reads the real package's export list instead, so
 * a rename shows up as a failing test rather than as a user reporting that the
 * plugin "does not work with the new version".
 *
 * Skipped (not failed) when no DSH Desktop installation is found: CI runners have
 * none, and a portability suite that fails for a missing neighbour is noise.
 *
 * Run: node --test tests/primitives.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(here, '..')
const bundlePath = join(pluginRoot, 'lib', 'client.js')

/** Candidate node_modules roots of a DSH Desktop installation, most explicit first. */
function appModuleRoots() {
	const localAppData = process.env.LOCALAPPDATA ?? ''
	return [
		process.env.SMOKE_APP_NODE_MODULES,
		process.env.DSH_APP_NODE_MODULES,
		localAppData === '' ? undefined : join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', 'node_modules'),
		localAppData === '' ? undefined : join(localAppData, 'Programs', 'DSH Desktop', 'resources', 'app', 'node_modules'),
		localAppData === '' ? undefined : join(localAppData, 'Programs', 'dsh-desktop', 'resources', 'app.asar.unpacked', 'node_modules'),
		'/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules',
		join(homedir(), '.local', 'share', 'dsh-desktop', 'resources', 'app.asar.unpacked', 'node_modules')
	].filter((root) => root !== undefined)
}

/** The installed `@deepseek-ai/dsh-client-ui-primitives` package directory, if any. */
function findPrimitives() {
	for (const root of appModuleRoots()) {
		const dir = join(root, '@deepseek-ai', 'dsh-client-ui-primitives')
		if (existsSync(join(dir, 'lib', 'index.js'))) return dir
	}
	return null
}

/**
 * Export names of a built client bundle.
 *
 * The last `export { … }` statement is the package's public face; the file ends
 * with a source-map comment, so the end of the file is not the end of the list.
 * @param source - the bundle's text.
 * @returns every exported name.
 */
function exportedNames(source) {
	const start = source.lastIndexOf('export {')
	if (start === -1) return []
	const end = source.indexOf('}', start)
	if (end === -1) return []
	return source.slice(start + 'export {'.length, end)
		.split(',')
		.map((entry) => entry.trim().split(/\s+as\s+/u).at(-1).trim())
		.filter((name) => name !== '')
}

/** Load the plugin bundle in a page-shaped fake and return its registration. */
function loadBundle() {
	const source = readFileSync(bundlePath, 'utf8')
	let registration
	// The frame clock and observer are inert here: this suite is about the module
	// table's export names, not about layout or the header injection.
	globalThis.window = {
		__ModuleLoader__: { load(value) { registration = value } },
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {}
	}
	// eslint-disable-next-line no-new-func -- the bundle is browser code, not a module
	new Function('window', 'globalThis', source)(globalThis.window, globalThis)
	assert.ok(registration !== undefined, 'bundle did not register with __ModuleLoader__')
	return registration
}

const primitivesDir = findPrimitives()

test('the resolved icon names match the installed primitives package', { skip: primitivesDir === null ? 'no DSH Desktop installation found' : false }, () => {
	assert.ok(primitivesDir !== null)
	const names = exportedNames(readFileSync(join(primitivesDir, 'lib', 'index.js'), 'utf8'))
	assert.ok(names.length > 100, `the export list looks wrong (${String(names.length)} names)`)

	// A table with exactly the installed names: anything the plugin asks for that
	// is not here is a name this DSH does not have.
	const primitives = {}
	for (const name of names) primitives[name] = () => null
	const registration = loadBundle()
	// The factory returns the module's exports (the mount suite wraps it in an
	// object named `exports`; here the value itself is what `apply` lives on).
	const plugin = registration.factory((spec) => {
		if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
		if (spec === '@deepseek-ai/dsh-client-store') return { defineStore: () => ({ create: () => ({}) }), createSnapshotStore: () => ({}) }
		if (spec === 'react') return { Component: class Component {} }
		if (spec === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
		if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
		throw new Error(`unexpected require(${spec})`)
	})

	const registered = []
	const ctx = {
		effect: () => () => {},
		locale: { register: () => () => {}, subscribe: () => () => {} },
		slots: {
			// The real slot calls back once it is ready to take the entry.
			inject: (_name, callback) => {
				callback()
				return () => {}
			},
			register: (entry, component) => {
				registered.push({ entry, component })
				return {}
			}
		},
		sessions: { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } }
	}
	// The whole point: this must not throw. DSH 0.10 removed the size-numbered
	// icon names, and the previous build threw here instead of drawing its own.
	plugin.apply(ctx)
	// The slot takes `{ name, id, locale, inject }`; `inject()` is what hands the
	// component its face (icons included), exactly as the app calls it.
	const face = registered[0].entry.inject()
	for (const key of ['search', 'checklist', 'loading']) {
		assert.equal(typeof face.icons[key], 'function', `icons.${key} resolved`)
	}
	// Named explicitly: if this build ships them, they are what gets used.
	for (const [key, name] of [['search', 'IconSearchOutlineRegular'], ['checklist', 'IconChecklistOutlineRegular'], ['loading', 'IconLoadingOutlineRegular']]) {
		if (!names.includes(name)) continue
		assert.equal(face.icons[key], primitives[name], `${key} uses ${name}`)
	}
})
