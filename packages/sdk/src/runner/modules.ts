// What an author's files import by name, as `superego extension test` gives them: this Superego's own modules.
import * as react from 'react'
import * as reactDom from 'react-dom'
import * as reactDomClient from 'react-dom/client'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import * as jsxRuntime from 'react/jsx-runtime'
import * as superego from '../index.ts'
import * as testing from '../testing.ts'
import * as ui from '../ui.ts'
import * as unstable from '../unstable.ts'
import * as runner from './vitest.ts'

// 'vitest' without what only the runner uses.
const { collect: _collect, setFile: _setFile, setRunning: _setRunning, ...vitest } = runner

export const modules: Record<string, Record<string, unknown>> = {
  superego, 'superego/ui': ui, 'superego/testing': testing, 'superego/unstable': unstable, vitest,
  react, 'react/jsx-runtime': jsxRuntime, 'react/jsx-dev-runtime': jsxDevRuntime, 'react-dom': reactDom, 'react-dom/client': reactDomClient,
}
