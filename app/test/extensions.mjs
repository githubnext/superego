// Screenshots of a machine's extensions (run by test/look.sh <dir> extensions), on a fresh home whose model works:
// first-run setup's two cards with Full picked (Mikkel's byline under it), Core picked, Full's whole list, GitHub
// switched off making it Custom ("Full without GitHub"), a phone's stacked cards with Full and with Custom; then
// Settings → Extensions starting from Full, and from Custom with GitHub's switch marked. Light and dark, into
// $SUPEREGO_SHOWCASE_OUT.
import { openApp } from './harness.mjs'

await openApp({ name: 'extensions', timeout: 180_000, firstRun: true }, async (t) => {
  const { run, until } = t
  await t.resize(1100, 860)
  const card = (title) => `[...document.querySelectorAll('.presets__card')].find((c) => c.querySelector('.presets__title')?.textContent === ${JSON.stringify(title)})`
  const picked = `document.querySelector('.presets__card.is-on .presets__title')?.textContent`
  const show = `document.querySelector('.setup__extensions').scrollIntoView({ block: 'start' }); document.querySelector('.setup').scrollBy(0, -140); 0`
  await until(`Boolean(${card('Full')}) && Boolean(document.querySelector('.setup__another'))`, 'setup on the model, with the extensions')
  await run(show)
  await t.both('presets-full', show)

  await run(`${card('Core')}.click()`)
  await until(`${picked} === 'Core'`, 'Core picked')
  await t.both('presets-core', show)
  await run(`${card('Full')}.click()`)
  await until(`${picked} === 'Full'`, 'Full picked again')

  await run(`document.querySelector('.setup__extensions .setup__link').click(); 0`)
  await until(`Boolean(document.querySelector('[data-extension="github"]'))`, 'the whole list')
  await t.both('presets-list', show)
  await run(`document.querySelector('[data-extension="github"] [role="switch"]').click()`)
  await until(`${picked} === 'Custom'`, 'Custom')
  await t.both('presets-custom', show)

  // A phone's width: the window goes no narrower than 600, so zoomed, its page is a phone's 375.
  await t.resize(600, 1300)
  await t.zoom(1.6)
  await run(`${card('Full')}.click()`)
  await until(`${picked} === 'Full'`, 'Full on a phone')
  await run(`document.querySelector('.setup__extensions .setup__link').click(); 0`)
  const end = `document.querySelector('.setup__extensions').scrollIntoView({ block: 'end' }); 0`
  await run(end)
  await t.both('presets-phone', end)
  await run(`document.querySelector('.setup__extensions .setup__link').click(); 0`)
  await run(`document.querySelector('[data-extension="github"] [role="switch"]').click()`)
  await until(`${picked} === 'Custom'`, 'Custom on a phone')
  await t.both('presets-phone-custom', show)
  await t.zoom(1)
  await t.resize(1100, 860)

  // Settings → This computer → Extensions: from Custom (GitHub off, marked), then from Full again.
  await t.click('.setup__foot button', 'Done')
  await until(`!document.querySelector('.setup')`, 'setup done')
  await t.click('.app__settings')
  await until(`[...document.querySelectorAll('.settings__nav button')].some((b) => b.textContent.trim() === 'This computer')`, 'Settings')
  await run(`[...document.querySelectorAll('.settings__nav button')].find((b) => b.textContent.trim() === 'This computer').click()`)
  await until(`Boolean(document.querySelector('.extensions__start'))`, 'Settings → Extensions')
  const section = `document.querySelector('.extensions__start').closest('.settings-section').scrollIntoView({ block: 'start' }); 0`
  await until(`document.querySelector('[data-extension="github"]')?.classList.contains('is-changed')`, 'GitHub marked')
  await run(section)
  await t.both('settings-custom', section)
  await t.click('.extensions__start .superego-segmented__item', 'Full')
  await until(`!document.querySelector('.extensions__row.is-changed')`, 'Full again')
  // Its experimental group too, at the end.
  const last = `document.querySelector('.extensions__group:last-child').scrollIntoView({ block: 'end' }); 0`
  await run(last)
  await t.both('settings-full', last)
  await run(section)
  await t.both('settings-full-top', section)
  console.log(`extensions: done in ${process.env.SUPEREGO_SHOWCASE_OUT}`)
})
