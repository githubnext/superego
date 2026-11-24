// The docs: which of the repo's Markdown files become pages, under which titles and in what order. Paths are from the
// repo's root. `drop` names headings whose sections are left out (internal notes, design history); `intro: false`
// leaves out what comes before the first `##`. The build fails if a dropped heading isn't found, so the list keeps up
// with the files.

export type Page = {
  slug: string
  title: string
  src: string
  drop?: string[]
  intro?: false
}

export type Section = { title: string; pages: Page[] }

export const sections: Section[] = [
  {
    title: 'Using Superego',
    pages: [
      { slug: '', title: 'Getting started', src: 'docs/getting-started.md' },
      { slug: 'overview', title: 'Overview', src: 'docs/overview.md' },
      { slug: 'interface', title: 'How the window is put together', src: 'docs/interface.md' },
      { slug: 'machines', title: 'Machines', src: 'docs/machines.md' },
      { slug: 'cli', title: 'The command', src: 'packages/cli/skill/cli.md' },
      { slug: 'profiles', title: 'Profiles', src: 'packages/cli/skill/profiles.md' },
      { slug: 'thread-tools', title: 'Thread tools', src: 'packages/cli/skill/thread-tools.md' },
      { slug: 'mcp', title: 'MCP servers', src: 'docs/mcp.md', drop: ['How it works'] },
      { slug: 'themes', title: 'Themes', src: 'docs/themes.md' },
      { slug: 'claude-agent', title: 'Claude Agent (experimental)', src: 'docs/claude-agent.md' },
    ],
  },
  {
    title: 'Extensions',
    pages: [
      { slug: 'extensions', title: 'Start here', src: 'packages/cli/skill/SKILL.md' },
      { slug: 'guide', title: 'Writing extensions', src: 'packages/cli/skill/guide.md' },
      { slug: 'tools', title: 'Tools and prompts', src: 'packages/cli/skill/tools.md' },
      { slug: 'daemon', title: 'The daemon half', src: 'packages/cli/skill/daemon.md' },
      { slug: 'ui', title: 'The UI half', src: 'packages/cli/skill/ui.md' },
      { slug: 'window', title: 'The window', src: 'packages/cli/skill/window.md' },
      { slug: 'blocks', title: 'Blocks', src: 'docs/blocks.md' },
      { slug: 'lifecycle', title: 'Lifecycle and versions', src: 'packages/cli/skill/lifecycle.md' },
    ],
  },
  {
    title: 'Reference',
    pages: [
      { slug: 'cheatsheet', title: 'Cheat sheet', src: 'packages/cli/skill/cheatsheet.md' },
      { slug: 'debugging', title: 'Debugging', src: 'packages/cli/skill/debugging.md' },
    ],
  },
]

/** The changelog's page, outside the docs. Unreleased notes stay out until they're released. */
export const changelog: Page = { slug: 'changelog', title: 'Changelog', src: 'CHANGELOG.md', drop: ['Unreleased'], intro: false }
