import { mountApp } from '@superego/app/ui'
import askUser from '@superego/ask-user/ui'
import files from '@superego/files/ui'
import threads from '@superego/threads/ui'
import app from '../../superego.config.ts'

mountApp(app, { extensions: [threads, askUser, files] })
