// What an author's files import by name, as `superego extension test` gives them: this Superego's own modules, each
// loaded once a test file imports it (hooks.ts, `ready`).

export const modules: Record<string, () => Promise<Record<string, unknown>>> = {
  superego: () => import('../index.ts'),
  'superego/ui': () => import('../ui.ts'),
  'superego/testing': () => import('../testing.ts'),
  'superego/unstable': () => import('../unstable.ts'),
  // 'vitest' without what only the runner uses.
  vitest: async () => {
    const { collect: _collect, setFile: _setFile, setRunning: _setRunning, ...vitest } = await import('./vitest.ts')
    return vitest
  },
  react: () => import('react'),
  'react/jsx-runtime': () => import('react/jsx-runtime'),
  'react/jsx-dev-runtime': () => import('react/jsx-dev-runtime'),
  'react-dom': () => import('react-dom'),
  'react-dom/client': () => import('react-dom/client'),
}
