# Getting started

## Install

Download the latest `Superego.zip` from [the releases](https://github.com/githubnext/superego/releases), unzip it and
move Superego to Applications. It updates itself from then on.

## A model to think with

Superego runs agents on a model you bring. The first time it opens, it shows **Who does the thinking?**, with what it
found on this computer and the other ways in:

- **Found on this computer**
  - an API key in your environment or your shell's startup files (`OPENAI_API_KEY` in `~/.zshrc`, say);
  - Ollama or LM Studio running at its usual address, with the models it has;
  - Claude Code, installed and signed in. Using it makes a profile named `claude` whose threads run on your Claude Code,
    with its own sign-in (Superego never sees it).
- **Sign in with ChatGPT**, **GitHub Copilot** or **OpenRouter**, in your browser.
- **Paste an API key**: Anthropic, OpenAI, Google and others. The key is tried before it's kept, so a mistyped one says
  so at once.
- **A local model**: any OpenAI-compatible server, by its address.

Once one works, pick the default model, star a few (they come first in every model menu), and **Say hi** to see it
answer. Then **Start a thread**: pick a folder, say what to work on.

Open it again any time with **Set up models…**, in Settings → This computer (or a machine's page) or in ⌘K. Every
other provider (Amazon Bedrock, Google Vertex AI, Azure and some forty more) is in Settings → Providers. When a message
can't be sent because no model is set up, the message box says so, with a way to set one up and come back.

## Another machine

A machine you add in Settings → Machines (over ssh) runs its own agents with its own models: open **Set up models…** on
its page in Settings, or pick it at the top of setup. What setup finds there is that machine's: its keys, its Ollama, its
Claude Code.

## Next

- [Overview](overview.md): projects, threads, panes and the rest of the window.
- [Profiles](../packages/cli/skill/profiles.md): what an agent is, as files.
- [The command](../packages/cli/skill/cli.md): `superego` from a terminal.
