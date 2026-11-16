declare module '*.css'
/** A file's URL in the build, never inlined as a data: URL (an html block's frame must be a page of the window's own). */
declare module '*?url&no-inline' { const url: string; export default url }
