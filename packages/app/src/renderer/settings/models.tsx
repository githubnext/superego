// Settings → a machine → Model, under its settings: the favourite models, which every model menu lists first. Dragged
// (or moved with ⌥↑ and ⌥↓ on the handle) into their order, unstarred, and added from a model menu.
import { useEffect, useState } from 'react'
import type { ModelCatalog, SectionInfo } from '@superego/protocol'
import { DotsSixVerticalIcon, IconButton, XIcon } from '@superego/ui'
import { machine as client } from '../client.ts'
import { ModelPicker, withFavourites } from '../model-picker.tsx'
import { useRegistry } from '../registry.tsx'

type Favourite = NonNullable<ModelCatalog['favourites']>[number]

export function ModelFavourites({ target, section }: { target: string; section: SectionInfo }) {
  const dispatch = useRegistry().router.dispatch
  const given = ((section.data as { favourites?: Favourite[] } | null)?.favourites) ?? []
  // Shown in the new order at once, until the daemon's comes back.
  const [order, setOrder] = useState<Favourite[]>()
  const favourites = order ?? given
  useEffect(() => setOrder(undefined), [section.data])
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [error, setError] = useState<string>()
  const [dragging, setDragging] = useState<number>()
  const [over, setOver] = useState<number>()

  // The models to add from: listed once, and again as the favourites change (a provider signed in or out, say).
  useEffect(() => {
    let live = true
    client(target).call('agent.models', {}).then((c) => { if (live) setCatalog(c) }, (e: Error) => {
      console.error(`Listing ${target}'s models failed`, e)
      if (live) setError(`Couldn't list the models: ${e.message}`)
    })
    return () => { live = false }
  }, [target, section.data])

  const save = (next: Favourite[]) => {
    setOrder(next)
    setError(undefined)
    dispatch('settings.set', { key: 'agent.favourites', value: next.map((f) => f.value) }, { machine: target, source: 'settings' }).catch((e: Error) => {
      console.error('Saving the favourites failed', e)
      setOrder(undefined)
      setError(`Couldn't save the favourites: ${e.message}`)
    })
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= favourites.length || from === to) return
    const next = [...favourites]
    next.splice(to, 0, ...next.splice(from, 1))
    save(next)
  }

  return (
    <div className="favourites">
      <div className="setting__label"><div>Favourites</div></div>
      {favourites.map((favourite, i) => (
        <div key={favourite.value} className={`favourite ${favourite.unavailable ? 'is-unavailable' : ''} ${dragging === i ? 'is-dragging' : ''} ${over === i && dragging !== i ? 'is-over' : ''}`}
          draggable onDragStart={(e) => { setDragging(i); e.dataTransfer.effectAllowed = 'move' }}
          onDragOver={(e) => { if (dragging === undefined) return; e.preventDefault(); setOver(i) }}
          onDragEnd={() => { setDragging(undefined); setOver(undefined) }}
          onDrop={(e) => { e.preventDefault(); if (dragging !== undefined) move(dragging, i); setDragging(undefined); setOver(undefined) }}>
          <button type="button" className="favourite__grip" aria-label={`Move ${favourite.label} (⌥↑ ⌥↓)`}
            onKeyDown={(e) => {
              if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
              e.preventDefault()
              move(i, i + (e.key === 'ArrowUp' ? -1 : 1))
            }}>
            <DotsSixVerticalIcon />
          </button>
          <div className="favourite__name">
            {favourite.label}
            <span className="settings__note"> · {favourite.unavailable ?? favourite.group}</span>
          </div>
          <IconButton label={`Unstar ${favourite.label}`} onClick={() => save(favourites.filter((f) => f.value !== favourite.value))}><XIcon /></IconButton>
        </div>
      ))}
      <div className="favourites__add">
        <ModelPicker label="Add a favourite" catalog={catalog && { ...catalog, favourites }} value={null}
          placeholder={catalog ? 'Add a favourite…' : error ? 'Unavailable' : 'Loading…'}
          onChange={(value) => { if (value && catalog) save(withFavourites({ ...catalog, favourites }, [...new Set([...favourites.map((f) => f.value), value])]).favourites!) }}
          onStar={(next) => { if (catalog) save(withFavourites({ ...catalog, favourites }, next).favourites!) }} />
      </div>
      {error && <div className="setting__error">{error}</div>}
    </div>
  )
}
