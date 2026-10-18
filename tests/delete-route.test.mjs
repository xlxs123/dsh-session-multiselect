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
function mountRoute(plugin) {
  let handler
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
  }
  plugin.apply(ctx)
  assert.equal(typeof handler, 'function', 'apply() must register a route handler')
  return handler
}

/** Minimal request/response doubles: the route is GET with repeated `ids`. */
function fakeExchange(method, ids, path = '/session-multiselect/delete') {
  const query = new URLSearchParams()
  for (const id of Array.isArray(ids) ? ids : ids === undefined ? [] : [ids]) query.append('ids', id)
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
