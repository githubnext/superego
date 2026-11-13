// Every bundled extension's UI half. Whether each is required or optional is its own declaration (`about`), not decided
// here; the sidebar's, required, comes first.
import { mountApp } from '@superego/app/ui'
import askUser from '@superego/ask-user/ui'
import files from '@superego/files/ui'
import git from '@superego/git/ui'
import images from '@superego/images/ui'
import links from '@superego/links/ui'
import notifications from '@superego/notifications/ui'
import skills from '@superego/skills/ui'
import suggestions from '@superego/suggestions/ui'
import tasks from '@superego/tasks/ui'
import threads from '@superego/threads/ui'
import unread from '@superego/unread/ui'
import webPanes from '@superego/web-panes/ui'
import app from '../../superego.config.ts'

mountApp(app, { extensions: [threads, askUser, files, git, images, links, notifications, skills, suggestions, tasks, unread, webPanes] })
