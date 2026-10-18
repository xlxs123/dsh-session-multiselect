/**
 * dsh-session-multiselect — Node half (source).
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
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'session-multiselect'

/** The HTTP surface this half needs; nothing else is consumed. */
export const inject: readonly string[] = ['webServer']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/session-multiselect'

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
function siblingIds(id: string): string[] {
  return id.startsWith('session-') ? [id, id.slice('session-'.length)] : [id, `session-${id}`]
}

/**
 * The DSH home directory holding `sessions/` and `storages/`.
 *
 * `DSH_HOME` is set for every harness-spawned process; the fallback mirrors the
 * desktop default so a plugin loaded outside that environment still resolves.
 */
function homeDir(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const appData = process.env.APPDATA
  if (typeof appData === 'string' && appData !== '') {
    return join(appData, 'dsh-desktop', 'harness')
  }
  return process.cwd()
}

/** Root of the per-workspace session directories. */
function sessionsRoot(): string {
  return join(homeDir(), 'sessions')
}

/** Root of the per-session projection cache entries. */
function projCacheRoot(): string {
  return join(homeDir(), 'storages', 'session_projcache', 'sessions')
}

/**
 * Locate the directory a stored session lives in.
 *
 * Layout is `sessions/<encoded-workspace>/<session-id>/`; the workspace level is
 * scanned rather than derived, because the encoder is DSH's own and not part of
 * this plugin's contract. Both id spellings are tried (exact first), because
 * subagent sessions live under their bare UUID. A session id that does not
 * appear is not an error — the caller reports it as "already gone".
 *
 * @param id - a validated session id.
 * @returns the absolute directory, or null when no workspace holds it.
 */
async function sessionDirOf(id: string): Promise<string | null> {
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

/** Per-id outcome of one delete attempt. */
interface DeleteOutcome {
  id: string
  ok: boolean
  removed: boolean
  reason?: string
}

/**
 * Remove one stored session.
 *
 * The projection cache carries no id prefix and lives in one of two layouts:
 * the current per-record files `<id>.json` and the older per-id directories.
 * Both spellings are cleared in both layouts; a missing entry is not a failure
 * — the session directory is what the user asked to remove.
 *
 * @param id - a validated session id.
 * @returns a per-id outcome, never throws.
 */
async function deleteOne(id: string): Promise<DeleteOutcome> {
  try {
    const dir = await sessionDirOf(id)
    if (dir === null) return { id, ok: true, removed: false, reason: 'not found' }

    await rm(dir, { recursive: true, force: true })

    for (const name of siblingIds(id)) {
      for (const target of [join(projCacheRoot(), `${name}.json`), join(projCacheRoot(), name)]) {
        try {
          await rm(target, { recursive: true, force: true })
        } catch {
          /* cache entry absent or locked: the session itself is already gone */
        }
      }
    }
    return { id, ok: true, removed: true }
  } catch (error) {
    return { id, ok: false, removed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Send one JSON response. */
function sendJson(
  res: { writeHead(status: number, headers: Record<string, unknown>): void; end(body?: Buffer): void },
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

/**
 * Handle `GET /session-multiselect/delete?ids=<id>&ids=<id>`.
 *
 * Response: `{ ok, removed, results: [{ id, ok, removed, reason? }] }`, so the
 * panel can list per-id failures exactly like it does for the other batch
 * actions. An id whose directory is already gone comes back
 * `ok: true, removed: false` — the user's intent is "this row must not come
 * back", so it counts as deleted.
 */
async function handleDelete(req: any, res: any, url: URL): Promise<void> {
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

  // Sequential, so a failure names the id it belongs to and a huge batch does
  // not fan out into hundreds of concurrent directory removals.
  const results: DeleteOutcome[] = []
  for (const id of ids) results.push(await deleteOne(id))

  const removed = results.filter((r) => r.removed).length
  const failed = results.filter((r) => r.ok !== true)
  sendJson(res, 200, { ok: failed.length === 0, removed, results })
}

/**
 * Mount the host half: register the delete route for the lifetime of the fiber.
 *
 * @param ctx - host plugin context (Cordis).
 */
export function apply(ctx: any): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req: any, res: any) => {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          if (url.pathname === `${ROUTE_PREFIX}/delete`) return handleDelete(req, res, url)
          sendJson(res, 404, { ok: false, error: 'not found' })
        },
      }),
    'session-multiselect.delete-route',
  )
}
