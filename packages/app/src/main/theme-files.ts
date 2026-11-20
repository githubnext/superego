// Imported themes as files: <dataDir>/themes/<id>.json, each a theme of ours (@superego/ui/themes), its file's name
// its id (an `id` in it, if any, must say the same). Read as the window asks for them (the Appearance section's data),
// so a file written by hand counts too; the folder is watched, and a change tells the windows. A file that doesn't read
// is noted (`problems`, shown under the pickers, and logged) and left out.
import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkTheme, type Theme } from '@superego/ui/themes'
import { reservedId, type ImportedThemes, type ThemeProblem, type ThemeStore } from '../shared/themes.ts'

export function themeFiles(dataDir: string, changed: () => void): ThemeStore & { close(): void } {
  const dir = join(dataDir, 'themes')
  let watcher: FSWatcher | undefined
  const start = async () => {
    await mkdir(dir, { recursive: true })
    watcher = watch(dir, () => changed()).on('error', (error) => console.error('Watching the themes folder failed:', error))
  }
  void start().catch((error) => console.error(`The themes folder (${dir}):`, error))
  return {
    async list(): Promise<ImportedThemes> {
      const themes: Theme[] = []
      const problems: ThemeProblem[] = []
      let names: string[]
      try { names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort() } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { themes, problems }
        throw error
      }
      for (const file of names) {
        const id = file.slice(0, -'.json'.length)
        try {
          const read: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'))
          if (read && typeof read === 'object' && 'id' in read && read.id !== id) throw new Error(`its id is "${String(read.id)}", not its file's name`)
          if (reservedId(id)) throw new Error(`"${id}" is a built-in theme's id`)
          themes.push(checkTheme({ ...(read as object), id }, file))
        } catch (error) {
          const message = (error as Error).message.replace(`${file}: `, '')
          console.error(`Theme ${join(dir, file)}: ${message}`)
          problems.push({ file, message })
        }
      }
      return { themes, problems }
    },
    async save(theme) {
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${theme.id}.json`)
      await writeFile(`${path}.tmp`, `${JSON.stringify(theme, null, 2)}\n`)
      await rename(`${path}.tmp`, path)
    },
    async remove(id) {
      await rm(join(dir, `${id}.json`))
    },
    close() { watcher?.close() },
  }
}
