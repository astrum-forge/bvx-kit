import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
	{
		// Build output and coverage reports are generated, not authored. Linting them
		// reports on code nobody in this repository wrote or can fix.
		ignores: ["out/**", "coverage/**", "node_modules/**"]
	},
	{
		languageOptions: {
			globals: globals.browser
		}
	},
	pluginJs.configs.recommended,
	...tseslint.configs.recommended,
	{
		// Benchmarks and build scripts run under Node; the WebGPU benchmarks use the
		// browser globals too, in the same directory.
		files: ["bench/**/*.{js,mjs}", "scripts/**/*.{js,mjs}"],
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		}
	},
	{
		files: ["tests/**/*.ts"],
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		}
	},
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	}
];
