# threads-sidebar: data manifest

| Element | Field | Class | Note |
|---|---|---|---|
| Row title, status glyph | `SessionInfo.title`, `.status.state` | ✅ Real | |
| Machine grouping, offline label | `MachineEntry.label`, `.state` | ✅ Real | |
| Status groups (B) | `status.state` | ✅ Real | derived |
| Relative time (A, B) | `SessionInfo.createdAt` | ⚠️ Sometimes | creation time only; "recently active" needs last activity ❌ |
| Rail tooltip (C) | title + status | ✅ Real | |
| Crumb, title, transcript, tool steps, question | session view, `ask-user.pending` | ✅ Real | |
| Model (D) | `pi.agent` doc | ❌ Aspirational | stored per conversation, not sent to clients |
| Cost (D) | `pi.usage` doc | ❌ Aspirational | exists in the daemon, not sent |
| Started (D) | `createdAt` | ✅ Real | |
| Tool counts, files touched (D) | derived from tool calls | ❌ Aspirational | derivable from the transcript |
| Persisted sort / view | — | ❌ Aspirational | UI halves can't register settings yet |
