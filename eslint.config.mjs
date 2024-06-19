import eslint from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import tseslint from 'typescript-eslint';


export default tseslint.config(
	eslint.configs.recommended,
	{
		ignores: ["**/out/", "src/test/suite/fixtures/"],
	},
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
				...globals.es2020,
				...globals.builtin,
				...globals.worker,
				fetch: true,
			},
			parserOptions: {
				ecmaFeatures: {
					impliedStrict: true,
				},
			},
		},

		rules: {
			"object-curly-spacing": [
				"error",
				"always"
			],
			"require-jsdoc": "off",
			"quotes": [
				"error",
				"double"
			],
			"indent": [
				"error",
				4,
				{
					"SwitchCase": 1,
					"FunctionDeclaration": {
						"parameters": "first"
					}
				}
			],
			"max-len": [
				"error",
				120
			]
		}
	},
	{
		files: ["test/**/*.ts"],
		languageOptions: {
			globals: {
				...globals.node,
				...globals.mocha,
				fetch: true,
			},

			rules: {
				"no-async-promise-executor": "off",
				"no-await-in-loop": "off",
				"@typescript-eslint/no-non-null-assertion": "off"
			},
		},
	},
	// Any other config imports go at the top
	eslintPluginPrettier,
);
