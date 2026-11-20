// The app's own config (its superego.config.ts), as the build of an app on Superego resolves it (see vite.ts).
declare module 'superego:app-config' {
  const app: import('@superego/protocol').AppConfig
  export default app
}
