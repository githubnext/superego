# First run today: what a new user meets

Walked 2026-07 on `main` at cd939e86: the built app, a fresh empty `SUPEREGO_HOME`, every `*_API_KEY`/`*_TOKEN` unset,
1100×760. Screenshots in `onboarding-today/` (dark, as the system was).

## The walk

1. **First launch** (`01-first-launch`). "Welcome to Superego", then Ego's pitch ("Tell Ego what you want — a tool, a
   pane, a board — and it builds it for you", with **Open Ego**), then 13 extension switches, then **Get started**.
   Nothing says a model is needed, or that there isn't one.
2. **Get started** (`02`). The page goes for good on this machine. "Select or start a thread." Sidebar: "Start a thread
   in a folder to see its project here."
3. **⌘N.** Model says **Default**, Thinking says **Not offered**: no sign that there's no model. The model menu lists
   only "Default". **Start** with "Say hi" (`05`): the dialog says "No model is set up on This computer." with
   **Open Settings** — but the thread has already been made: after Escape, an empty "New thread" sits in the sidebar
   under the home folder (`06`).
4. **Ego** (the rail's first button, breathing while the welcome page shows). Opens an empty thread whose breadcrumb is
   the data folder's name (`tmp.…`, `.superego` for real). Sending "Help me set up a model" (`08`): "No model is set up
   on This computer." + **Open Settings** under the composer. The one agent built to help with setup can't, and the
   welcome page sent the user there first.
5. **Settings** opens on **General**, not where models are. **This computer** (`10`): Model "Automatic (sign in to a
   provider)", Favourite models (empty), then Providers: a sentence of two long file paths first, then a search field
   and **45 providers alphabetically** — Amazon Bedrock, Ant Ling, Anthropic, Azure, Baseten… (`11`). "Sign in with
   ChatGPT" is a button on the **OpenAI** row, two thirds down; **OpenRouter** further; **GitHub Copilot**'s button says
   only "Sign in". Nothing explains which to pick.
6. **An API key** (Anthropic, `21`): API key… opens a password field in the row; Enter → "Signing in to Anthropic ·
   Signed in." **for a made-up key**. Nothing checks it. The default model silently becomes Claude Opus 5.5, and it's
   starred as a favourite.
7. **First real turn with that key** (`24`): the thread waits, "Anthropic rejected the API key. It goes on once you sign
   in again. **Sign in again**", a key badge in the rail, "Sign in" on the sidebar row and in the title bar. Clear, but
   it's the first moment the user learns the key was wrong, and it's in a thread they meant to work in.
8. **A key in the environment** (`GROQ_API_KEY` set when launched): Groq shows as up ("API key · GROQ_API_KEY") and the
   machine just works. But the app reads only its own process environment: **launched from the Dock or Finder, a key
   exported in `~/.zshrc` isn't seen**. (Claude Agent already asks the login shell for its PATH; nothing does that for
   keys.)
9. **A local model.** No detection. Ollama/LM Studio mean **Add a provider…** and knowing the `/v1` base URL; "List
   models" then works.
10. **Claude Code.** Only by writing `~/.superego/profiles/<name>/profile.ts` with `agent: 'claude-agent'` by hand. The
    extension's switch on the welcome page is the only mention ("Runs your Claude Code, in threads whose profile picks
    it (agent: 'claude-a…", cut off). `claude auth status` (with Anthropic variables stripped, as the extension does)
    says whether it's signed in, without touching its credentials.

## Dead ends and confusing moments

- The first screen is about **extensions and Ego**, not about the one thing that blocks everything: a model.
- **Ego can't help with setup**: it needs a model to talk. The welcome page sends people to it first.
- **No model looks like a model**: "Default" / "Not offered" in ⌘N, "Automatic (sign in to a provider)" in Settings.
- **⌘N makes a thread and then fails**, leaving an empty thread behind.
- The error everywhere is the same: "No model is set up on This computer. **Open Settings**" — which lands on General.
- **45 providers, alphabetical**, with the common paths (ChatGPT, Copilot, OpenRouter, Anthropic key) buried by name.
- **Keys aren't tested**: "Signed in." for anything; the failure shows up mid-work.
- **Shell keys are invisible** to a Dock-launched app.
- **Local models and Claude Code** have no way in short of config knowledge.
- Nothing ends in "now start a thread in a folder".
