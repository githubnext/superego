// Every bundled extension's UI half. Whether each is required or optional is its own declaration (`about`), not decided
// here; the sidebar's, required, comes first.
import { mountApp } from '@superego/app/ui'
import askUser from '@superego/ask-user/ui'
import ego from '@superego/ego/ui'
import files from '@superego/files/ui'
import git from '@superego/git/ui'
import images from '@superego/images/ui'
import links from '@superego/links/ui'
import notifications from '@superego/notifications/ui'
import paneUi from '@superego/pane-ui/ui'
import replyUi from '@superego/reply-ui/ui'
import skills from '@superego/skills/ui'
import suggestions from '@superego/suggestions/ui'
import tasks from '@superego/tasks/ui'
import terminal from '@superego/terminal/ui'
import threads from '@superego/threads/ui'
import unread from '@superego/unread/ui'
import webPanes from '@superego/web-panes/ui'
import worktrees from '@superego/worktrees/ui'
import app from '../../superego.config.ts'

mountApp(app, { extensions: [threads, worktrees, askUser, ego, files, git, images, links, notifications, paneUi, replyUi, skills, suggestions, tasks, terminal, unread, webPanes] })
