import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

export default [
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'jest.config.ts',
      'eslint.config.mjs',
      'specs/**',
      'docs/**',
      '.specify/**',
      '.karst/**',
    ],
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts'],
  })),
  {
    files: ['**/*.ts'],
    plugins: {
      boundaries,
    },
    settings: {
      'import/resolver': {
        node: { extensions: ['.js', '.json', '.ts'] },
      },
      'boundaries/include': ['src/**/*.ts'],
      'boundaries/elements': [
        { type: 'domain', pattern: 'src/capacity/domain/**' },
        { type: 'application', pattern: 'src/capacity/application/**' },
        { type: 'infrastructure', pattern: 'src/capacity/infrastructure/**' },
        { type: 'api', pattern: 'src/capacity/api/**' },
        { type: 'treasury', pattern: 'src/treasury/**' },
        { type: 'shared', pattern: 'src/shared/**' },
        { type: 'fx', pattern: 'src/fx/**' },
        { type: 'auth', pattern: 'src/auth/**' },
        { type: 'config', pattern: 'src/config/**' },
        { type: 'observability', pattern: 'src/observability/**' },
        { type: 'docs', pattern: 'src/docs/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            { from: { element: { type: 'domain' } }, allow: [{ to: [{ element: { type: 'domain' } }] }, { to: [{ element: { type: 'shared' } }] }] },
            { from: { element: { type: 'application' } }, allow: [{ to: [{ element: { type: 'domain' } }] }, { to: [{ element: { type: 'infrastructure' } }] }, { to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'fx' } }] }, { to: [{ element: { type: 'config' } }] }, { to: [{ element: { type: 'observability' } }] }] },
            { from: { element: { type: 'infrastructure' } }, allow: [{ to: [{ element: { type: 'domain' } }] }, { to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },
            { from: { element: { type: 'api' } }, allow: [{ to: [{ element: { type: 'application' } }] }, { to: [{ element: { type: 'domain' } }] }, { to: [{ element: { type: 'shared' } }] }] },
            { from: { element: { type: 'treasury' } }, allow: [{ to: [{ element: { type: 'application' } }] }, { to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }, { to: [{ element: { type: 'observability' } }] }] },
            { from: { element: { type: 'fx' } }, allow: [{ to: [{ element: { type: 'domain' } }] }, { to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },
            { from: { element: { type: 'auth' } }, allow: [{ to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },
            { from: { element: { type: 'shared' } }, allow: [{ to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },
            { from: { element: { type: 'config' } }, allow: [{ to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },
            { from: { element: { type: 'observability' } }, allow: [{ to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },
            { from: { element: { type: 'docs' } }, allow: [{ to: [{ element: { type: 'shared' } }] }, { to: [{ element: { type: 'config' } }] }] },
          ],
        },
      ],
      'boundaries/no-unknown-files': 'off',
    },
  },
];
