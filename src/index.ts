/**
 * dsh-session-multiselect — Node half (source).
 *
 * The feature is entirely browser-side: the multi-select panel reads the
 * Session list through the Web client's `sessions` service and drives batch
 * actions over the existing Session Controller remotes. There is therefore
 * nothing for the host process to own — this entry exists only so the bundle's
 * `cordis.patch.yml` row names a real, loadable Cordis plugin instead of a
 * dangling module.
 *
 * @module dsh-session-multiselect
 */

/** Stable Cordis plugin name. */
export const name = 'session-multiselect'

/** No host services are consumed: the plugin contributes nothing to the host. */
export const inject: readonly string[] = []

/**
 * Mount the plugin. Intentionally a no-op (see the module doc comment); the
 * client bundle installed through `dsh.client` carries the whole feature.
 */
export function apply(): void {}
