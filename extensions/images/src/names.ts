// What an image is called, to someone who can't see it and in a tooltip: its alt text, else its caption, else its name.
import type { Shown } from './shared.ts'

export const fileName = (name: string) => name.replace(/[?#].*$/, '').split('/').filter(Boolean).at(-1) ?? name

export const describe = (image: Shown) => image.alt ?? image.caption ?? fileName(image.name)
