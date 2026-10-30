# Memory security

What keeps memory to the project it belongs to, what keeps an agent from
steering it, and where the limits are. The threat model behind it is in
[SECURITY.md](../../SECURITY.md).

## One project per server

- **Binding.** A memory server is bound to one project when it starts (see
  [tools](tools.md#which-project-it-serves)). No tool argument changes it, and
  an id from another project returns nothing.
- **Folders that never bind.** Home, a filesystem root, system folders and ad's
  own folders never bind. Neither does a plugin's folder (Agent Plugins hosts):
  such a server shows and stores nothing.
- **One id per project.** Each project has an id (`~/.agent-daemon/projects.json`;
  a project ad was set up in also keeps it in `.agent-daemon/project.json`, kept out
  of git), so a moved folder keeps its memory. Two folders whose paths once mapped to
  the same key (`/x/a/b` and `/x/a-b`) are told apart by id. Older notes that
  nothing ties to one of them reach neither; `ad memory assign` places one by hand,
  from your own terminal only.

## What an agent can and can't do

- **Recording.** An agent can record a correction or a learning through the
  record tools. Those notes wait for your review: until then the agent sees
  them only when it searches, marked unreviewed, and they are never shown at
  session start.
- **Accepting.** Accepting a note needs a typed confirmation in a real
  terminal. It is refused in an agent's own shell and without a terminal, and
  there is no `--yes`.
- **Instructions.** A note that reads like an instruction (to run something,
  change settings or ignore earlier instructions) is withheld everywhere memory
  is shown. Every result is headed as data, not instructions.
- **Held notes.** A note the agent wrote about itself waits as *pending*, and a
  note the injection screen or the secret check flags is held back as
  *quarantined*; neither reaches a session. `ad memory held` lists them (this
  project, or `--all-projects`); `ad memory held accept|release|drop <id>` runs
  only in your own terminal and asks you to type the id. A note holding a secret
  can be dropped, never released.
- **Nothing goes global by itself.** A note that sounds global stays in its
  project, marked for promotion, until you decide in `ad review`.
  `ad memory promote fact:<id>` makes a user fact apply everywhere, typed, in
  your own terminal.
- **Feedback.** It changes how notes rank in the project that gave it, never in
  another.

## Secrets

Common secret shapes are replaced with `[redacted:<kind>]` before the capture
journal, memory or memory files see them:
- provider keys and tokens;
- private keys and JWTs;
- `user:pass@` URLs, Bearer and Basic headers;
- passwords assigned to a secret-looking name.

`ad memory scan` checks older notes once. `ad memory redact <table>:<id>` replaces
what looks like a key in one row, from your own terminal, after you type the row.

## No network, no telemetry

- **No network.** The server speaks MCP over stdio to the agent that started
  it. It opens no port and sends nothing anywhere. In full ad, only the session
  digest's LLM fallback sends anything (transcript excerpts, to a model), and
  only if you turn it on.
- **No telemetry.** `ad memory report --share` prints numbers for you to copy;
  it sends nothing.

## Supply chain

- **The npm package:**
  - has exact dependency pins and no install scripts;
  - publishes from CI with npm provenance, only when the owner dispatches the
    release workflow.
- **Plugins** carry their server with no dependencies to install.
- **Release artifacts** come with `SHA256SUMS`.

## Backups and removal

- **Backups.** The installer backs up every file it edits before the first
  change, keeps a ledger of what it wrote, and on uninstall restores files it
  didn't otherwise touch byte for byte.
- **Your edits.** An entry you changed by hand is left alone.
- **Removing everything.** `npx agent-daemon-memory uninstall --purge-data`
  also removes the notes:
  - after you type `delete my memory`;
  - not while ad itself is installed, since ad uses the same notes, unless you
    add `--force`.
