/**
 * Unit tests for the dsh-session-multiselect client bundle's pure logic.
 *
 * The bundle is a browser artifact, so the test drives it exactly the way the
 * page does 鈥?a fake `window.__ModuleLoader__` hands the factory a fake
 * `require` 鈥?and then reads the helpers the bundle publishes on
 * `globalThis.__DSH_SESSION_MULTISELECT__`. That keeps the tested code identical
 * to the shipped code instead of a re-implementation.
 *
 * Run: node --test tests/ (from the plugin directory)
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

/** Load the bundle in a fake page and return its exported face plus helpers. */
function loadBundle() {
	const source = readFileSync(bundlePath, 'utf8')
	let registration
	globalThis.window = {
		__ModuleLoader__: {
			load(value) {
				registration = value
			}
		}
	}
	// eslint-disable-next-line no-new-func -- the bundle is CJS-formatted browser code
	new Function('window', 'globalThis', source)(globalThis.window, globalThis)
	assert.ok(registration !== undefined, 'bundle did not register with __ModuleLoader__')
	assert.equal(registration.id, 'dsh-session-multiselect')
	const fakeModules = new Map([
		['@deepseek-ai/dsh-client-store', { defineStore() {}, createSnapshotStore() {} }],
		['@deepseek-ai/dsh-client-ui-primitives', {}],
		// Only the class base is needed at load time: the panel's error boundary
		// extends it, and these tests never render.
		['react', { Component: class Component {} }],
		['react-dom/client', { createRoot: () => ({ render() {}, unmount() {} }) }],
		['react/jsx-runtime', {}]
	])
	const exports = registration.factory((spec) => {
		if (!fakeModules.has(spec)) throw new Error(`unexpected require(${spec})`)
		return fakeModules.get(spec)
	})
	return { exports, helpers: globalThis.__DSH_SESSION_MULTISELECT__ }
}

const { exports, helpers } = loadBundle()

test('bundle exports the module face and publishes testable helpers', () => {
	assert.equal(typeof exports.apply, 'function')
	assert.deepEqual(exports.inject, ['slots', 'locale', 'sessions'])
	assert.equal(typeof helpers.groupRows, 'function')
})

test('visibleRows drops blank and archived rows, filters, and orders by recency', () => {
	const snapshot = {
		items: [
			{ sessionId: 'blank', blank: true, updatedAt: 999 },
			{ sessionId: 'old', title: 'Old work', updatedAt: 10 },
			{ sessionId: 'new', title: 'New work', updatedAt: 30, cwd: 'D:\\proj' },
			{ sessionId: 'arch', title: 'Archived', updatedAt: 50 },
			{ sessionId: 'older', title: 'Oldest work', updatedAt: 5 }
		]
	}
	const state = { archivedIds: ['arch'] }
	const rows = helpers.visibleRows(snapshot, state, '', false)
	assert.deepEqual(rows.map((row) => row.sessionId), ['new', 'old', 'older'])
	assert.equal(rows[2].title, 'Oldest work')

	const withArchived = helpers.visibleRows(snapshot, state, '', true)
	assert.deepEqual(withArchived.map((row) => row.sessionId), ['arch', 'new', 'old', 'older'])
	assert.equal(withArchived[0].archived, true)
})

test('visibleRows matches title, working directory, and id', () => {
	const snapshot = {
		items: [
			{ sessionId: 'aaaaaaaa-1111', title: 'Alpha', updatedAt: 1 },
			{ sessionId: 'bbbbbbbb-2222', title: 'Beta', cwd: 'D:\\create games', updatedAt: 2 }
		]
	}
	assert.deepEqual(helpers.visibleRows(snapshot, {}, 'alph', false).map((r) => r.sessionId), ['aaaaaaaa-1111'])
	assert.deepEqual(helpers.visibleRows(snapshot, {}, 'GAMES', false).map((r) => r.sessionId), ['bbbbbbbb-2222'])
	assert.deepEqual(helpers.visibleRows(snapshot, {}, '2222', false).map((r) => r.sessionId), ['bbbbbbbb-2222'])
	assert.deepEqual(helpers.visibleRows(snapshot, {}, 'nomatch', false).map((r) => r.sessionId), [])
})

test('visibleRows lifts pinned rows above recency, the way DSH lists them', () => {
	const snapshot = {
		items: [
			{ sessionId: 'newest', title: 'Newest', updatedAt: 90 },
			{ sessionId: 'pinned', title: 'Pinned', updatedAt: 10 },
			{ sessionId: 'middle', title: 'Middle', updatedAt: 50 }
		]
	}
	const rows = helpers.visibleRows(snapshot, { pinnedIds: ['pinned'] }, '', false)
	assert.deepEqual(rows.map((row) => row.sessionId), ['pinned', 'newest', 'middle'])
	assert.equal(rows[0].pinned, true)
	assert.equal(rows[1].pinned, false)
	// A pinned row that is also archived stays hidden until archived rows are asked
	// for — the archive mark wins over the pin.
	const archived = helpers.visibleRows(snapshot, { pinnedIds: ['pinned'], archivedIds: ['pinned'] }, '', false)
	assert.deepEqual(archived.map((row) => row.sessionId), ['newest', 'middle'])
})

test('parseRowKey reads the session id out of a row key and nothing else', () => {
	assert.equal(helpers.parseRowKey('session:abc-123'), 'abc-123')
	assert.equal(helpers.parseRowKey('session:'), null, 'an empty id is not a row')
	assert.equal(helpers.parseRowKey('project:abc'), null, 'project rows are not sessions')
	assert.equal(helpers.parseRowKey(undefined), null)
	assert.equal(helpers.parseRowKey(''), null)
})

test('markStatusText names what really happened, partial failures included', () => {
	const asked = []
	const t = (key, params) => {
		asked.push(key)
		return params === undefined ? key : `${key}${JSON.stringify(params)}`
	}
	// A batch the workspace service performed is reported as such …
	assert.deepEqual(helpers.markStatusText(t, 'archive', { ok: 2, failed: [], real: true }, 2),
		{ text: 'status.archived{"n":2}', tone: 'info' })
	// … while the plugin's own fallback mark has to admit what it is.
	assert.equal(helpers.markStatusText(t, 'archive', { ok: 1, failed: [], real: false }, 1).text, 'status.archivedLocal{"n":1}')
	assert.equal(helpers.markStatusText(t, 'unarchive', { ok: 1, failed: [], real: false }, 1).text, 'status.unarchivedLocal{"n":1}')
	assert.equal(helpers.markStatusText(t, 'pin', { ok: 3, failed: [], real: true }, 3).text, 'status.pinned{"n":3}')
	assert.equal(helpers.markStatusText(t, 'unpin', { ok: 1, failed: [], real: true }, 1).text, 'status.unpinned{"n":1}')
	// One refusal must not hide the ids that worked.
	const partial = helpers.markStatusText(t, 'archive', { ok: 1, failed: [{ id: 'abcdefgh1234', reason: 'session is active' }], real: true }, 2)
	assert.equal(partial.tone, 'error')
	assert.match(partial.text, /status\.partial/u)
	assert.match(partial.text, /abcdefgh: session is active/u)
})

test('failureList names each id once, short, with its reason', () => {
	assert.equal(helpers.failureList([{ id: '0123456789', reason: 'boom' }, { id: 'ffffffffff', reason: 'bang' }]),
		'• 01234567: boom\n• ffffffff: bang')
	assert.equal(helpers.failureList(undefined), '')
})

test('toggleSelection adds then removes and moves the range anchor', () => {
	const first = helpers.toggleSelection(new Set(), 'a')
	assert.deepEqual([...first.selected], ['a'])
	assert.equal(first.cursor, 'a')
	const second = helpers.toggleSelection(first.selected, 'b')
	assert.deepEqual([...second.selected].sort(), ['a', 'b'])
	const third = helpers.toggleSelection(second.selected, 'a')
	assert.deepEqual([...third.selected], ['b'])
})

test('applyRange is inclusive, ordered, and additive only when asked', () => {
	const order = ['a', 'b', 'c', 'd']
	assert.deepEqual([...helpers.applyRange(new Set(), order, 'a', 'c', false)].sort(), ['a', 'b', 'c'])
	assert.deepEqual([...helpers.applyRange(new Set(), order, 'c', 'a', false)].sort(), ['a', 'b', 'c'])
	const additive = helpers.applyRange(new Set(['d']), order, 'a', 'b', true)
	assert.deepEqual([...additive].sort(), ['a', 'b', 'd'])
	assert.deepEqual([...helpers.applyRange(new Set(), order, 'zz', 'a', false)], [])
})

test('selectAll and invertSelection operate on the displayed order', () => {
	const order = ['a', 'b', 'c']
	assert.deepEqual([...helpers.selectAll(new Set(['z']), order)].sort(), ['a', 'b', 'c', 'z'])
	assert.deepEqual([...helpers.invertSelection(new Set(['b', 'z']), order)].sort(), ['a', 'c', 'z'])
})

test('workspaceLabel reads the final path segment of either separator style', () => {
	assert.equal(helpers.workspaceLabel('D:\\create plugins-dhs'), 'create plugins-dhs')
	assert.equal(helpers.workspaceLabel('/home/dev/project/'), 'project')
	assert.equal(helpers.workspaceLabel('plain'), 'plain')
	assert.equal(helpers.workspaceLabel(''), '')
	assert.equal(helpers.workspaceLabel(undefined), '')
})

test('groupRows keeps row order inside a group and heads with the busiest workspace', () => {
	const rows = [
		{ sessionId: 'a', cwd: 'D:\\alpha', updatedAt: 30 },
		{ sessionId: 'b', cwd: 'D:\\beta', updatedAt: 99 },
		{ sessionId: 'c', cwd: 'D:\\alpha', updatedAt: 10 },
		{ sessionId: 'd', updatedAt: 5 }
	]
	const groups = helpers.groupRows(rows, true)
	assert.deepEqual(groups.map((group) => group.path), ['D:\\beta', 'D:\\alpha', ''])
	assert.deepEqual(groups.map((group) => group.label), ['beta', 'alpha', ''])
	assert.deepEqual(groups[1].rows.map((row) => row.sessionId), ['a', 'c'])
	assert.equal(groups[1].latest, 30)
	// The display order is the group order, and nothing is lost or duplicated.
	assert.deepEqual(helpers.flattenGroups(groups).map((row) => row.sessionId), ['b', 'a', 'c', 'd'])
})

test('groupRows collapses to one anonymous group when grouping is off', () => {
	const rows = [{ sessionId: 'a', cwd: 'D:\\alpha', updatedAt: 1 }, { sessionId: 'b', updatedAt: 2 }]
	const flat = helpers.groupRows(rows, false)
	assert.equal(flat.length, 1)
	assert.equal(flat[0].path, '')
	assert.deepEqual(helpers.flattenGroups(flat).map((row) => row.sessionId), ['a', 'b'])
	assert.deepEqual(helpers.groupRows([], true), [])
	assert.deepEqual(helpers.flattenGroups(undefined), [])
})

test('pruneSelection drops ids the host no longer lists', () => {
	const items = [{ sessionId: 'a' }, { sessionId: 'b' }]
	assert.deepEqual([...helpers.pruneSelection(new Set(['a', 'gone']), items)], ['a'])
	assert.deepEqual([...helpers.pruneSelection(new Set(['gone']), [])], [])
})

test('failureText describes errors, codes, and plain values', () => {
	assert.equal(helpers.failureText(new Error('boom')), 'boom')
	assert.equal(helpers.failureText({ code: 'session/not-found', message: 'missing' }), 'session/not-found: missing')
	assert.equal(helpers.failureText('plain'), 'plain')
	assert.equal(helpers.failureText(null), 'unknown error')
})

test('stamp formats a local timestamp and rejects junk', () => {
	assert.match(helpers.stamp(0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)
	assert.equal(helpers.stamp(Number.NaN), '')
})
