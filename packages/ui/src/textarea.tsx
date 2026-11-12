import { forwardRef, type TextareaHTMLAttributes } from 'react'

/** A textarea that grows with its content up to `maxRows`. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }>(
  function TextArea({ maxRows = 12, className = '', style, ...props }, ref) {
    return <textarea ref={ref} className={`superego-textarea ${className}`} style={{ maxHeight: `${maxRows * 1.5}em`, ...style }} {...props} />
  },
)
