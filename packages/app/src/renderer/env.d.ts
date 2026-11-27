declare module '*.css'
/** A file's URL in the build, never inlined as a data: URL (an html block's frame must be a page of the window's own). */
declare module '*?url&no-inline' { const url: string; export default url }
/** An image in the build, by its URL (a small one inlined, as a data: URL): nothing is fetched from the network. */
declare module '*.png?url' { const url: string; export default url }
