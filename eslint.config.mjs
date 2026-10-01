import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-test/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.venv/**",
      "**/.turbo/**",
      "**/coverage/**",
      "tools/roadmap/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["packages/media-core/fixtures/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        setInterval: "readonly",
      },
    },
  },
  {
    files: ["apps/web/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
  },
  {
    files: ["tests/**/*.mjs"],
    languageOptions: {
      globals: {
        URL: "readonly",
        Buffer: "readonly",
        File: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
