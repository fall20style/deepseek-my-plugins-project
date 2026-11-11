/**
 * Browser half of the plugin: paint the Web UI background chocolate.
 *
 * The theme service owns the `--dsw-*` design tokens. `overrideTokens` stacks
 * a token layer over whichever theme is active, so this plugin never replaces
 * the user's light/dark choice — it only overrides the base background while
 * the plugin is loaded, and the layer disappears when the plugin unloads.
 *
 * @module deepseek-my-plugin/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only import: pulls the theme service's Context merge (ctx.theme).
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'

export const name = 'deepseek-my-plugin'

/** Wait until the theme service is ready before applying the override. */
export const inject = ['theme']

/** Application base-background token consumed by the Web UI shell. */
const BACKGROUND_TOKEN = '--dsw-alias-bg-base'

/** CSS named colour #D2691E. */
const BACKGROUND_COLOR = 'chocolate'

/** Layer identity; one override layer per source. */
const OVERRIDE_SOURCE = 'deepseek-my-plugin'

/**
 * Stack one theme override layer that makes the base background chocolate in
 * both palettes.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.theme.overrideTokens(OVERRIDE_SOURCE, {
      [BACKGROUND_TOKEN]: { light: BACKGROUND_COLOR, dark: BACKGROUND_COLOR },
    }),
    'deepseek-my-plugin: chocolate background',
  )
}
