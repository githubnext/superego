/**
 * 'superego/ui': what an extension's UI half imports. `defineUiExtension` makes one; its `setup` gets the `UiApi`, to add
 * views, panes, slots, tool rows, actions and shortcuts. Hooks reach machines (`useValue`, `useMethod`, `call`,
 * `useThreads`) and the window (`useSelection`, `useDispatch`, `useComposer`); components (`Button`, `List`, `Dialog`,
 * `PaneHeader`, `Markdown`, the icons, …) are what to build from. What's here follows the extension API's semver
 * (`EXTENSION_API`).
 */
// The UI half's stable surface. See packages/app/src/renderer/sdk-ui.ts.
export * from '@superego/app/sdk-ui'
