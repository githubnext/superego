# Getting started

## Install

Download `Superego.zip` from [the releases](https://github.com/githubnext/superego/releases), unzip it and move
Superego to Applications. It updates itself after that.

## Set up a model

The first window opens on model setup. If the computer already has a working model (a key in your environment, say),
setup sends it a test request and is done once it answers, or says why it didn't. Otherwise it lists what it found:

- an API key in your environment or shell startup files (`OPENAI_API_KEY` in `~/.zshrc`);
- Ollama or LM Studio at its default address;
- Claude Code, installed and signed in (experimental). Choosing it makes Claude Code the default for new threads, on a
  profile named `claude`, except in a project with a default profile of its own. Not signed in yet: run `claude`, then
  `/login`, and choose Check again.

Or connect another way:

| Choose | Needs |
|---|---|
| Sign in with ChatGPT, GitHub Copilot or OpenRouter | your browser. For GitHub Enterprise, choose Signing in to GitHub Enterprise? and enter its address |
| Paste an API key | a key, or a shell line like `export OPENAI_API_KEY="sk-…"`. It's tested before it's saved. A Claude subscription token (`sk-ant-oat…`) isn't an API key |
| A local model server | its address, speaking the OpenAI API (`localhost:11434`) |
| More providers | Amazon Bedrock, Google Vertex AI, Azure, the rest, or an OpenAI-compatible endpoint of your own |

Once a provider works, its recommended model becomes the default. Star the models you use most: they come first in
every model menu.

Below the model, setup introduces Ego, the agent that builds tools, panes and boards for you (Open Ego, or its circle at
the top of the rail), and lists the extensions with a switch each. Change them later in Settings → Extensions.

To open setup again: Set up models… in Settings → Providers or `⌘K`. A message that can't be sent for want of a model
offers it too.

### On another machine

Each machine in Settings → Machines has its own providers. Open Set up models… on its page, or pick the machine at the
top of setup. Browser sign-in works the same; if the browser doesn't come back, open Browser didn't come back? and
paste the address it ended on.

## Your first thread

New thread (`⌘N`): pick a machine, a folder, a profile and a model, and say what to work on. The daemon runs the thread,
so it keeps working when you close the window or quit. The sidebar shows each thread's status; `⌘U` lists what
finished, failed or needs you.

In a git repository, tick In a worktree of its own to work on a new branch, apart from your checkout.

## Next

- [Overview](overview.md): projects, threads, panes, Ego and the keys.
- [Machines](machines.md): other computers, and the app on a phone.
- [The command](../packages/cli/skill/cli.md): `superego` in a terminal.
- [Profiles](../packages/cli/skill/profiles.md): an agent as files.
- [Claude Agent](claude-agent.md): threads on your own Claude Code.
