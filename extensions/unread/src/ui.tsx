/// <reference path="./env.d.ts" />
// unread, UI half: what agents have for you that you haven't seen (a result, a failure, a question). A bell and how
// many, coloured by the most pressing (as Fut shows its waiting agents), opening a list of them, the most pressing
// first; picking one goes there. A view (`unread.bell`): in the rail while there's no space (a sidebar shows its own),
// and beside Settings in a phone's drawer. ⌘. goes to the next one, in every project or the one you're in.
import { defineAction, defineUiExtension, unreadList, useSelection, useProjects, type ViewProps } from '@superego/app/ui'
import { rollup } from '@superego/protocol'
import { BellIcon, Button, Menu, StatusGlyph } from '@superego/ui'
import { about } from './shared.ts'
import { nextUnread, type Scope } from './unread.ts'
import './styles.css'

/** App setting: where ⌘. looks for the next unread thread. */
export const SCOPE = 'unread.scope'

export default defineUiExtension({
  ...about,
  setup(superego) {
    superego.appSettings({
      id: 'unread', title: 'Unread', order: 61,
      settings: [{ key: SCOPE, title: 'Next unread thread (⌘.)', default: 'all', type: 'choice', options: [
        { value: 'all', label: 'In every project' }, { value: 'project', label: 'In this project' },
      ] }],
    })
    superego.view('unread.bell', {
      title: 'Unread', icon: BellIcon, context: 'window', fits: ['rail', 'drawer'], withoutSpaces: 'rail', narrow: 'drawer', component: UnreadButton,
    })
    superego.action(defineAction({
      id: 'unread.next', title: 'Next unread thread', keys: 'mod+.',
      run: (_params, c) => {
        const next = nextUnread(c.projects, c.selection, c.appSetting<Scope>(SCOPE) ?? 'all')
        if (next) c.select(next)
      },
    }))
  },
})

function UnreadButton({ place }: ViewProps<'window'>) {
  const { projects } = useProjects()
  const { selection, select } = useSelection()
  const list = unreadList(projects, selection)
  if (!list.length) return null
  const top = rollup(list.map((w) => w.thread.status))
  const label = `${list.length} unread`
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button className={`unread-button unread-button--${top.state}`} aria-label={label} title={label} />}>
        <BellIcon size={15} aria-hidden />
        <span className="unread-button__count">{list.length}</span>
      </Menu.Trigger>
      <Menu.Popup side={place === 'rail' ? 'right' : 'top'} className="unread-menu">
        {list.map(({ project, thread }) => (
          <Menu.Item key={`${project.machine.id}/${thread.id}`} hint={project.name} onClick={() => select({ machine: project.machine.id, thread: thread.id })}>
            <span className="unread-menu__row"><StatusGlyph status={thread.status} /><span className="unread-menu__title">{thread.title}</span></span>
          </Menu.Item>
        ))}
      </Menu.Popup>
    </Menu.Root>
  )
}
