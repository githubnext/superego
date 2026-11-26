import type { ButtonHTMLAttributes, Ref } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; ref?: Ref<HTMLButtonElement> }

/**
 * A push button: `default`, `primary` (the one to press), `danger` (the one to press, and it destroys something: Delete,
 * Discard), or `ghost` (no box until hovered).
 */
export function Button({ variant = 'default', className = '', ...props }: Props) {
  return <button type="button" className={`superego-button superego-button--${variant} ${className}`} {...props} />
}

/** A small square push button holding a glyph. */
export function IconButton({ label, className = '', ...props }: Props & { label: string }) {
  return <Button aria-label={label} title={label} className={`superego-icon-button ${className}`} {...props} />
}
