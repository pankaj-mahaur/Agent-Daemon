# Agent Daemon memory

Your coding agent forgets a correction as soon as the session ends. ad's memory
keeps it: the corrections you give, and the facts a project needs, come back in
later sessions and in the other agents you install it in. It runs on your
computer, in one SQLite file, with no account.

## Quick start

```sh
npx agent-daemon-memory install
```

It finds your agents, shows what it will change, and asks first. Restart them
afterwards. Details and every option: [install](install.md).

## How it works

1. **Capture.** A correction you give ("no, we use pnpm here") is captured by
   ad's hooks where the host has them, or recorded by the agent through the
   memory tools where it doesn't.
2. **Review.**
   - Corrections ad's hooks capture from your own words apply right away.
   - Everything an agent records through the memory tools waits for your
     review (`ad review`, or `npx agent-daemon-memory review`): its own notes,
     and your corrections on hosts without ad's hooks. Until then the agent sees
     them only when it searches, marked unreviewed, and they are never shown at
     session start.
   - Notes from one project are never served in another unless you accept
     them as cross-project.
3. **Recall.** At session start, with each prompt, or when the agent searches,
   the relevant notes come back. They reach the agent as notes, not
   instructions.

## Where things live

- **The notes:** `~/.agent-daemon/episodic.db` (or `$AD_ROOT/episodic.db`).
- **Capture files:** projects without `ad init` keep theirs in
  `~/.agent-daemon/projects/<project>/`, so your repositories get no new folder.
- **The memory server sends nothing anywhere.** There is no telemetry, and it
  only talks to the agent that started it, over stdio. (Full ad's session digest
  can send transcript excerpts to a model, but only if you turn on its LLM
  fallback.) The notes it shows that agent
  go wherever the agent sends its context, as anything else in the session does.

## Pages

| Page | What |
|---|---|
| [install](install.md) | The installer, the hosts it supports, doctor, uninstall |
| [hosts and plugins](hosts.md) | Each host's plugin route, and when to use the installer instead |
| [tools](tools.md) | Every memory tool, which project the server serves, protocol versions |
| [security](security.md) | What keeps notes in their project, and the limits |
| [metrics](metrics.md) | `ad memory report`: is memory working here? |
| [FAQ](faq.md) | Common questions |
| [support matrix](../support-matrix.md) | Which hosts are tested live |
