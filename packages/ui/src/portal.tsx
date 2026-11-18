// What a component draws outside the tree that drew it (a menu, a popover, a tooltip, a dialog, portalled to the
// window's layer) carries the attributes its tree is marked with: so styles scoped by an ancestor's attribute (a
// profile's, `@scope ([data-profile-scope=…])`) reach it there too.
import { createContext, useContext } from 'react'

/** The attributes to put on what's portalled out of this tree: `data-*` ones, by name. */
export type PortalAttributes = Record<`data-${string}`, string>

/** Provided by whoever marks a tree (the app, around a profile's UI); read by what portals out of it. */
export const PortalAttributesContext = createContext<PortalAttributes | undefined>(undefined)

/** The attributes for what this component portals out (none: spread `{}`). */
export const usePortalAttributes = (): PortalAttributes => useContext(PortalAttributesContext) ?? {}
