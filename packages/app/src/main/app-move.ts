// Moving a translocated app to Applications with Electron (translocation.ts has the logic): its dialogs, and the move.
import { app, dialog } from 'electron'
import type { AppConfig } from '@superego/protocol'
import type { MoveIO } from './translocation.ts'

export function appMoveIO(appConfig: AppConfig): MoveIO {
  const { name } = appConfig
  return {
    async ask({ message, detail }) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message,
        detail,
        buttons: ['Move to Applications', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
      })
      return response === 0
    },
    move: (conflict) => app.moveToApplicationsFolder({ conflictHandler: conflict }),
    replace() {
      // Synchronous: Electron asks while it moves.
      return dialog.showMessageBoxSync({
        type: 'question',
        message: `Replace the ${name} in Applications?`,
        detail: 'The copy there goes to the Trash.',
        buttons: ['Replace', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      }) === 0
    },
    async failed(error) {
      await dialog.showMessageBox({
        type: 'warning',
        message: `Couldn't move ${name} to Applications`,
        detail: `${error.message}\n\nDrag ${name} into Applications in the Finder, then open it from there.`,
      })
    },
  }
}
