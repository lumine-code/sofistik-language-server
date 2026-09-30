const { defineConfig } = require("eslint/config");
const eslint = require("@eslint/js");
const prettier = require("eslint-config-prettier");
const globals = require("globals");

module.exports = defineConfig([
  { ignores: ["node_modules/**"] },
  eslint.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: globals.node },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  prettier,
]);
