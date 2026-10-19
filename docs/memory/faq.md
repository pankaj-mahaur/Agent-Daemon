# Memory FAQ

## My agent already has memory. Why this?

Most hosts now keep some memory of their own. ad's memory differs in four ways:
- the same notes in every agent you install it in;
- corrections captured from your own words where ad's hooks run, and
  recorded by the agent elsewhere;
- what an agent records waits for your review;
- notes stay in their project.

Whether it beats a host's own memory, or writing the correction into your rules
file, is what the [correction benchmark](../../bench/correction-bench/PROTOCOL.md)
measures. No results are published yet.

## Does anything leave my computer?

The memory server sends nothing. The notes are in one SQLite file under
`~/.agent-daemon`, and the server talks only to the agent that started it. The notes it shows that
agent go wherever the agent sends its context (its model provider), like the
rest of the session. The memory package's one network step is `npx agent-daemon-memory install`
downloading the package from npm. (In full ad, the session digest's LLM
fallback sends transcript excerpts to a model, only if you turn it on.)

## Which agents does it work in?

- The installer supports Claude Code, Codex, Cursor, VS Code and Gemini CLI.
- Which of these are tested live is in the [support matrix](../support-matrix.md).
- Plugins are in [hosts and plugins](hosts.md).

## Why does the agent say memory isn't bound to a project?

The host didn't say which folder is open: some plugin installs start the
server in the plugin's own folder. The server then shows and stores nothing.
Use the installer, or open a project folder.

## Windows?

- **Supported.** Paths with spaces work, as do files with a UTF-8 byte order mark.
- **Node:** memory needs Node 22.16 or newer.
- **Desktop shortcuts:** if the host was started from one and can't find
  `node`, use the installer, which writes the full path of the Node that ran it.

## How do I remove it?

```sh
npx agent-daemon-memory uninstall                # the entries it added; your edits stay
npx agent-daemon-memory uninstall --purge-data   # also the notes
```

`--purge-data` asks you to type `delete my memory` to confirm. It keeps the notes while ad
itself is installed, since ad uses the same notes, unless you add `--force`.
