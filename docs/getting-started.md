# Getting started

## Install

Download the latest `Superego.zip` from [the releases](https://github.com/githubnext/superego/releases), unzip it and
move Superego to Applications. It updates itself after that.

## Set up a model

Superego needs a model provider to run agents. On first run, the main window opens on model setup, which lists what it
found on the computer:

- an API key in your environment or your shell's startup files, such as `OPENAI_API_KEY` in `~/.zshrc`;
- Ollama or LM Studio running at its default address, with its models;
- Claude Code, if it's installed and signed in. Choosing it creates a profile named `claude` whose threads run on your
  Claude Code. Superego doesn't read or store Claude Code's sign-in.

You can also connect a provider in one of these ways:

- Sign in with ChatGPT, GitHub Copilot or OpenRouter in your browser.
- Paste an API key for Anthropic, OpenAI, Google or another provider. Superego sends a test request with the key before
  saving it, so a wrong key fails at once.
- Enter the address of a local model server that speaks the OpenAI API.

Once a provider works, pick the default model and star the models you use most. Starred models come first in every
model menu. Test sends a short request and shows the reply. Start a thread opens the New thread dialog, where you pick a
folder and say what to work on.

To open setup again, use Set up models… in Settings → Providers or in ⌘K. Settings → Providers also lists every other
provider, such as Amazon Bedrock, Google Vertex AI and Azure. If a message can't be sent because no model is set up, the
message box offers Set up models… and returns you to the thread afterwards.

## Another machine

Each machine you add in Settings → Machines runs its own agents with its own providers. Open Set up models… on that
machine's page in Settings, or pick the machine at the top of setup. Setup then looks for keys, Ollama and Claude Code on
that machine.

## Next

- [Overview](overview.md) covers projects, threads, panes and the rest of the window.
- [Profiles](../packages/cli/skill/profiles.md) describes an agent as files.
- [The command](../packages/cli/skill/cli.md) covers `superego` in a terminal.
