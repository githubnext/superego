// A fresh home: the first-launch page, a first thread with the user's profile UI, typing, skills, a web link in a pane,
// and a replayed agent that asks, with follow-ups queued meanwhile.
import { createServer } from 'node:http'
import { openRow, pageAt, row } from './common.mjs'

export default async function threads(t, s) {
  // The first-launch page (its switches and Get started: onboarding.test.ts), with Ego's word on it; put away for good
  // (see the reopen).
  await t.until(`document.querySelectorAll('.onboarding .onboarding__extension').length > 1`, 'onboarding on a fresh home')
  await t.until(`document.querySelector('.onboarding .ego__welcome')?.textContent.includes('Ego')`, "Ego's word on the onboarding page")
  await t.click('.onboarding button', 'Get started')
  await t.until(`!document.querySelector('.onboarding') && Boolean(document.querySelector('.app__empty'))`, 'onboarding put away')

  s.hello = (await t.call('thread.start', { title: '' })).id
  await t.call('thread.send', { thread: s.hello, text: 'hello from smoke' })
  await openRow(t, 'hello from smoke')
  await t.until(`document.querySelector('.transcript')?.textContent.includes('echo: hello from smoke')`, 'answer rendered')
  await t.until(`document.querySelector('.thread__profile')?.textContent === 'default'`, "the user's default profile, shown in the header")
  await t.until(`document.querySelector('.smoke-badge')?.textContent === 'profile ui: hello from smoke'`, "the profile's own UI, loaded at runtime")
  // A thread of another profile, never shown: its profile's UI marks its row in the sidebar all the same.
  await t.call('thread.start', { title: 'marked thread', profile: 'marked' })
  await t.until(`${row('marked thread')}?.querySelector('.smoke-mark')?.textContent === 'marked: marked thread'`, "a listed thread's profile UI, loaded without opening it")
  await t.until(`[...document.querySelectorAll('.extension-failed')].some((e) => e.textContent.includes('badge failed to draw') && e.textContent.includes('smoke crash'))`, 'a view that throws, contained in its place')
  await t.run(`globalThis.__smokeFixed = true; [...document.querySelectorAll('.extension-failed')].find((e) => e.textContent.includes('badge failed')).querySelector('button').click()`)
  await t.until(`document.querySelector('.smoke-fixed') && !document.querySelector('.extension-failed')`, 'drawn again on Retry')
  await t.type('.composer textarea', 'typed message', { enter: true })
  await t.until(`document.querySelector('.transcript')?.textContent.includes('echo: typed message')`, 'typed answer rendered')
  // The native menu is for content, as selection is (the preload's): a right-click on a message or in the composer goes
  // through to it; one on the chrome around them is cancelled, so it never shows there.
  const menu = await t.run(`['.msg--user', '.composer textarea', '.transcript', '.app__rail'].map((selector) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    document.querySelector(selector).dispatchEvent(event)
    return event.defaultPrevented
  }).join()`)
  if (menu !== 'false,false,true,true') t.fail(`native menu on content only, not chrome: ${menu}`)

  // Naming a skill: $ offers this machine's skills as you type; ⇥ takes one, and the message carries it.
  await t.type('.composer textarea', 'try $smo')
  await t.until(`document.querySelector('.completions')?.textContent.includes('$smoke-skill') && document.querySelector('.completions').textContent.includes('Checks the smoke.')`, 'skills offered')
  await t.run(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))`)
  await t.until(`document.querySelector('.composer textarea').value === 'try $smoke-skill ' && !document.querySelector('.completions')`, 'skill taken')
  await t.run(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  await t.until(`[...document.querySelectorAll('.attachment--chip')].some((chip) => chip.textContent.includes('smoke-skill'))`, 'skill sent with the message')

  // A web link in the thread: the button beside it opens the page in a pane, not the browser, even a page that refuses
  // to be framed (as most sites do).
  const site = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'; default-src 'self'" })
    res.end('<title>framed page</title><p>hello')
  })
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
  const page = `http://127.0.0.1:${site.address().port}/page`
  await t.call('thread.send', { thread: s.hello, text: `see ${page}` })
  await t.until(`Boolean(document.querySelector('.md a[href="${page}"] + .md__pane-link'))`, 'pane button beside a web link')
  await t.click(`.md a[href="${page}"] + .md__pane-link`)
  await t.until(`Boolean(document.querySelector('.web-panes-frame .web-view'))`, 'link opened in a preview pane')
  await t.until(() => pageAt(page)?.isLoading() === false && pageAt(page).getTitle() === 'framed page', 'a page that refuses framing, loaded in its pane')
  site.close()
  // ⌃O lists the links the thread drew (each claimed by what opens it): the web page and the thread it names.
  await t.call('thread.send', { thread: s.hello, text: `From [this thread](thread:${s.hello})` })
  t.key('o', ['control'])
  await t.until(`(() => { const items = [...document.querySelectorAll('.links .palette__list li')].map((li) => li.textContent); return items.some((t) => t.includes('127.0.0.1')) && items.some((t) => t.includes('this thread')) })()`, 'links listed')
  t.key('Escape', [])
  await t.until(`!document.querySelector('.links')`, 'links closed')

  // agent-ui: a replayed agent asks; the question shows above the composer and the thread as needing you; an answer
  // from the card reaches it, and it carries on.
  await t.call('settings.set', { key: 'agent.model', value: 'replay/replay' })
  const asking = (await t.call('thread.start', {})).id
  await t.call('thread.send', { thread: asking, text: 'pick a colour' })
  await openRow(t, 'pick a colour')
  await t.until(`document.querySelector('.agent-ui-waiting')?.textContent.includes('Which colour?')`, 'question card above the composer')
  await t.until(`Boolean(${row('pick a colour')}?.querySelector('.superego-status--blocked'))`, 'thread marked as needing you')
  // Sent while it's busy, a follow-up shows at once as waiting over the composer, and goes in when the agent is done;
  // one taken back with its × never does.
  const queued = (text) => `[...document.querySelectorAll('.queued-row')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`
  await t.call('thread.send', { thread: asking, text: 'then paint it', whenBusy: 'followUp' })
  await t.until(`${queued('then paint it')}?.textContent.includes('Queued')`, 'follow-up shown as queued')
  await t.call('thread.send', { thread: asking, text: 'never mind this', whenBusy: 'followUp' })
  await t.until(`document.querySelectorAll('.queued-row').length === 2`, 'second follow-up queued')
  await t.run(`${queued('never mind this')}.querySelector('.queued-row__remove').click()`)
  await t.until(`document.querySelectorAll('.queued-row').length === 1`, 'follow-up taken back')
  // One sent now steers: it goes in after the step (the question answered), ahead of the follow-up.
  await t.call('thread.send', { thread: asking, text: 'make it bold', whenBusy: 'followUp' })
  await t.until(`Boolean(${queued('make it bold')}?.querySelector('.queued-row__now'))`, 'follow-up offered to send now')
  await t.run(`${queued('make it bold')}.querySelector('.queued-row__now').click()`)
  await t.until(`${queued('make it bold')}?.textContent.includes('Steers after this step') && !${queued('make it bold')}.querySelector('.queued-row__now')`, 'sent now: steers')
  await t.run(`[...document.querySelectorAll('.agent-ui-waiting button')].find((b) => b.querySelector('.agent-ui-question__option-label')?.textContent === 'blue').click()`)
  await t.until(`!document.querySelector('.agent-ui-waiting') && document.querySelector('.agent-ui-asked')?.textContent.includes('blue') && document.querySelector('.transcript').textContent.includes('Blue it is.')`, 'answered, agent carried on')
  await t.until(`(() => { const text = document.querySelector('.transcript').textContent; return text.includes('make it bold') && text.indexOf('make it bold') < text.indexOf('Blue it is.') })()`, 'the one sent now went in after the step, before the answer')
  await t.until(`!document.querySelector('.queued-row') && document.querySelector('.transcript').textContent.includes('then paint it') && document.querySelector('.transcript').textContent.includes('Noted for later.') && !document.querySelector('.transcript').textContent.includes('never mind this')`, 'queued follow-up went in, the one taken back not')
}
