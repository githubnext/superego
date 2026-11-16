// Settings → a machine → Profiles.
import type { SectionInfo } from '@superego/protocol'

type ProfileRow = {
  name: string; scope: 'user' | 'project'; dir: string; allowed: boolean
  description?: string; model?: string; extends?: string; extensions?: number; ui?: number; without?: string[]; error?: string
}

/** Settings → a machine → Profiles: each one, whose it is, and what it changes about the agent. */
export function Profiles({ section }: { target: string; section: SectionInfo }) {
  const profiles = (section.data ?? []) as ProfileRow[]
  if (!profiles.length) return <p className="settings__note">None yet.</p>
  return (
    <div className="profiles">
      {profiles.map((profile) => {
        // A project's lives in <project>/.superego/profiles/<name>.
        const project = profile.scope === 'project' ? profile.dir.split('/').at(-4) : undefined
        const changes = [
          profile.model,
          profile.extends && `extends ${profile.extends.replace(/^user:/, 'your ')}`,
          profile.extensions ? `${profile.extensions} extension${profile.extensions > 1 ? 's' : ''}` : undefined,
          profile.ui ? 'its own UI' : undefined,
          profile.without?.length ? `without ${profile.without.join(', ')}` : undefined,
        ].filter(Boolean)
        return (
          <div key={profile.dir} className="profile-row">
            <div className="setting__label">
              <div>{profile.name} <span className="profile-row__scope">{project ?? 'yours'}</span></div>
              {profile.description && <div className="settings__note">{profile.description}</div>}
              {changes.length > 0 && <div className="settings__note">{changes.join(' · ')}</div>}
              {profile.error && <div className="setting__error">{profile.error}</div>}
            </div>
            {!profile.allowed && <span className="settings__note" title={`superego profile allow ${profile.name}, in ${project}`}>Not allowed yet</span>}
          </div>
        )
      })}
    </div>
  )
}
