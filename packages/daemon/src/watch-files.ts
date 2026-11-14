// Watching files that may be replaced (saved by renaming a new one over them): their folder, for their names.
import { watch } from 'node:fs'

type Watch = { names: string[]; changed: (name: string) => void }

/** Every watch open in this process, as each one starting or ending can make the others miss a change. */
const open = new Set<Watch>()
/** When, after a watch starts or ends, each file is looked at again (ms). */
const AGAIN = [100, 1000]

/** Look at every file watched again shortly: whatever changed while no watch could hear it is heard then. */
function lookAgain() {
  for (const ms of AGAIN) setTimeout(() => { for (const w of open) for (const name of w.names) w.changed(name) }, ms).unref()
}

/**
 * Watch the files `names` in `dir`, and hear `changed(name)` when one may have changed: it can be called when nothing
 * did, so it's for reading the file again and comparing. It throws if `dir` can't be watched; errors after, quietly.
 *
 * A watch hears nothing at first: on a Mac, FSEvents takes a moment to start again whenever any watch in the process
 * starts or ends, and a change in that moment goes unheard. So does one made before the watch, after the file was
 * last read. Every file watched is looked at again a little while after.
 */
export function watchFiles(dir: string, names: string[], changed: (name: string) => void): { close(): void } {
  const entry: Watch = { names, changed }
  const watcher = watch(dir, (_event, name) => {
    if (name === null) for (const each of names) changed(each)
    else if (names.includes(String(name))) changed(String(name))
  }).on('error', () => {})
  open.add(entry)
  lookAgain()
  return {
    close() {
      if (!open.delete(entry)) return
      watcher.close()
      lookAgain()
    },
  }
}
