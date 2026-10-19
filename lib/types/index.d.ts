/**
 * dsh-session-multiselect — plugin manifest and host-route contract.
 *
 * The Node half registers four GET routes under `/session-multiselect`:
 *
 * - `/delete?ids=…[&dry=1][&force-open=1]` — move sessions into the trash
 *   (or, with `dry=1`, report { live, present } without touching the disk);
 * - `/trash` — list the restorable deletions;
 * - `/restore?ids=…` — move trashed sessions back;
 * - `/purge?ids=…` (or `?all=1`) — permanently drop trash entries.
 *
 * GET-only is not a style choice: this DSH build answers 405 to every POST that
 * reaches its Web server, so a plugin route is only ever reachable over GET and
 * the ids travel as repeated query parameters. See `lib/index.js` for the
 * behavioural contract and the README for the limits (200 ids per request,
 * cross-site requests refused, open conversations handled explicitly).
 *
 * @packageDocumentation
 */

/** Stable Cordis plugin name. */
export declare const name: 'session-multiselect'

/** Host services this half needs. */
export declare const inject: readonly ['webServer']

/** One per-id outcome of a delete/restore/purge batch. */
export interface SessionOpOutcome {
  /** Session id exactly as it was sent. */
  id: string
  /** Whether the host accepted this id's operation. */
  ok: boolean
  /** Delete: the stored session is no longer on disk (an absent one counts). */
  removed?: boolean
  /** Restore: the conversation was put back into its workspace. */
  restored?: boolean
  /** Purge: a trash entry was permanently removed. */
  purged?: boolean
  /** Delete with `force-open=1`: the Host still held the row open. */
  live?: boolean
  /** Human-readable refusal reason, present when `ok` is false. */
  reason?: string
}

/** One restorable deletion, as `GET /session-multiselect/trash` reports it. */
export interface TrashEntry {
  /** Session id the deleted conversation had. */
  id: string
  /** Title captured from the projection cache at delete time (may be empty). */
  title: string
  /** Encoded workspace directory name (see the client's decodeWorkspaceDir). */
  workspace: string
  /** Delete time, epoch milliseconds. */
  deletedAt: number
  /** Entry directory name under `$DSH_HOME/trash/session-multiselect/`. */
  entry: string
}

/** One row of the read-only `?dry=1` probe. */
export interface DryOutcome {
  id: string
  /** The Host's in-memory session store still holds this conversation. */
  live: boolean
  /** The session directory exists on disk. */
  present: boolean
}

/** `GET /session-multiselect/delete` response. */
export interface DeleteResponse {
  ok: boolean
  removed: number
  results: SessionOpOutcome[]
}

/** `GET /session-multiselect/delete?dry=1` response. */
export interface DryResponse {
  ok: boolean
  dry: true
  results: DryOutcome[]
}

/** `GET /session-multiselect/trash` response. */
export interface TrashResponse {
  ok: boolean
  retentionDays: number
  entries: TrashEntry[]
}

/** `GET /session-multiselect/restore` response. */
export interface RestoreResponse {
  ok: boolean
  restored: number
  results: SessionOpOutcome[]
}

/** `GET /session-multiselect/purge` response. */
export interface PurgeResponse {
  ok: boolean
  purged: number
  /** True for the `?all=1` empty-the-trash form. */
  all?: boolean
  results: SessionOpOutcome[]
}

/** Mount the plugin on a Cordis host context. */
export declare function apply(ctx: unknown): void
