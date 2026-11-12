# main-window: data manifest

Counted against `~/.superego` (1 session) and the protocol's `SessionInfo`, `ConversationView` and live docs.

| Element | Field | Class | Note |
|---|---|---|---|
| Session title | `SessionInfo.title` | ✅ Real | from the first message |
| Status glyph | `SessionInfo.status.state` | ✅ Real | idle · working · done · blocked · error |
| Folder | `SessionInfo.cwd` | ✅ Real | shown shortened (`~/dev/gh/superego`) |
| Machine and offline state | `MachineEntry.label/state` | ✅ Real | |
| Transcript text, tool name, arguments, output | `ConversationView.entries`, `pi.live.tools` | ✅ Real | |
| Exit code | bash tool result | ⚠️ Sometimes | bash only; other tools have none |
| Ask-user question and options | `ask-user.pending` value | ✅ Real | with the extension |
| Relative time in the sidebar (A, C) | `createdAt` | ⚠️ Sometimes | creation time only; "last activity" ❌ isn't tracked |
| Per-turn times (B, C) | entry timestamps | ❌ Aspirational | entries carry no time in the view; derivable from pi-ai message timestamps |
| Tool durations (B) | — | ❌ Aspirational | not recorded |
| Model in header/chips (A, B, C) | `pi.agent` doc | ❌ Aspirational | stored per conversation, not in `SessionInfo` |
| Cost (C) | `pi.usage` doc | ❌ Aspirational | exists in the daemon, not surfaced |
| Files touched (C) | derived from read/write/edit calls | ❌ Aspirational | derivable from the transcript |
| Status groups (C) | `status.state` | ✅ Real | derived |
| ⌘K session switcher (D) | — | ❌ Aspirational | no command palette yet |
