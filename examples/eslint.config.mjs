import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({
    files: ['**/*.ts'],
    ignores: [
        "*.js",
        "**/*.js", 
        "**/*.d.ts", 
        "**/*.test.ts", 
        "**/*.spec.ts",
        "coverage/**/*.js",
        "dist/**/*.js",
        "test/**/*.js"
    ],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
    ],
    rules: {
        // disable the base rule
        "no-unused-vars": "off",
        // enable special handling
        "@typescript-eslint/no-unused-vars": [
        "error",
        {
            "argsIgnorePattern": "^_",
            "varsIgnorePattern": "^_",
            "caughtErrorsIgnorePattern": "^_"
        }
        ]
    }
  });