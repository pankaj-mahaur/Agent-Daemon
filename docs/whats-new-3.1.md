# What's new in 3.1

3.1 lets ad run on more than one account and provider, and keeps a task going when one of them hits its limit. It adds an early fullscreen mode for the terminal UI, puts ad's memory into other coding agents, moves ad to another computer in one file, and tightens what memory, keys and child processes can reach. Every change is listed in the [CHANGELOG](../CHANGELOG.md#310--2026-10-30).

## Fullscreen terminal UI (early)

`ad tui` can take the whole terminal instead of printing into your scrollback. Your shell's output comes back as it was when ad exits, long output re-wraps when you resize, and new output never moves a view you scrolled up.

- **Turn it on:** `/tui` and pick fullscreen (applies from the next start). `ad tui --no-alt-screen` starts inline for one run; `/status` shows the screen mode and why.
- **Scroll:** the mouse wheel, PageUp/PageDown, Ctrl+Home / Ctrl+End.
- **Select and copy:** drag, double click (a word) or triple click (a line), then Ctrl+C or Ctrl+Shift+C. A right-click copies the selection, or pastes into the prompt. This works in the Ctrl+T pager too.
- **Find:** F3 searches the whole conversation. Inline, F3 opens Find in the Ctrl+T pager.
- **Hand-offs:** the editor (Ctrl+G), `/login` and `/ad <command>` hand the terminal over and come back cleanly. On macOS and Linux, Ctrl+Z stops ad between turns and `fg` brings it back.

Details: [tui.md](tui.md).

## Several accounts, and switching between them

ad keeps a list of accounts: ChatGPT sign-ins, API keys (several per provider, each with your own label), your own endpoint, and local servers such as Ollama and LM Studio.

- **Add one:** `ad auth login openrouter` (the key is asked at a hidden prompt), `ad auth login openrouter --label work` for a second key, or `/login` inside `ad tui`.
- **Manage them:** `ad auth list`, `ad auth use <provider>/<label>` for the default, `ad auth test`, `ad auth logout` (keeps the account) and `ad auth remove` (forgets it).
- **Pick one per run:** `--account <provider>/<label>` on `ad`, `ad tui`, `ad run`, `ad chat`, `ad loop` and `ad sp`.
- **Switch mid-task:** `/model` or `/account` in `ad tui` moves the open conversation to another account at a safe point, with its history.

Keys stay out of the engine: ad's local gateway adds the key on the way out, so the engine, its hooks and the tools it runs never see it. Details: [accounts.md](accounts.md).

## More providers through the bridge

ad's gateway now translates between the engine and providers that speak only Chat Completions, and speaks the Anthropic and Gemini APIs natively, so Claude's extended thinking and Gemini's thought signatures survive tool loops. That opens up providers such as Groq, Cerebras, Mistral, DeepSeek, Together AI, Hugging Face and OpenCode Go, with free tiers marked.

- **Try it:** `ad auth login groq`, then `/model` in `ad tui` to pick one of its models.
- **See what an account offers:** `ad auth models <account>` lists models with tool support, context and price.

Details and the list of providers: [providers.md](providers.md).

## Limits you can see, and fallback when they run out

- **Limits:** the footer and `/status` show the limit closest to running out and when it resets; `ad auth list` has a limits column, and one notice per window says when 90% is used.
- **A fallback order:** `ad fallback add <account>[:<model>]` builds an order of accounts and models; `ad fallback preview` shows what would happen now. It is off until you turn it on and confirm where your data would go.
- **In `ad tui`:** a turn that fails on a used-up limit, a rate limit, the network or a provider's servers continues on the next model in your order, or pauses with the reason when it can't move safely. `/retry` tries again.
- **Unattended:** `ad run --fallback`, `ad loop --fallback`, `ad schedule add … --fallback` and `ad team set <team> fallback on` opt a run in.
- **Session record:** `ad sessions show --last` shows which account and model ran each turn and what each tool call did, never its output or your keys.

Details: [harness.md](harness.md#the-fallback-order-ad-fallback) and [commands.md](commands.md).

## Engine update

ad's engine moves to 0.163.0. Nothing changes in how you use ad. In `ad tui`, key chords and the leader key from `tui.keymap` now work (`"ctrl-x ctrl-s"`, or `"leader c"`), and `/subagents` shows each subagent's model and effort. ad also switches off the engine's analytics, feedback uploads, telemetry and update check in its own engine folders.

## Memory in other agents, over MCP

- **Install:** `npx agent-daemon-memory install` (or `ad memory install`) adds ad's memory server to the other coding agents it finds, such as Claude Code, Cursor, VS Code with Copilot and Gemini CLI ([hosts](memory/hosts.md)). It shows what it will change and asks first; `uninstall` restores the config exactly.
- **Hosts without hooks:** the agent can record a correction you just gave it; the note waits for you in `ad review` before any session sees it.
- **Is it working?** `ad memory report` shows corrections captured, repeats, and what memory showed per session.
- **Projects keep their memory when moved:** every project now has its own id, so a renamed or moved folder keeps its notes.
- **Skill changes:** accepting one in `ad review` applies it as a new version everywhere ad's memory is installed; `ad skill undo` reverses it.

Details: [memory/README.md](memory/README.md).

## Move ad to another computer

`ad state export --out ~/ad.adstate` writes one file with your memory, settings, session record and account list for the projects you choose. It never holds a key or sign-in: you sign in again on the new computer.

- **Check first:** `ad state inspect` shows what an export would hold.
- **Bring it in:** `ad state import ~/ad.adstate --dry-run` shows the plan; run it without `--dry-run` to import, then `ad review --import <id>` to accept what came in.
- **Undo:** `ad state rollback <id>`.

The `ad-state-migrate` skill walks an agent through the steps, including repeat moves on a dual boot. Details: [harness.md](harness.md#moving-ad-to-another-computer).

## Security and isolation

- **Memory stays in its project.** The memory server is bound to one project when it starts. Notes don't become global by themselves, notes the agent writes about itself wait for you, and only you, at your own terminal, can accept them (you type `accept`).
- **Instructions and secrets are kept out of memory.** A note that reads like an instruction is held back; common key and token shapes are replaced with `[redacted:…]` before anything is stored. `ad memory held` lists what waits or was held back.
- **Your own engine settings stay out of ad.** Your own `~/.codex/` skills and settings no longer load into ad's sessions.
- **No shell, no bare program names.** Every child process ad starts runs by full path with plain arguments, so a task or file name with `&`, `|` or `%VAR%` can't run commands.
- **Tools can't use the gateway's token.** Commands the agent runs can't spend your API accounts.

Details: [memory/security.md](memory/security.md), [privacy.md](privacy.md) and [SECURITY.md](../SECURITY.md).

## Upgrading from 3.0

Your accounts, conversations, memory and settings carry over; your ChatGPT sign-in and OpenRouter key become accounts by themselves. Things that behave differently:

- **Engine 0.163.0.** Going back to an ad release on engine 0.160 after 3.1 has run is not supported.
- **Home folder.** Started in your home folder while your own `~/.codex/` has skills, `ad` shows **Pick a project folder** first, `/cd` there is refused, and `ad schedule add` there needs `--allow-home-folder`. `ad run`, `ad chat` and `ad loop` still run there with a one-time note. `--allow-home-folder` or `AD_ALLOW_HOME_FOLDER=1` opens it anyway. See [harness.md](harness.md#working-in-your-home-folder).
- **`ad auth logout <label>` keeps the account.** Use `ad auth remove` to delete it.
- **Notes ad 3.0 stored as global** are now served only in the project they came from. Run `ad review --global` to decide which should apply everywhere.
- **Accepting memory needs you.** `ad review` and `ad memory promote` ask you to type `accept` in a terminal, and refuse inside an agent's shell. There is no `--yes`.
- **`/mcp`** lists the servers in ad's own engine settings; a trusted project's own servers start with its conversations.
- **`/copy`** no longer also sends the text to the terminal when your clipboard tool took it.
- **The memory package** needs Node 22.16 or newer.
- **One-time upkeep:** `ad memory migrate` gives older memory rows their project id and scrubs secrets from journals written before the filter. ad also does this on its own once; the command runs it now.
- **Fullscreen** is off by default; nothing changes until you pick it with `/tui`.

## Known limits

- **Fullscreen is early.** Ctrl+Z works only on macOS and Linux. Mouse capture is off in the old Windows console window and when tmux's mouse is off, and fullscreen stays off in Apple Terminal over SSH. If a killed ad leaves the terminal in its screen, see [troubleshooting #86](troubleshooting.md#86-ad-tui-the-terminal-is-stuck-in-ads-screen-after-a-crash).
- **Many new providers are candidates** until checked on real keys; [providers.md](providers.md) says which.
- **No HTTP proxy for API accounts yet.** ad's gateway connects to providers directly.
- **Exports aren't encrypted.** An `.adstate` file holds your memory and history as plain text; keep it on your own disk.
- **The correction benchmark has no results yet.**
