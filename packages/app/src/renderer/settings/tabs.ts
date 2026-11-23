// Settings' tabs: the app's own three (General, Appearance, Hotkeys), each with the app's sections that name it (General
// those that name none), then Machines, All machines and one per machine. Which one shows is its target, kept for the
// window (state.tsx's `useSettingsTarget`), and set by whatever opens Settings somewhere in particular (`useShell`).
import type { AppSettingsTab, SectionInfo } from '@superego/protocol'

/** The app's tabs, in their order. */
export const APP_TABS: { tab: AppSettingsTab; title: string }[] = [
  { tab: 'general', title: 'General' },
  { tab: 'appearance', title: 'Appearance' },
  { tab: 'hotkeys', title: 'Hotkeys' },
]
/** An app tab's target. */
export const appTarget = (tab: AppSettingsTab) => `$${tab}`
export const GENERAL = appTarget('general')
export const MACHINES = '$machines'
export const ALL = '$all'

/** The app tab a target is, if it's one. */
export const appTab = (target: string) => APP_TABS.find((t) => appTarget(t.tab) === target)?.tab
/** The app tab a section of the app's shows under: the one it names, or General. */
export const sectionTab = (section: Pick<SectionInfo, 'tab'>): AppSettingsTab => APP_TABS.find((t) => t.tab === section.tab)?.tab ?? 'general'

/**
 * The tab a kept target opens: itself, unless it's gone (a machine removed since) or from before the app's settings had
 * tabs (`app`, all of them on one): then General.
 */
export function openTarget(kept: string, machines: { id: string }[]): string {
  return appTab(kept) || kept === MACHINES || kept === ALL || machines.some((m) => m.id === kept) ? kept : GENERAL
}

