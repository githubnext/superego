// The @superego/ui playground: every component, live, in the window's tokens and themes. `pnpm ui:playground` serves it
// (on every interface, so a phone on the tailnet can open it too; PORT to choose the port); `pnpm ui:playground:build`
// writes it to playground/dist, a static page to screenshot.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: Number(process.env.PORT) || 5190 },
  // One page, all of it at once: no need to split it.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
})
