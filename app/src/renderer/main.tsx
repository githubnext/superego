import { mountApp } from '@mu/app/ui'
import askUser from '@mu/ask-user/ui'
import files from '@mu/files/ui'
import threads from '@mu/threads/ui'
import app from '../../mu.config.ts'

mountApp(app, { extensions: [threads, askUser, files] })
