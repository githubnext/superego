// What `import … from 'superego'` resolves to where Node's loader hook can't reach (vitest): the same SDK object the daemon
// provides (profiles.ts). Keep the names in step with SDK_EXPORTS; a test checks.
/* eslint-disable */
const sdk = (globalThis as { __superegoSdk?: Record<string, never> }).__superegoSdk ?? {}
const get = (key: string) => (...args: unknown[]) => (sdk[key] as unknown as (...a: unknown[]) => unknown)(...args)
export const defineProfile = get('defineProfile'), defineExtension = get('defineExtension'), defineTool = get('defineTool')
export const section = get('section'), hook = get('hook'), wrapTool = get('wrapTool'), wrapSection = get('wrapSection')
export const defineDaemonExtension = get('defineDaemonExtension'), defineAction = get('defineAction'), spawnGroup = get('spawnGroup')
export const RpcError = (sdk as Record<string, unknown>).RpcError, GenerationTask = (sdk as Record<string, unknown>).GenerationTask
export const arr = get('arr'), blockErrors = get('blockErrors'), bool = get('bool'), int = get('int'), lit = get('lit'), nullable = get('nullable'), num = get('num')
export const obj = get('obj'), opt = get('opt'), str = get('str'), union = get('union'), unknown = get('unknown')
export default sdk
