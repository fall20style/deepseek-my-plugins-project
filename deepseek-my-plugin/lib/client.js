window.__ModuleLoader__.load({
	id: "deepseek-my-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// src/client/index.ts
		const name = "deepseek-my-plugin";
		/** Wait until the theme service is ready before applying the override. */
		const inject = ["theme"];
		/** Application base-background token consumed by the Web UI shell. */
		const BACKGROUND_TOKEN = "--dsw-alias-bg-base";
		/** CSS named colour #D2691E. */
		const BACKGROUND_COLOR = "chocolate";
		/** Layer identity; one override layer per source. */
		const OVERRIDE_SOURCE = "deepseek-my-plugin";
		/**
		* Stack one theme override layer that makes the base background chocolate in
		* both palettes.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.theme.overrideTokens(OVERRIDE_SOURCE, { [BACKGROUND_TOKEN]: {
				light: BACKGROUND_COLOR,
				dark: BACKGROUND_COLOR
			} }), "deepseek-my-plugin: chocolate background");
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map