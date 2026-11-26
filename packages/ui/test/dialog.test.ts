// @vitest-environment happy-dom
// Dialogs and the buttons in them: the danger button; ConfirmDialog and PromptDialog (their focus, keys, what they send,
// and what goes wrong shown in them); and Dialog's room around its body, `flush`, and `footer`.
import { act, createElement as h, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button, ConfirmDialog, Dialog, PromptDialog } from '../src/index.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A desktop's window with a mouse: not a phone, not a finger. */
const desktop = () => vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))

let root: Root | undefined
beforeEach(() => {
  document.body.innerHTML = ''
  desktop()
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)))

async function render(element: ReactElement) {
  root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => { root!.render(element) })
  await settle()
}

const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const key = (target: Element, key: string) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
const click = (target: HTMLElement) => act(async () => { target.click() })
/** Types into a React-controlled field: sets its value as the browser would, then says so. */
const type = (field: HTMLInputElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})

describe('Button', () => {
  it('draws the danger variant as its own', async () => {
    await render(h(Button, { variant: 'danger' }, 'Delete'))
    const drawn = button('Delete')
    expect(drawn.classList.contains('superego-button')).toBe(true)
    expect(drawn.classList.contains('superego-button--danger')).toBe(true)
    expect(drawn.type).toBe('button')
  })
})

describe('ConfirmDialog', () => {
  const confirm = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => h(ConfirmDialog, {
    title: 'Delete “Shoes”?', description: "Its file goes; this can't be undone.", confirmLabel: 'Delete', tone: 'danger', onConfirm() {}, onClose() {}, ...props,
  })

  it('says its title and description, with Cancel and its button, and marks itself an overlay', async () => {
    await render(confirm())
    const popup = $('.superego-alert')!
    expect(popup.getAttribute('role')).toBe('alertdialog')
    expect(popup.hasAttribute('data-superego-overlay')).toBe(true)
    expect($('.superego-alert__backdrop')?.hasAttribute('data-superego-overlay')).toBe(true)
    expect($('.superego-alert__title')?.textContent).toBe('Delete “Shoes”?')
    expect($('.superego-alert__message')?.textContent).toBe("Its file goes; this can't be undone.")
    expect(button('Cancel')).toBeTruthy()
    expect(button('Delete').classList.contains('superego-button--danger')).toBe(true)
    // No bar and no ✕.
    expect($('.superego-dialog__header')).toBeNull()
  })

  it('starts on Cancel when it destroys something, and on its button when it doesn\'t', async () => {
    await render(confirm())
    expect(document.activeElement).toBe(button('Cancel'))
    act(() => root!.unmount())
    document.body.innerHTML = ''
    await render(confirm({ tone: 'default', confirmLabel: 'Archive' }))
    expect(document.activeElement).toBe(button('Archive'))
    expect(button('Archive').classList.contains('superego-button--primary')).toBe(true)
  })

  it('cancels on Escape, and with Cancel', async () => {
    const onClose = vi.fn()
    const onConfirm = vi.fn()
    await render(confirm({ onClose, onConfirm }))
    await key(document.activeElement!, 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    await click(button('Cancel'))
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('confirms, waits while it runs, then closes', async () => {
    let finish!: () => void
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const onClose = vi.fn()
    await render(confirm({ onConfirm, onClose }))
    await click(button('Delete'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(button('Delete').disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => { finish() })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open saying why, when what it does fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onClose = vi.fn()
    await render(confirm({ onClose, onConfirm: () => Promise.reject(new Error('The file is open elsewhere')) }))
    await click(button('Delete'))
    await settle()
    expect($('.superego-alert__error')?.textContent).toBe('The file is open elsewhere')
    expect($('[role="alert"]')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(button('Delete').disabled).toBe(false)
    expect(error).toHaveBeenCalled()
  })

  it('shows the busy and error it is given', async () => {
    await render(confirm({ busy: true, error: 'Not allowed' }))
    expect(button('Delete').disabled).toBe(true)
    expect(button('Cancel').disabled).toBe(true)
    expect($('.superego-alert__error')?.textContent).toBe('Not allowed')
  })
})

describe('PromptDialog', () => {
  const prompt = (props: Partial<Parameters<typeof PromptDialog>[0]> = {}) => h(PromptDialog, {
    title: 'Rename canvas', defaultValue: 'Fox & Rhino', confirmLabel: 'Rename', onSubmit() {}, onClose() {}, ...props,
  })
  const field = () => $<HTMLInputElement>('.superego-alert__field')!

  it('opens with its value in the field, focused and selected, named by its title', async () => {
    await render(prompt())
    expect(field().value).toBe('Fox & Rhino')
    expect(document.activeElement).toBe(field())
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 'Fox & Rhino'.length])
    expect(field().getAttribute('aria-label')).toBe('Rename canvas')
    expect($('.superego-alert')?.hasAttribute('data-superego-overlay')).toBe(true)
  })

  it('submits the text trimmed, on Enter and with its button, then closes', async () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    await render(prompt({ onSubmit, onClose }))
    await type(field(), '  Owl & Otter  ')
    await act(async () => { field().form!.requestSubmit() })
    expect(onSubmit).toHaveBeenLastCalledWith('Owl & Otter')
    expect(onClose).toHaveBeenCalledTimes(1)
    await click(button('Rename'))
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('submits nothing empty, unless it may be', async () => {
    const onSubmit = vi.fn()
    await render(prompt({ onSubmit }))
    await type(field(), '   ')
    expect(button('Rename').disabled).toBe(true)
    await act(async () => { field().form!.requestSubmit() })
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => root!.unmount())
    document.body.innerHTML = ''
    await render(prompt({ onSubmit, allowEmpty: true }))
    await type(field(), '   ')
    await act(async () => { field().form!.requestSubmit() })
    expect(onSubmit).toHaveBeenCalledWith('')
  })

  it('says what validate finds wrong, and submits nothing until it is right', async () => {
    const onSubmit = vi.fn()
    await render(prompt({ onSubmit, validate: (name) => name === 'Shoes' ? 'There’s a “Shoes” already.' : undefined }))
    await type(field(), 'Shoes')
    expect($('.superego-alert__error')?.textContent).toBe('There’s a “Shoes” already.')
    expect(field().getAttribute('aria-invalid')).toBe('true')
    await act(async () => { field().form!.requestSubmit() })
    expect(onSubmit).not.toHaveBeenCalled()
    await type(field(), 'Socks')
    expect($('.superego-alert__error')).toBeNull()
    await act(async () => { field().form!.requestSubmit() })
    expect(onSubmit).toHaveBeenCalledWith('Socks')
  })

  it('stays open saying why, when submitting fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onClose = vi.fn()
    await render(prompt({ onClose, onSubmit: async () => { throw new Error('Names can’t have a slash') } }))
    await act(async () => { field().form!.requestSubmit() })
    await settle()
    expect($('.superego-alert__error')?.textContent).toBe('Names can’t have a slash')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cancels on Escape', async () => {
    const onClose = vi.fn()
    const onSubmit = vi.fn()
    await render(prompt({ onClose, onSubmit }))
    await key(field(), 'Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('Dialog', () => {
  it('has room around its body, unless flush', async () => {
    await render(h(Dialog, { title: 'Log', onClose() {}, children: h('p', null, 'Nothing yet') }))
    expect($('.superego-dialog')?.classList.contains('superego-dialog--flush')).toBe(false)
    act(() => root!.unmount())
    document.body.innerHTML = ''
    await render(h(Dialog, { title: 'Go to', flush: true, onClose() {}, children: h('ul') }))
    expect($('.superego-dialog')?.classList.contains('superego-dialog--flush')).toBe(true)
  })

  it('puts its footer under the body', async () => {
    await render(h(Dialog, { title: 'Layout', onClose() {}, footer: h(Button, { variant: 'primary' }, 'Save'), children: h('p', null, 'Text') }))
    const footer = $('.superego-dialog__footer')!
    expect(footer.textContent).toBe('Save')
    expect(footer.previousElementSibling?.classList.contains('superego-dialog__body')).toBe(true)
    expect($('.superego-dialog__header')?.textContent).not.toContain('Save')
  })

  it('has no footer unless given one', async () => {
    await render(h(Dialog, { title: 'Log', onClose() {}, children: h('p', null, 'Text') }))
    expect($('.superego-dialog__footer')).toBeNull()
  })
})
