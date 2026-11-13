import { mountApp } from '@superego/app/ui'
import askUser from '@superego/ask-user/ui'
import files from '@superego/files/ui'
import images from '@superego/images/ui'
import links from '@superego/links/ui'
import suggestions from '@superego/suggestions/ui'
import tasks from '@superego/tasks/ui'
import threads from '@superego/threads/ui'
import app from '../../superego.config.ts'

mountApp(app, { extensions: [threads, askUser, files, images, tasks, suggestions, links] })
