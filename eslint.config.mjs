import tseslint from 'typescript-eslint';

export default tseslint.config(
  // ── Global ignores ──────────────────────────────────────────────────────
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/drizzle/**',
      '**/storage/**',
      '**/*.sql.ts',
      '**/.git/**',
      'frontend/tools/oxlint/**',
      'eslint.config.mjs',
    ],
  },

  // ── Strictest TS configs (includes recommended + strict + stylistic) ──
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // ── TypeScript-aware parser (monorepo project service) ─────────────────
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Strict function signatures ──────────────────────────────────────
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: false },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'explicit', overrides: { constructors: 'off' } },
      ],

      // ── Ban unsafe patterns ─────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],

      // ── Promise / async correctness ─────────────────────────────────────
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/no-invalid-void-type': 'error',

      // ── Readonly discipline ─────────────────────────────────────────────
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-readonly-parameter-types': [
        'error',
        {
          allow: [
            { from: 'package', name: ['SyntheticEvent', 'ChangeEvent'], package: 'react' },
            { from: 'lib', name: ['Request'] },
          ],
          ignoreInferredTypes: true,
        },
      ],

      // ── Type / interface discipline ─────────────────────────────────────
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: true },
      ],

      // ── Naming conventions ──────────────────────────────────────────────
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'method', format: ['camelCase'] },
        { selector: 'property', format: ['camelCase'] },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['PascalCase'] },
        { selector: 'typeProperty', modifiers: ['requiresQuotes'], format: null },
        { selector: 'objectLiteralProperty', format: null, leadingUnderscore: 'allow' },
      ],

      // ── Parameter properties ────────────────────────────────────────────
      '@typescript-eslint/parameter-properties': [
        'error',
        { prefer: 'parameter-property' },
      ],

      // ── Misc extra strictness ───────────────────────────────────────────
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true, allowNullish: false, allowAny: false },
      ],

      // ── No deprecated / legacy ──────────────────────────────────────────
      '@typescript-eslint/no-deprecated': 'error',

      // Override base style rules for TS
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          reportUsedIgnorePattern: true,
        },
      ],
    },
  },

  // ── UI framework contracts are mutable by design ──────────────────────
  {
    files: ['frontend/src/**/*.tsx'],
    rules: {
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
    },
  },
  // ── Frontend legacy components needing targeted overrides ─────────────
  {
    files: [
      'frontend/src/components/CommandPalette.tsx',
      'frontend/src/components/CreateWorkspaceModal.tsx',
      'frontend/src/components/Layout.tsx',
      'frontend/src/components/ShortcutsHelpModal.tsx',
      'frontend/src/components/WorkspaceVcs.tsx',
      'frontend/src/views/Registry.tsx',
      'frontend/src/views/RunList.tsx',
      'frontend/src/views/RunDetail.tsx',
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: [
      'frontend/src/views/AccountSettings.tsx',
      'frontend/src/components/VcsRepoSelector.tsx',
      'frontend/src/components/WorkspaceRetention.tsx',
      'frontend/src/components/PlanOutput.tsx',
      'frontend/src/views/AgentPools.tsx',
      'frontend/src/views/Registry.tsx',
      'frontend/src/views/RunDetail.tsx',
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    files: [
      'frontend/src/components/ui/status-badge.tsx',
    ],
    rules: {
      '@typescript-eslint/no-redundant-type-constituents': 'off',
    },
  },
  {
    files: [
      'frontend/src/components/ui/confirm-dialog.tsx',
    ],
    rules: {
      '@typescript-eslint/no-deprecated': 'off',
    },
  },
  {
    files: [
      'frontend/src/components/ui/help-tooltip.tsx',
      'frontend/src/components/CommandPalette.tsx',
    ],
    rules: {
      '@typescript-eslint/naming-convention': 'off',
    },
  },

  // ── Legacy/dense components: inline handler arrows return types are
  //    verbose and defeat readability (same rationale as the block above).
  {
    files: [
      'frontend/src/components/OrganizationCidrRanges.tsx',
      'frontend/src/components/WorkspaceConfigurationVersions.tsx',
      'frontend/src/views/OrganizationSettings.tsx',
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },

  // ── Relax rules for tests ──────────────────────────────────────────────
  {
    files: [
      '**/tests/**/*.ts',
      '**/tests/**/*.tsx',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/promise-function-async': 'off',
      '@typescript-eslint/prefer-readonly': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/prefer-const': 'off',
    },
  },

  // ── Backend route/app/worker handlers use mutable params ─────────────
  {
    files: ['backend/src/routes/**/*.ts', 'backend/src/app.ts', 'backend/src/worker.ts'],
    rules: {
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
    },
  },
  // ── Benchmark scaffolding is dev tooling; index lookups on fixed-size
  //    arrays and mutable ctx rely on `!`/template access. ──────────────
  {
    files: ['backend/bench/**/*.ts'],
    rules: {
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // ── Backend route/lib/worker code uses practical patterns ───────────
  {
    files: ['backend/src/routes/**/*.ts', 'backend/src/lib/**/*.ts', 'backend/src/app.ts', 'backend/src/worker.ts'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
    },
  },

  // ── Relax rules for config / script files ────────────────────────────
  {
    files: [
      '*.config.*',
      'backend/*.config.*',
      'frontend/*.config.*',
      '**/drizzle.config.*',
    ],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/prefer-readonly-parameter-types': 'off',
      '@typescript-eslint/prefer-readonly': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
);
