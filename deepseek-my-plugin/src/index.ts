/**
 * Host half of the plugin.
 *
 * This plugin has no host-side behaviour: it only changes how the Web UI is
 * painted. The empty `apply` still gives the package a Loader row, which is
 * what lets the client module system discover the browser half declared by
 * `dsh.client` in package.json.
 */

/** Host plugin body. Intentionally empty. */
export function apply(): void {}

export const name = 'deepseek-my-plugin'
