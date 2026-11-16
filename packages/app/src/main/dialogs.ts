// The app's questions on the desktop: a message box, as a sheet on the window that asked when there is one.
import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'

/** Whether the first button was chosen. */
export async function confirm(options: MessageBoxOptions, window?: BrowserWindow): Promise<boolean> {
  const { response } = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return response === 0
}

/** "An agent is", "3 agents are": the start of a question about agents at work. */
export const agentsAre = (count: number) => count === 1 ? 'An agent is' : `${count} agents are`
