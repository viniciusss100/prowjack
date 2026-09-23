"use strict";

const globals = require("globals");
const unusedImports = require("eslint-plugin-unused-imports");

module.exports = [
  {
    ignores: ["node_modules/**", "test/**", "scripts/**", "package-lock.json", "public/**", ".codex-worktrees/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["warn", { vars: "all", args: "none", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^(_|e|err)$" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-unreachable": "warn",
      "no-cond-assign": ["error", "except-parens"],
      "no-else-return": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-multi-str": "off",
      "no-redeclare": "off",
      "no-var": "off",
      "prefer-const": "off",
      "no-trailing-spaces": "warn",
      semi: ["error", "always"],
      "no-extra-semi": "error",
    },
  },
];