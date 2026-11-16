// The words ad's self-protection acts on (MCP launch plan L7, D12), shared by the check
// (hooks/self-protect.mjs) and its fast path in tool-before.mjs, so a word the check knows
// always loads it. Data only: the fast path imports this on every tool call.

import { ENTRY_NAMES } from "../rules/neutral.mjs";

export { ENTRY_NAMES };

/** ad's verbs and subcommands that matter to the check (any of them loads it). */
export const VERB_WORDS = ["review", "rules", "safety", "learning", "learnings", "setup", "install", "repair", "uninstall", "config", "consolidate", "memory", "remember", "forget", "restore", "tui", "init", "held", "promote", "redact", "assign", "migrate", "hook", "session-start", "user-prompt-extract", "query-retrieve", "bash-pre", "bash-post", "edit-post", "mcp-pre", "session-end-digest", "skill-use", "capability-route-advice", "mistakes", "schedule", "loop"];

/** Programs that run another program later, elsewhere or under a pseudo-terminal. */
export const REPARENTING = ["script", "expect", "unbuffer", "winpty", "socat", "setsid", "nohup", "daemonize", "systemd-run", "at", "batch", "start", "start-process", "saps", "schtasks", "launchctl", "ssh", "screen", "tmux", "zellij", "disown", "coproc", "start-job", "start-threadjob", "watch", "nodemon", "concurrently", "entr", "parallel"];

/** Terminal emulators: starting one starts a program in the user's desktop session. */
export const TERMINALS = ["gnome-terminal", "konsole", "xterm", "alacritty", "foot", "tilix", "terminator", "xfce4-terminal", "mate-terminal", "lxterminal", "urxvt", "rxvt", "ptyxis", "kgx", "ghostty", "wt", "kitty", "kitten", "wezterm", "iterm", "warp", "x-terminal-emulator", "st", "cool-retro-term"];

/** Desktop launchers and remote-input tools. */
export const DESKTOP = ["uwsm", "uwsm-app", "osascript", "open", "explorer", "invoke-item", "ii", "rundll32", "mshta", "gtk-launch", "gio", "xdg-open", "hyprctl", "swaymsg", "i3-msg", "niri", "dbus-send", "qdbus", "xdotool", "ydotool", "wtype", "dotool"];

/** ad's own internal entry files. */
export const INTERNAL_FILES = ["guards-refresh-job.mjs", "migrate-job.mjs", "recall-context-job.mjs", "hook.mjs", "run.mjs", "cli.mjs", "cli-full.mjs"];

/** Nested agents. */
export const AGENTS = ["claude", "codex", "claude-code"];

/** Programs that run code given inline (a verb inside their code runs through them). */
export const INTERPRETERS = ["node", "nodejs", "bun", "deno", "python", "python3", "python2", "perl", "ruby", "php", "lua", "vim", "nvim", "vi", "git", "fish", "tcsh", "csh", "zsh", "bash", "sh", "dash", "ksh", "pwsh", "powershell", "cmd", "eval", "source", "iex", "invoke-expression", "set-alias", "sal", "new-alias", "nal", "xargs", "parallel", "env", "unset", "setx", "setenv", "unsetenv", "declare", "typeset", "export", "printf", "read", "mapfile", "readarray", "base64", "certutil"];

/** Variables an ad command's code or settings depend on (D12e), and the nested agents' homes. */
export const ENV_NAMES = ["AD_TOOL_SHELL", "AD_MEMORY_DB", "AD_ROOT", "AD_", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PSModulePath", "COR_PROFILER", "COR_ENABLE_PROFILING", "CORECLR_", "SystemRoot", "windir", "XDG_CONFIG_HOME", "USERPROFILE", "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_ENV_FILE"];

/** Other words that mean the text may need the check. */
export const OTHER_TRIGGERS = [".agent-daemon", "agent-~", "session-env", "disableAllHooks", "pty", "EncodedCommand", "enc", "ec", "base64", "SendKeys", "WScript", "AppActivate", "ShellWindows", "Start-Process", "Get-Command", "gcm", "scriptblock", "kitten"];
