/**
 * dsh-session-multiselect — Node half (source mirror).
 *
 * The shipped artifact is `lib/index.js`; this file mirrors it one-to-one so
 * the source tree stays readable in a repository with no build step. Type
 * annotations are elided here on purpose: the package's public types are
 * `lib/types/index.d.ts`, and `package.json` never compiles this file. Keep
 * the two files in sync when editing either.
 *
 * See lib/index.js for the full rationale: the Host-half delete/restore/trash
 * routes, the GET-only constraint, the two id spellings, the live-session
 * refusal, and the trash layout.
 */
/**
 * dsh-session-multiselect — Node half.
 *
 * Why this half exists
 * --------------------
 * The panel's batch actions run in the Web client, but **DSH's client session
 * service has no `delete`**: the runtime `ISessions` face exposes `list`,
 * `open`, `fork`, `binding`, `scope` and `openSubagent`, and nothing that
 * removes a stored session. Calling `ctx.sessions.delete(id)` therefore failed
 * with `TypeError: sessions.delete is not a function`, which is the red line
 * the panel used to show.
 *
 * The ACP layer has the same gap: DSH advertises
 * `sessionCapabilities: { close, list, resume }` — no `delete` — so the
 * protocol path is closed too.
 *
 * A stored session is a directory, and the host process is the only half with
 * file-system access, so the delete is implemented here: the client requests
 * `GET /session-multiselect/delete?ids=…` and this half removes both the session
 * directory and its projection-cache entry.
 *
 * GET, not POST: DSH's Web server answers 405 to *any* POST that reaches it —
 * probed on this build, a POST to an unrouted path returns 405 exactly like a
 * routed one, while GET falls through to the router and 404s. A plugin route is
 * therefore only ever reachable over GET, and the ids travel as repeated query
 * parameters.
 *
 * Two id shapes are legal, because the session tree itself uses two: a
 * top-level session is `session-<uuid>` (its log records that id and its
 * directory is named after it), while a **subagent** session is a bare
 * `<uuid>` (`origin: "subagent"`, `parentSession` pointing at its parent).
 * Refusing the bare form used to reject an entire batch — the panel listed
 * subagent rows, a group click or "select all" put their ids in the request,
 * and the whole delete answered 400. Both shapes are accepted now, and the
 * directory lookup tries the exact spelling before the other one.
 *
 * Everything else the panel does (list, grouping, search, pin/archive marks)
 * stays client-side and is unaffected.
 *
 * @module dsh-session-multiselect
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'session-multiselect'

/** The HTTP surface this half needs; nothing else is consumed. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/session-multiselect'

/**
 * Largest id batch one request may carry.
 *
 * ids travel as repeated query parameters (GET has no body), so a huge batch
 * runs into the Web server's request-line limit and fails as an opaque 431.
 * The panel chunks its selection at this size, and the route refuses bigger
 * batches with a clear error instead of letting the header limit decide.
 */
const MAX_BATCH = 200

/**
 * A stored session id. Two shapes are real:
 *
 * - `session-<uuid>` — a top-level conversation;
 * - `<uuid>` — a subagent session (`origin: "subagent"`), i.e. a bare UUID.
 *
 * Both are hex-and-dash only, so no path separator or dot can ever reach the
 * filesystem; anything else is refused as malformed.
 */
const SESSION_ID = /^(?:session-)?[0-9a-fA-F][0-9a-fA-F-]{7,}$/

/**
 * The two on-disk spellings of one session id, exact first.
 *
 * A session directory is named after the id its log records, and both shapes
 * exist in a real DSH_HOME. The exact spelling is tried first so a normal
 * delete never falls through to a different session; the other spelling is
 * only a fallback for a log written by a build that named the directory the
 * other way.
 *
 * @param id - a validated session id.
 * @returns the id and its alternate spelling.
 */
function siblingIds(id) {
  return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`]
}

/**
 * The DSH home directory holding `sessions/` and `storages/`.
 *
 * `DSH_HOME` is set for every harness-spawned process; the fallback mirrors the
 * desktop default so a plugin loaded outside that environment still resolves.
 */
function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') {
    return join(appData, 'dsh-desktop', 'harness')
  }
  return process.cwd()
}

/** Root of the per-workspace session directories. */
function sessionsRoot() {
  return join(homeDir(), 'sessions')
}

/** Root of the per-session projection cache entries. */
function projCacheRoot() {
  return join(homeDir(), 'storages', 'session_projcache', 'sessions')
}

/** Root of this plugin's trash area: a delete moves a session here first. */
function trashRoot() {
  return join(homeDir(), 'trash', 'session-multiselect')
}

/**
 * How long a deleted conversation stays restorable.
 *
 * Entries older than this are purged on the next delete/list/restore, so the
 * folder cannot grow forever without a timer of its own.
 */
const TRASH_RETENTION_DAYS = 7
const TRASH_RETENTION_MS = TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

/**
 * Move a file or directory, falling back to copy-then-remove.
 *
 * The trash sits under the same DSH_HOME as the sessions, so `rename` is the
 * normal path; the fallback covers a layout where the two roots are on
 * different volumes and `rename` fails with EXDEV.
 */
async function movePath(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error === null || typeof error !== 'object' || error.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
  }
}

/**
 * Best-effort conversation title from the projection cache.
 *
 * A session log records no title; the projection cache is the only place the
 * Host keeps one. Read it before the cache moves into the trash so the restore
 * list can show something better than a UUID. Any failure means "no title".
 *
 * @param id - a validated session id.
 * @returns the title, or an empty string.
 */
async function cachedTitle(id) {
  for (const name of siblingIds(id)) {
    try {
      const parsed = JSON.parse(await readFile(join(projCacheRoot(), `${name}.json`), 'utf8'))
      const title = parsed?.record?.rows?.title?.val
      if (typeof title === 'string' && title !== '') return title
    } catch {
      /* absent or unreadable: no title is fine */
    }
  }
  return ''
}

/**
 * Read one trash entry's metadata, or null when it is missing or malformed.
 *
 * @param entryDir - the entry directory.
 * @returns the metadata object, or null.
 */
async function readMeta(entryDir) {
  try {
    const parsed = JSON.parse(await readFile(join(entryDir, 'meta.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Drop trash entries older than TRASH_RETENTION_DAYS.
 *
 * Runs before every delete/list/restore. An entry whose metadata is unreadable
 * is purged only once its own directory is old enough, so a half-written entry
 * is not deleted on the spot.
 */
async function purgeExpired() {
  const root = trashRoot()
  if (!existsSync(root)) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - TRASH_RETENTION_MS
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const meta = await readMeta(dir)
    const deletedAt = meta !== null && typeof meta.deletedAt === 'number' ? meta.deletedAt : null
    if (deletedAt !== null && deletedAt >= cutoff) continue
    if (deletedAt === null) {
      try {
        const info = await stat(dir)
        if (info.mtimeMs >= cutoff) continue
      } catch {
        continue
      }
    }
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 })
    } catch {
      /* a locked entry is retried on the next pass */
    }
  }
}

/**
 * Every restorable trash entry, newest first.
 *
 * @returns rows of `{ id, title, workspace, deletedAt, entry }`.
 */
async function listTrashEntries() {
  await purgeExpired()
  const root = trashRoot()
  if (!existsSync(root)) return []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const listed = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const meta = await readMeta(join(root, entry.name))
    if (meta === null || typeof meta.id !== 'string' || meta.id === '') continue
    listed.push({
      id: meta.id,
      title: typeof meta.title === 'string' ? meta.title : '',
      workspace: typeof meta.workspace === 'string' ? meta.workspace : '',
      deletedAt: typeof meta.deletedAt === 'number' ? meta.deletedAt : 0,
      entry: entry.name,
    })
  }
  listed.sort((left, right) => right.deletedAt - left.deletedAt)
  return listed
}

/**
 * Move one stored session into the trash.
 *
 * The session directory and its projection-cache entries move together under
 * one trash entry (`<epoch>-<id>/`), so a restore puts the conversation back
 * where it was. A session whose directory is already gone still counts as
 * deleted: the user's intent is "this row must not come back".
 *
 * @param id - a validated session id.
 * @returns a per-id outcome, never throws.
 */
async function trashOne(id) {
  try {
    const dir = await sessionDirOf(id)
    if (dir === null) return { id, ok: true, removed: false, reason: 'not found' }

    const entryName = `${Date.now()}-${id}`
    const entryDir = join(trashRoot(), entryName)
    await mkdir(entryDir, { recursive: true })

    // Read the title before the cache leaves its place.
    const title = await cachedTitle(id)
    const meta = {
      id,
      dirName: basename(dir),
      workspace: basename(dirname(dir)),
      title,
      deletedAt: Date.now(),
    }
    await writeFile(join(entryDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    await movePath(dir, join(entryDir, 'session'))

    const cacheDir = join(entryDir, 'cache')
    for (const name of siblingIds(id)) {
      for (const source of [join(projCacheRoot(), `${name}.json`), join(projCacheRoot(), name)]) {
        if (!existsSync(source)) continue
        await mkdir(cacheDir, { recursive: true })
        await movePath(source, join(cacheDir, basename(source)))
      }
    }
    return { id, ok: true, removed: true, trashed: true, entry: entryName }
  } catch (error) {
    return { id, ok: false, removed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Put one trashed session back where it came from.
 *
 * The target comes from the metadata written at delete time. A leftover
 * directory there is refused rather than overwritten (a live session may have
 * taken the id back), and the projection-cache files return to their root when
 * the entry still has them.
 *
 * @param id - a validated session id.
 * @returns a per-id outcome, never throws.
 */
async function restoreOne(id) {
  try {
    const entry = (await listTrashEntries()).find((candidate) => candidate.id === id)
    if (entry === undefined) return { id, ok: false, restored: false, reason: '回收站中没有该会话' }

    const entryDir = join(trashRoot(), entry.entry)
    const meta = await readMeta(entryDir)
    const workspace = meta !== null && typeof meta.workspace === 'string' ? meta.workspace : ''
    const dirName = meta !== null && typeof meta.dirName === 'string' && meta.dirName !== '' ? meta.dirName : id
    if (workspace === '' || /[\\/]|\.\./.test(workspace) || /[\\/]|\.\./.test(dirName)) {
      return { id, ok: false, restored: false, reason: '回收站条目的路径信息无效' }
    }
    const original = join(entryDir, 'session')
    if (!existsSync(original)) return { id, ok: false, restored: false, reason: '回收站条目的会话目录缺失' }

    const targetDir = join(sessionsRoot(), workspace, dirName)
    if (existsSync(targetDir)) return { id, ok: false, restored: false, reason: '目标位置已存在同名会话' }
    await mkdir(dirname(targetDir), { recursive: true })
    await movePath(original, targetDir)

    const cacheDir = join(entryDir, 'cache')
    if (existsSync(cacheDir)) {
      await mkdir(projCacheRoot(), { recursive: true })
      for (const file of await readdir(cacheDir, { withFileTypes: true })) {
        await movePath(join(cacheDir, file.name), join(projCacheRoot(), file.name))
      }
    }
    await rm(entryDir, { recursive: true, force: true })
    return { id, ok: true, restored: true }
  } catch (error) {
    return { id, ok: false, restored: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Locate the directory a stored session lives in.
 *
 * Layout is `sessions/<encoded-workspace>/<session-id>/`; the workspace level
 * is scanned rather than derived, because the encoder is DSH's own and not part
 * of this plugin's contract. Both id spellings are tried (exact first), because
 * subagent sessions live under their bare UUID. A session id that does not
 * appear is not an error — the caller reports it as "already gone".
 *
 * @param id - a validated session id.
 * @returns the absolute directory, or null when no workspace holds it.
 */
async function sessionDirOf(id) {
  const root = sessionsRoot()
  if (!existsSync(root)) return null

  let workspaces
  try {
    workspaces = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }

  for (const candidate of siblingIds(id)) {
    for (const entry of workspaces) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name, candidate)
      if (existsSync(dir)) return dir
    }
  }
  return null
}

/**
 * Why an open conversation cannot be deleted.
 *
 * A session lives in two places: its directory on disk and the Host's in-memory
 * session store. Deleting only the directory leaves the live session in the
 * store, so the next list pull puts the row back — the delete looks like it
 * silently did nothing, which is exactly the "sometimes it works, sometimes it
 * doesn't" report. Refuse it out loud instead, and let the user switch away.
 */
const LIVE_REASON = '会话正在打开，请先切换到其他会话再删除'

/**
 * The Host's in-memory session store, when this build exposes it.
 *
 * Resolved through `ctx.get` on each delete instead of being injected: a build
 * without the service must still mount the route (and the route still works,
 * it just cannot tell an open session from a closed one).
 *
 * @param ctx - host plugin context (Cordis).
 * @returns the service, or null.
 */
function liveSessions(ctx) {
  try {
    if (typeof ctx.get !== 'function') return null
    const service = ctx.get('sessions')
    return service !== null && service !== undefined && typeof service.get === 'function' ? service : null
  } catch {
    return null
  }
}

/**
 * Whether the Host currently holds this session open or loaded in memory.
 *
 * @param ctx - host plugin context (Cordis).
 * @param id - a validated session id.
 * @returns true when deleting its directory alone would leave a live row behind.
 */
function isLive(ctx, id) {
  const store = liveSessions(ctx)
  if (store === null) return false
  try {
    const session = store.get(id)
    return session !== null && session !== undefined
  } catch {
    return false
  }
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

/** Browser-attested cross-site request (see the route contract below). */
function isCrossSite(req) {
  const headers = req.headers
  const fetchSite = headers !== null && typeof headers === 'object' ? headers['sec-fetch-site'] : undefined
  return fetchSite === 'cross-site'
}

/**
 * Shared request guard: method, cross-site, id shape, empty batch, cap.
 *
 * @returns the validated ids, or null after the response was sent.
 */
function parseIds(res, req, url) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return null
  }
  if (isCrossSite(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    return null
  }
  const raw = url.searchParams.getAll('ids')
  const ids = raw.filter((id) => SESSION_ID.test(id))
  if (ids.length !== raw.length) {
    sendJson(res, 400, { ok: false, error: 'invalid session id' })
    return null
  }
  if (ids.length === 0) {
    sendJson(res, 400, { ok: false, error: 'no ids' })
    return null
  }
  if (ids.length > MAX_BATCH) {
    sendJson(res, 413, { ok: false, error: `too many ids in one request (max ${String(MAX_BATCH)})` })
    return null
  }
  return ids
}

/**
 * Handle `GET /session-multiselect/delete?ids=<id>&ids=<id>`.
 *
 * GET rather than POST: DSH's Web server answers 405 to *any* POST that reaches
 * it — probed on this build, a POST to an unrouted path returns 405 just like a
 * routed one, while GET falls through to the router and 404s. So a plugin route
 * is only ever reachable over GET, and the ids travel as repeated query
 * parameters. The id regex keeps the path component closed to traversal.
 *
 * A session the Host currently holds open/loaded is refused per id (see
 * LIVE_REASON): deleting its directory would leave the live row in the list, so
 * the delete would look like a no-op. Everything else is removed from disk.
 * The route is unauthenticated (plugin routes are), so it refuses the
 * browser-attested cross-site case and caps one request's batch at MAX_BATCH.
 *
 * Response: `{ ok, removed, results: [{ id, ok, removed, reason? }] }`, so the
 * panel can list per-id failures exactly like it does for the other actions.
 */
async function handleDelete(ctx, req, res, url) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }

  const raw = url.searchParams.getAll('ids')
  const ids = raw.filter((id) => SESSION_ID.test(id))
  if (ids.length !== raw.length) {
    sendJson(res, 400, { ok: false, error: 'invalid session id' })
    return
  }
  if (ids.length === 0) {
    sendJson(res, 400, { ok: false, error: 'no ids' })
    return
  }
  if (ids.length > MAX_BATCH) {
    sendJson(res, 413, { ok: false, error: `too many ids in one request (max ${String(MAX_BATCH)})` })
    return
  }

  // The route mutates state yet must be GET (see above), so a page on another
  // origin could fire it through an <img>/fetch if it learned an id. Browsers
  // label those `Sec-Fetch-Site: cross-site`; the GUI's own same-origin fetch,
  // a direct navigation and curl say `same-origin`/`none` or omit the header.
  // Only the browser-attested cross-site case is refused — this is a header
  // guard, not authentication (the route has none on this build), and it must
  // not break curl-based diagnosis.
  const headers = req.headers
  const fetchSite = headers !== null && typeof headers === 'object' ? headers['sec-fetch-site'] : undefined
  if (fetchSite === 'cross-site') {
    sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    return
  }

  // `dry=1` answers what the route WOULD do — open/live, directory present —
  // without touching the disk. It exists so "is the live-session check working
  // on this build?" can be answered without deleting a real conversation (the
  // current session is the obvious live probe), and so a future report of a
  // failed delete can be diagnosed from the outside.
  if (url.searchParams.get('dry') === '1') {
    const probes = []
    for (const id of ids) {
      probes.push({ id, live: isLive(ctx, id), present: (await sessionDirOf(id)) !== null })
    }
    sendJson(res, 200, { ok: true, dry: true, results: probes })
    return
  }

  // Sequential, so a failure names the id it belongs to and a huge batch does
  // not fan out into hundreds of concurrent directory removals.
  const results = []
  for (const id of ids) {
    if (isLive(ctx, id)) {
      results.push({ id, ok: false, removed: false, reason: LIVE_REASON })
      continue
    }
    results.push(await trashOne(id))
  }

  const removed = results.filter((r) => r.removed).length
  const failed = results.filter((r) => r.ok !== true)
  sendJson(res, 200, { ok: failed.length === 0, removed, results })
}

/**
 * Handle `GET /session-multiselect/trash`: the restorable deletions.
 */
async function handleTrash(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (isCrossSite(req)) {
    sendJson(res, 403, { ok: false, error: 'cross-site request refused' })
    return
  }
  sendJson(res, 200, {
    ok: true,
    retentionDays: TRASH_RETENTION_DAYS,
    entries: await listTrashEntries(),
  })
}

/**
 * Handle `GET /session-multiselect/restore?ids=…`: put trashed sessions back.
 *
 * Open/live sessions are refused for the same reason the delete refuses them:
 * a file move cannot make a live row agree with the disk.
 */
async function handleRestore(ctx, req, res, url) {
  const ids = parseIds(res, req, url)
  if (ids === null) return

  const results = []
  for (const id of ids) {
    if (isLive(ctx, id)) {
      results.push({ id, ok: false, restored: false, reason: LIVE_REASON })
      continue
    }
    results.push(await restoreOne(id))
  }
  const restored = results.filter((entry) => entry.restored === true).length
  const failed = results.filter((entry) => entry.ok !== true)
  sendJson(res, 200, { ok: failed.length === 0, restored, results })
}

/**
 * Mount the host half: register the delete route for the lifetime of the fiber.
 *
 * @param ctx - host plugin context (Cordis).
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          if (url.pathname === `${ROUTE_PREFIX}/delete`) return handleDelete(ctx, req, res, url)
          if (url.pathname === `${ROUTE_PREFIX}/trash`) return handleTrash(req, res)
          if (url.pathname === `${ROUTE_PREFIX}/restore`) return handleRestore(ctx, req, res, url)
          sendJson(res, 404, { ok: false, error: 'not found' })
        },
      }),
    'session-multiselect.delete-route',
  )
}
