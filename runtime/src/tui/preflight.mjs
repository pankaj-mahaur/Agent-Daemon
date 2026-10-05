// Whether the terminal UI can run here (plan D7), with a working
// alternative when it can't. Light: the launcher imports it for bare `ad`.

/** Why `ad tui` can't run here, or null. */
export function preflight({ stdin = process.stdin, stdout = process.stdout, platform = process.platform, version = process.versions.node, env = process.env } = {}) {
  if (!stdin.isTTY || !stdout.isTTY) return "ad tui needs an interactive terminal. Use `ad chat` for pipes and scripts.";
  if (env.TERM === "dumb") return "This terminal (TERM=dumb) can't show the UI. Use `ad chat`.";
  const [major, minor] = version.split(".").map(Number);
  if (platform === "win32" && !((major === 22 && minor >= 17) || (major === 24 && minor >= 2) || major >= 25)) {
    return `ad tui needs Node 22.17+ or 24.2+ on Windows (this is ${version}): older versions turn a multi-line paste into one message per line. Upgrade Node within 22.x, or use \`ad chat\`.`;
  }
  if (platform === "win32" && env.TERM_PROGRAM === "mintty") return "mintty (Git Bash's window) can't pass keys to ad. Run `winpty ad tui`, or use Windows Terminal.";
  return null;
}
