/**
 * dsh-session-multiselect — plugin manifest (Node-side types).
 *
 * The plugin has no host surface; see `src/index.ts` for the rationale.
 */

/** Stable Cordis plugin name. */
export declare const name: 'session-multiselect'

/** Host services consumed (none). */
export declare const inject: readonly string[]

/** Mount the plugin (no-op). */
export declare function apply(): void
