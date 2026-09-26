/**
 * Unit tests for the dsh-session-multiselect client bundle's pure logic.
 *
 * The bundle is a browser artifact, so the test drives it exactly the way the
 * page does — a fake `window.__ModuleLoader__` hands the factory a fake
 * `require` — and then reads the helpers the bundle publishes on
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
	assert.equal(typeof helpers.extractTurns, 'function')
})

test('extractTurns keeps user and assistant prose and drops tool traffic', () => {
	const records = [
		{ event: { type: 'turn/start', seq: 0 } },
		{ event: { type: 'user/message', message: { content: [{ type: 'text', text: 'hello there' }] } } },
		{ event: { type: 'assistant/attempt', stream: [] } },
		{ event: { type: 'tool/call', name: 'read' } },
		{ event: { type: 'tool/result', content: [] } },
		{
			event: {
				type: 'assistant/message',
				message: {
					content: [
						{ type: 'reasoning', text: 'hidden chain of thought' },
						{ type: 'text', text: 'the answer' },
						{ type: 'tool-call', name: 'write' }
					]
				}
			}
		}
	]
	assert.deepEqual(helpers.extractTurns(records), [
		{ role: 'user', text: 'hello there' },
		{ role: 'assistant', text: 'the answer\n[tool call: write]' }
	])
})

test('extractTurns tolerates malformed and missing records', () => {
	assert.deepEqual(helpers.extractTurns(undefined), [])
	assert.deepEqual(helpers.extractTurns([null, {}, { event: null }, { event: { type: 'user/message' } }]), [])
})

test('contentText folds a bare string and ignores empty content', () => {
	assert.equal(helpers.contentText('  spaced  '), 'spaced')
	assert.equal(helpers.contentText([]), '')
	assert.equal(helpers.contentText(null), '')
})

test('sessionTitle prefers the host title and falls back to the first user message', () => {
	const records = [{ event: { type: 'user/message', message: { content: 'first question' } } }]
	assert.equal(helpers.sessionTitle({ title: 'Real title' }, records), 'Real title')
	assert.equal(helpers.sessionTitle({}, records), 'first question')
	assert.equal(helpers.sessionTitle({}, []), 'untitled session')
	const long = [{ event: { type: 'user/message', message: { content: 'x'.repeat(200) } } }]
	assert.equal(helpers.sessionTitle({}, long).length, 61)
})

test('exportBaseName strips filesystem-hostile characters and keeps a short id', () => {
	const name = helpers.exportBaseName({ sessionId: 'abcdef1234567890', title: 'a/b:c*d?e"f<g>h|i' }, [])
	assert.equal(name, 'a_b_c_d_e_f_g_h_i (abcdef12)')
})

test('sessionMarkdown carries a header and every turn', () => {
	const summary = { sessionId: 's-1', title: 'Design chat', cwd: 'D:\\work', updatedAt: 0 }
	const records = [
		{ event: { type: 'user/message', message: { content: 'question' } } },
		{ event: { type: 'assistant/message', message: { content: [{ type: 'text', text: 'answer' }] } } }
	]
	const md = helpers.sessionMarkdown(summary, records)
	assert.match(md, /^# Design chat/u)
	assert.match(md, /Session ID: `s-1`/u)
	assert.match(md, /Working directory: `D:\\work`/u)
	assert.match(md, /## User\n\nquestion/u)
	assert.match(md, /## Assistant\n\nanswer/u)
})

test('sessionJson is a structured, parseable document', () => {
	const records = [{ event: { type: 'user/message', message: { content: 'hi' } } }]
	const parsed = JSON.parse(helpers.sessionJson({ sessionId: 's-2', title: 'T' }, records))
	assert.equal(parsed.sessionId, 's-2')
	assert.equal(parsed.title, 'T')
	assert.deepEqual(parsed.turns, [{ role: 'user', text: 'hi' }])
	assert.equal(typeof parsed.exportedAt, 'string')
})

test('truncateToBudget keeps everything under budget and reports the cut otherwise', () => {
	const parts = ['aaaa', 'bbbb', 'cccc']
	assert.deepEqual(helpers.truncateToBudget(parts, 100), { text: parts.join('\n\n---\n\n'), truncated: false, kept: 3 })
	const cut = helpers.truncateToBudget(parts, 5)
	assert.equal(cut.truncated, true)
	assert.equal(cut.kept, 1)
	assert.equal(cut.text, 'aaaa')
	const none = helpers.truncateToBudget(parts, 1)
	assert.equal(none.truncated, true)
	assert.equal(none.text, 'a')
})

test('buildSynthesisPrompt prepends the instruction and flags truncation', () => {
	const entries = [
		{ summary: { sessionId: 'a', title: 'A' }, records: [{ event: { type: 'user/message', message: { content: 'x'.repeat(50) } } }] },
		{ summary: { sessionId: 'b', title: 'B' }, records: [{ event: { type: 'user/message', message: { content: 'y'.repeat(50) } } }] }
	]
	const full = helpers.buildSynthesisPrompt(entries, 100000)
	assert.equal(full.truncated, false)
	assert.equal(full.kept, 2)
	assert.match(full.text, /请完成两件事/u)
	assert.match(full.text, /# A/u)
	assert.match(full.text, /# B/u)

	const small = helpers.buildSynthesisPrompt(entries, 40)
	assert.equal(small.truncated, true)
	assert.equal(small.kept, 1)
	assert.match(small.text, /只包含所选中对话的前 1 \/ 2 个/u)
	assert.doesNotMatch(small.text, /# B/u)
})

test('visibleRows drops blank and archived rows, filters, and sorts pinned first', () => {
	const snapshot = {
		items: [
			{ sessionId: 'blank', blank: true, updatedAt: 999 },
			{ sessionId: 'old', title: 'Old work', updatedAt: 10 },
			{ sessionId: 'new', title: 'New work', updatedAt: 30, cwd: 'D:\\proj' },
			{ sessionId: 'arch', title: 'Archived', updatedAt: 50 },
			{ sessionId: 'pin', title: 'Pinned old', updatedAt: 5 }
		]
	}
	const state = { pinnedIds: ['pin'], archivedIds: ['arch'], unreadIds: ['old'] }
	const rows = helpers.visibleRows(snapshot, state, '', false)
	assert.deepEqual(rows.map((row) => row.sessionId), ['pin', 'new', 'old'])
	assert.equal(rows[0].pinned, true)
	assert.equal(rows[2].unread, true)
	assert.equal(rows[0].title, 'Pinned old')

	const withArchived = helpers.visibleRows(snapshot, state, '', true)
	assert.deepEqual(withArchived.map((row) => row.sessionId), ['pin', 'arch', 'new', 'old'])
	assert.equal(withArchived[1].archived, true)
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
		{ sessionId: 'a', cwd: 'D:\\alpha', updatedAt: 30, pinned: true },
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
