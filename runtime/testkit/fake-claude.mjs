// A stand-in for the `claude` CLI in installer tests: `claude mcp add|get|remove`
// against a JSON registry (FAKE_CLAUDE_STATE), every argv appended to
// FAKE_CLAUDE_LOG. It never touches a real Claude Code file.
import fs from "node:fs";

const [, , ...argv] = process.argv;
const state = process.env.FAKE_CLAUDE_STATE;
const log = process.env.FAKE_CLAUDE_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(argv) + "\n");
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(state, "utf8"));
  } catch {
    return {};
  }
};
const write = (s) => fs.writeFileSync(state, JSON.stringify(s));

if (argv[0] !== "mcp") process.exit(2);
const reg = read();
if (argv[1] === "add") {
  const dash = argv.indexOf("--");
  const name = argv[dash - 1];
  if (reg[name]) {
    console.error(`MCP server ${name} already exists in user config`);
    process.exit(1);
  }
  reg[name] = { command: argv[dash + 1], args: argv.slice(dash + 2) };
  write(reg);
  console.log(`Added stdio MCP server ${name} with command: ${argv.slice(dash + 1).join(" ")} to user config`);
  process.exit(0);
}
if (argv[1] === "get") {
  // FAKE_CLAUDE_GET_FAIL: a broken ~/.claude.json; FAKE_CLAUDE_OTHER_SCOPE: a same-named
  // entry in another scope, which wins over the user scope (local > project > user).
  if (process.env.FAKE_CLAUDE_GET_FAIL) {
    console.error("Error: Unexpected token in ~/.claude.json");
    process.exit(1);
  }
  if (process.env.FAKE_CLAUDE_OTHER_SCOPE) {
    console.log(`${argv[2]}:\n  Scope: ${process.env.FAKE_CLAUDE_OTHER_SCOPE[0].toUpperCase()}${process.env.FAKE_CLAUDE_OTHER_SCOPE.slice(1)} config\n  Type: stdio\n  Command: theirs`);
    process.exit(0);
  }
  const s = reg[argv[2]];
  if (!s) {
    console.error(`No MCP server found with name: ${argv[2]}`);
    process.exit(1);
  }
  console.log(`${argv[2]}:\n  Scope: User config\n  Type: stdio\n  Command: ${s.command}\n  Args: ${s.args.join(" ")}`);
  process.exit(0);
}
if (argv[1] === "remove") {
  const name = argv[argv.length - 1];
  if (!reg[name]) {
    console.error(`No user-scoped MCP server found with name: ${name}`);
    process.exit(1);
  }
  delete reg[name];
  write(reg);
  console.log(`Removed MCP server ${name} from user config`);
  process.exit(0);
}
process.exit(2);
