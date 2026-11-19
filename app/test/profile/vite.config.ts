// The app's build for test/profile.sh: the renderer unminified, so CPU profiles and React's components keep their names.
import { superegoConfig } from '@superego/app/vite'

const config = superegoConfig(new URL('../..', import.meta.url).pathname)
config.renderer!.build = { ...config.renderer!.build, minify: false }
export default config
