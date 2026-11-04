import type { ButtonHTMLAttributes } from 'react'

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' }

export function Button({ variant = 'default', className = '', ...props }: Props) {
  return <button type="button" className={`mu-button mu-button--${variant} ${className}`} {...props} />
}

/** A small square push button holding a glyph. */
export function IconButton({ label, className = '', ...props }: Props & { label: string }) {
  return <Button aria-label={label} title={label} className={`mu-icon-button ${className}`} {...props} />
}
