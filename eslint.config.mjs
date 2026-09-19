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
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: [
            { from: 'domain', allow: ['domain', 'shared'] },
            { from: 'application', allow: ['domain', 'infrastructure', 'shared', 'fx', 'config'] },
            { from: 'infrastructure', allow: ['domain', 'shared', 'config'] },
            { from: 'api', allow: ['application', 'domain', 'shared'] },
            { from: 'treasury', allow: ['application', 'shared', 'config', 'observability'] },
            { from: 'fx', allow: ['domain', 'shared', 'config'] },
            { from: 'auth', allow: ['shared', 'config'] },
            { from: 'shared', allow: ['shared', 'config'] },
            { from: 'config', allow: ['shared', 'config'] },
            { from: 'observability', allow: ['shared', 'config'] },
          ],
        },
      ],
      'boundaries/no-unknown-files': 'off',
    },
  },
];
