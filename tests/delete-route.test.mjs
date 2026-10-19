/**
 * Host-half route test for the session-multiselect delete route.
 *
 * Runs the real `apply()` against a fake Cordis context and a temporary
 * DSH_HOME, so the file-system work (locate the session directory, remove it,
 * clear the projection-cache entry, refuse bad input) is exercised for real —
 * no DSH process, no real session touched.
 *
 *   node tests/delete-route.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const MODULE = new URL('../lib/index.js', import.meta.url)

/** Build a throwaway DSH_HOME with two workspaces and four sessions. */
async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'msel-home-'))
  const ids = {
    live: 'session-11111111-1111-1111-1111-111111111111',
    other: 'session-22222222-2222-2222-2222-222222222222',
    missing: 'session-33333333-3333-3333-3333-333333333333',
    // A subagent session: its log records a BARE UUID (no `session-` prefix),
    // which is also the name of its directory — the id shape that used to be
    // refused, failing the whole batch.
    child: '44444444-4444-4444-4444-444444444444',
  }
  const wsA = join(home, 'sessions', '--D-Chat--')
  const wsB = join(home, 'sessions', '--D-other--')
  await mkdir(join(wsA, ids.live), { recursive: true })
  await mkdir(join(wsA, ids.other), { recursive: true })
  await mkdir(join(wsA, ids.child), { recursive: true })
  await mkdir(wsB, { recursive: true })
  await writeFile(join(wsA, ids.live, 'session.v4.jsonl.zstd'), Buffer.alloc(128, 7))
  await writeFile(join(wsA, ids.other, 'session.v4.jsonl.zstd'), Buffer.alloc(64, 9))
  await writeFile(join(wsA, ids.child, 'session.v4.jsonl.zstd'), Buffer.alloc(32, 3))
  // Projection caches come in two layouts and are named after the full session
  // id: current per-record `<id>.json` files, plus older per-id directories.
  const cache = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, `${ids.live}.json`), '{"stale":true}')
  await writeFile(join(cache, `${ids.other}.json`), '{"stale":true}')
  await writeFile(join(cache, `${ids.child}.json`), '{"stale":true}')
  await mkdir(join(cache, '11111111-1111-1111-1111-111111111111'), { recursive: true })
  return { home, ids, wsA, wsB, cache }
}

/** Collect the route handler the plugin registers. */
function mountRoute(plugin, { live = [] } = {}) {
  let handler
  const liveIds = new Set(live)
  const ctx = {
    effect(body) {
      body()
      return () => {}
    },
    webServer: {
      register(options) {
        handler = options.handler
        return () => {}
      },
    },
    // The Host's in-memory session store (`ctx.sessions`): a session present
    // here is open/loaded in the UI, and deleting only its directory would leave
    // the live row to come back on the next list pull.
    get(name) {
      if (name !== 'sessions') return undefined
      return { get: (id) => (liveIds.has(id) ? { id } : undefined) }
    },
  }
  plugin.apply(ctx)
  assert.equal(typeof handler, 'function', 'apply() must register a route handler')
  return handler
}

/** Minimal request/response doubles: the route is GET with repeated `ids`. */
function fakeExchange(method, ids, path = '/session-multiselect/delete', extra = {}) {
  const query = new URLSearchParams()
  for (const id of Array.isArray(ids) ? ids : ids === undefined ? [] : [ids]) query.append('ids', id)
  for (const [key, value] of Object.entries(extra)) query.append(key, value)
  const req = {
    method,
    url: query.toString() === '' ? path : `${path}?${query.toString()}`,
  }
  const res = {
    status: 0,
    payload: undefined,
    writeHead(status) {
      this.status = status
    },
    end(buffer) {
      this.payload = buffer === undefined ? undefined : JSON.parse(buffer.toString('utf8'))
    },
  }
  return { req, res }
}

test('deletes the selected sessions and clears their projection-cache entries', async () => {
  const { home, ids, wsA, cache } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=delete`)
    const handler = mountRoute(plugin)

    const { req, res } = fakeExchange('GET', [ids.live, ids.other])
    await handler(req, res)

    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true)
    assert.equal(res.payload.removed, 2)
    assert.deepEqual(
      res.payload.results.map((r) => [r.id, r.ok, r.removed]),
      [
        [ids.live, true, true],
        [ids.other, true, true],
      ],
    )
    assert.equal(existsSync(join(wsA, ids.live)), false, 'session directory must be gone')
    assert.equal(existsSync(join(wsA, ids.other)), false, 'second session directory must be gone')
    // Both projection-cache layouts: the current per-record file and the older
    // per-id directory.
    assert.equal(existsSync(join(cache, `${ids.live}.json`)), false, 'per-record cache file must be gone')
    assert.equal(existsSync(join(cache, `${ids.other}.json`)), false, 'second per-record cache file must be gone')
    assert.equal(
      existsSync(join(cache, '11111111-1111-1111-1111-111111111111')),
      false,
      'legacy per-id cache directory must be gone too',
    )
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('deletes subagent sessions, whose ids are bare UUIDs', async () => {
  const { home, ids, wsA, cache } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=subagent`)
    const handler = mountRoute(plugin)

    // The batch that used to fail wholesale: a top-level `session-…` id next to
    // a subagent's bare UUID. Both must be accepted and removed.
    const { req, res } = fakeExchange('GET', [ids.live, ids.child])
    await handler(req, res)

    assert.equal(res.status, 200, 'a subagent id is a valid session id, not a malformed request')
    assert.equal(res.payload.ok, true)
    assert.equal(res.payload.removed, 2)
    assert.deepEqual(
      res.payload.results.map((r) => [r.id, r.ok, r.removed]),
      [
        [ids.live, true, true],
        [ids.child, true, true],
      ],
    )
    assert.equal(existsSync(join(wsA, ids.live)), false)
    assert.equal(existsSync(join(wsA, ids.child)), false, 'the bare-UUID session directory must be gone')
    assert.equal(existsSync(join(cache, `${ids.child}.json`)), false, 'its cache file must be gone too')
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses to delete a conversation the host still holds open', async () => {
  const { home, ids, wsA, cache } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=live`)
    const handler = mountRoute(plugin, { live: [ids.live] })

    const { req, res } = fakeExchange('GET', [ids.live, ids.other])
    await handler(req, res)

    // Deleting only the directory of an open session leaves the Host's live row
    // in place, so the next list pull puts it back: that is the "sometimes it
    // works, sometimes it doesn't" report. Say so per id instead.
    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, false)
    assert.equal(res.payload.removed, 1, 'the rest of the batch still deletes')
    const live = res.payload.results.find((r) => r.id === ids.live)
    assert.equal(live.ok, false)
    assert.equal(live.removed, false)
    assert.match(live.reason, /正在打开/u)
    assert.equal(existsSync(join(wsA, ids.live)), true, 'an open conversation keeps its directory')
    assert.equal(existsSync(join(cache, `${ids.live}.json`)), true, 'and its cache entry')
    assert.equal(existsSync(join(wsA, ids.other)), false, 'the closed one is gone')
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('dry=1 reports open/live state without touching the disk', async () => {
  const { home, ids, wsA } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=dry`)
    const handler = mountRoute(plugin, { live: [ids.live] })

    const { req, res } = fakeExchange('GET', [ids.live, ids.other], '/session-multiselect/delete', { dry: '1' })
    await handler(req, res)

    assert.equal(res.status, 200)
    assert.equal(res.payload.dry, true)
    const byId = Object.fromEntries(res.payload.results.map((r) => [r.id, r]))
    assert.deepEqual({ live: byId[ids.live].live, present: byId[ids.live].present }, { live: true, present: true })
    assert.deepEqual({ live: byId[ids.other].live, present: byId[ids.other].present }, { live: false, present: true })
    // A dry run is a read: nothing may be removed.
    assert.equal(existsSync(join(wsA, ids.live)), true, 'dry run must not delete the open session')
    assert.equal(existsSync(join(wsA, ids.other)), true, 'dry run must not delete the closed session either')
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('a session that is already gone counts as deleted, not as a failure', async () => {
  const { home, ids } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=missing`)
    const handler = mountRoute(plugin)

    const { req, res } = fakeExchange('GET', [ids.missing])
    await handler(req, res)

    assert.equal(res.status, 200)
    assert.equal(res.payload.ok, true, 'idempotent: intent is "the row must not come back"')
    assert.equal(res.payload.results[0].removed, false)
    assert.equal(res.payload.results[0].reason, 'not found')
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('finds a session in a non-first workspace directory', async () => {
  const { home, ids, wsB } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // A session that only exists under the second workspace directory.
    const moved = ids.other
    await rm(join(home, 'sessions', '--D-Chat--', moved), { recursive: true, force: true })
    await mkdir(join(wsB, moved), { recursive: true })
    await writeFile(join(wsB, moved, 'session.v4.jsonl.zstd'), Buffer.alloc(16))

    const plugin = await import(`${MODULE.href}?case=otherws`)
    const handler = mountRoute(plugin)
    const { req, res } = fakeExchange('GET', [moved])
    await handler(req, res)

    assert.equal(res.payload.removed, 1)
    assert.equal(existsSync(join(wsB, moved)), false)
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('refuses malformed ids without touching the disk', async () => {
  const { home, ids, wsA } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=badid`)
    const handler = mountRoute(plugin)

    for (const bad of ['../../etc/passwd', 'session-', 'not-a-session', '', 'session-../../x']) {
      const { req, res } = fakeExchange('GET', [bad])
      await handler(req, res)
      assert.equal(res.status, 400, `must refuse ${JSON.stringify(bad)}`)
    }
    // The legitimate session is untouched by the refused calls.
    assert.equal(existsSync(join(wsA, ids.live)), true)
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('rejects a non-GET method and an empty id list', async () => {
  const { home } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=method`)
    const handler = mountRoute(plugin)

    // The route is GET-only (DSH's server 405s every POST), so anything else is
    // refused here with an explicit body rather than falling through silently.
    const post = fakeExchange('POST', ['session-11111111-1111-1111-1111-111111111111'])
    await handler(post.req, post.res)
    assert.equal(post.res.status, 405)
    assert.equal(post.res.payload.ok, false)

    const empty = fakeExchange('GET', [])
    await handler(empty.req, empty.res)
    assert.equal(empty.res.status, 400)
    assert.equal(empty.res.payload.error, 'no ids')
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('unknown sub-path answers 404 so a stale client is diagnosable', async () => {
  const { home } = await makeHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=notfound`)
    const handler = mountRoute(plugin)
    const { req, res } = fakeExchange('GET', [], '/session-multiselect/other')
    await handler(req, res)
    assert.equal(res.status, 404)
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('the workspace scan survives without any sessions root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'msel-empty-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const plugin = await import(`${MODULE.href}?case=noroot`)
    const handler = mountRoute(plugin)
    const { req, res } = fakeExchange('GET', ['session-44444444-4444-4444-4444-444444444444'])
    await handler(req, res)
    assert.equal(res.status, 200)
    assert.equal(res.payload.results[0].reason, 'not found')
  } finally {
    process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
