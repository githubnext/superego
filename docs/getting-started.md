# Getting started

## Install

Download the latest `Superego.zip` from [the releases](https://github.com/githubnext/superego/releases), unzip it and
move Superego to Applications. It updates itself after that.

## Set up a model

Superego needs a model to run agents. On first run, the main window opens on model setup at once. If the computer
already has a model that can run, such as a key in your environment, setup opens on it and sends it a short test
request: setup counts as done once it answers, and says why if it doesn't (a revoked key, say). Otherwise setup lists
what it found on the computer:

- an API key in your environment or your shell's startup files, such as `OPENAI_API_KEY` in `~/.zshrc`;
- Ollama or LM Studio running at its default address, with its models;
- Claude Code, if it's installed and signed in (experimental). Choosing it makes Claude Code the default for new
  threads, except in a project with a default profile of its own: they run on your Claude Code with a profile named
  `claude`. Superego doesn't read or store Claude Code's sign-in. If it isn't signed in yet, run `claude`, then
  `/login`, and choose Check again. If Claude Code is later signed out or uninstalled, New thread says so and offers
  Set up models… rather than starting on another provider.

You can also connect one of these ways. Each says what it needs:

- Sign in with ChatGPT (your ChatGPT plan), GitHub Copilot (your Copilot plan) or OpenRouter (pay as you go) in your
  browser. Copilot signs in to github.com; for GitHub Enterprise, choose Signing in to GitHub Enterprise? under it and
  enter its address.
- Paste an API key, or a line from your shell's startup file such as `export OPENAI_API_KEY="sk-…"`. Setup tells
  whose key it is from the key itself, and asks only when it can't. Superego sends a test request with the key before
  saving it, so a wrong key fails at once; cancelling stops the test and saves nothing. A Claude subscription token
  (`sk-ant-oat…`) isn't an API key: setup says so.
- Enter the address of a local model server that speaks the OpenAI API, such as `localhost:11434`.
- More providers lists every other provider, such as Amazon Bedrock, Google Vertex AI and Azure, and lets you add an
  OpenAI-compatible endpoint of your own.

Once a provider works, setup makes its recommended model the default and sends a short test request. Pick another
default if you like, and star the models you use most: starred models come first in every model menu. Start a thread
opens the New thread dialog, where you pick a folder and say what to work on.

To open setup again, use Set up models… in Settings → Providers or in ⌘K. If a message can't be sent because no model
is set up, the message box offers Set up models… and returns you to the thread afterwards.

### On another machine

Each machine you add in Settings → Machines runs its own agents with its own providers. Open Set up models… on that
machine's page in Settings, or pick the machine at the top of setup. Setup then looks for keys, Ollama and Claude Code on
that machine. Signing in in your browser works the same: the app catches the browser's return on this computer and
passes it on. If it doesn't, open Browser didn't come back? and paste the address the browser ended on.

## Your first thread

New thread (`⌘N`) asks for a machine, a folder, a profile and a model, and what to work on. The thread keeps working
when you close the window or quit the app: the daemon runs it. The sidebar shows each thread's status, and `⌘U` lists
what finished, failed or needs you.

In a git repository, tick In a worktree of its own and the thread works on a new branch in a worktree, apart from your
checkout.

## Next

- [Overview](overview.md): projects, threads, panes, Ego and the keys.
- [Machines](machines.md): agents on other computers, and the app on a phone.
- [The command](../packages/cli/skill/cli.md): `superego` in a terminal.
- [Profiles](../packages/cli/skill/profiles.md): an agent as files, in your home or in a project.
- [Claude Agent](claude-agent.md): threads that run your own Claude Code.
