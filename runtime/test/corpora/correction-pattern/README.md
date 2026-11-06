# Correction → pattern corpus (v1)

Held-out corpus for offline pattern derivation (plan part L4c). Each item is a developer's correction to a coding agent. The derivation must produce either a rule that can be enforced on a tool call or "not a rule", meaning a reminder that is recalled but cannot be enforced.

## Provenance

- **Written by** a clean-room agent: Claude Opus 5.5 (`claude-opus-5-5`), running as a subagent in Claude Code, on **1 Nov 2026**. This follows plan decision D29: the implementer must not grade itself.
- **Read (read-only):**
  - `docs/plans/mcp-platform/04-PARTS.md` L4c and L7;
  - `docs/plans/mcp-platform/02-ARCHITECTURE.md` §2.2 and §3;
  - the brief from the plan owner (the neutral rule schema).
- **Not read:**
  - `runtime/src`, `runtime/scripts`, `runtime/test` (except this folder and `../guards/`);
  - `hooks/`, `adapters/`, `packages/`, `bench/`, `skills/`, `mcp/`, `plugins/`, `docs/` (beyond the plan sections above);
  - the other corpus folders.

  No grep of the repo was done.
- **Corrections are invented.** They involve no real people, repositories or secrets. Package ids such as `Contoso.DevTool` and hosts such as `registry.example.com` are fictional.
- **Self-check:** a throwaway reference check, outside the repo and not the product's matcher, confirmed that every `expected` rule matches all of its `block` examples and none of its `allow` examples. It also checked that every line parses and that the counts below hold.

## Files and counts

| File | Items | Rules | Command | Write | Not a rule | Hinglish |
|---|---|---|---|---|---|---|
| `correction-pattern.jsonl` | **71** | 44 | 33 | 11 | **27 (38 %)** | **11 (15.5 %)** |
| `ambiguous.jsonl` | 11 (not gated) | 8 | 6 | 2 | 3 | 1 |

Gate (04-PARTS L4c): derivation accuracy **≥ 0.8**, meaning at least 57 of 71 correct.

## Schema and scoring

```
{"id":"cp-001","correction":"…","expected":{"type":"command",…}|{"type":"write",…}|{"type":"not-a-rule"},
 "examples":{"block":[…],"allow":[…]},"lang":"en"|"hinglish","note":"optional"}
```

`ambiguous.jsonl` has the same fields plus `"why"`.

- **Examples:**
  - command examples are `{"tool":"Bash"|"PowerShell"|"shell","command":"…"}`;
  - write examples are `{"tool":"Write"|"Edit","file_path":"…"}` or `{"tool":"apply_patch","patch":"…"}`;
  - write paths are **relative to the project root**;
  - PowerShell examples and `cmd /c` examples run on Windows, which matters for case-insensitive matching.
- **Scoring:** a derivation is correct when two things hold:
  - it gets rule vs not-a-rule right;
  - for a rule, its pattern matches **every** `block` example and **no** `allow` example, when run through the product's matcher.

  The `expected` rule is one correct answer, not the only one. Wider alias lists, or adding `destroy` to a `terraform apply` rule, still score as correct as long as the examples hold.
- **Rule items** have 1–4 block examples and 2–4 allow examples. Not-a-rule items have empty lists.
- **Uncertain cases are kept out of the lists.** Where the user's intent is unclear for a given call, that call is in neither list, and the `note` says so. Examples: `npm run` for "use pnpm", `--force-with-lease` for "never force push", `.env.example` for ".env files are mine".

## Labels

- **command rule:** the correction names a program, verb or flag that can be checked on a Bash, PowerShell or Codex shell call.
- **write rule:** the correction names files or folders the agent must not write through Write, Edit or `apply_patch`.
- **not-a-rule:** the correction is about any of the following, none of which a single tool call can show:
  - code or message content;
  - conversation style;
  - an obligation to do something afterwards;
  - a one-off situation;
  - something too vague to act on.

## Coverage

| Category | Items |
|---|---|
| Package managers | cp-001 npm→pnpm, cp-003 yarn, cp-005 pip→uv, cp-036 npm publish, cp-050 global installs, cp-060 `npm audit fix --force` |
| Test runners | cp-006 jest→vitest, cp-045 cargo test→nextest |
| Formatters and linters | cp-026 prettier→biome, cp-029 black→ruff, cp-039 `eslint --fix` |
| Git habits | cp-008 push to main, cp-009 amend, cp-011 force push, cp-024 `--no-verify`, cp-027 `reset --hard`, cp-046 `clean -fdx`, cp-054 push tags |
| Protected paths (write) | cp-012 `src/gen`, cp-014 lockfile, cp-015 `vendor/`, cp-017 `.github/workflows`, cp-040 `.env*`, cp-042 snapshots, cp-043 `go.sum`, cp-057 `infra/prod`, cp-059 CHANGELOG, cp-063 `proto/`, cp-065 `.csproj`/`.sln` |
| Dangerous commands | cp-023 `rm -rf`, cp-048 `prisma migrate`, cp-053 `chmod 777` |
| Docker, kubectl, terraform, helm | cp-018 terraform apply, cp-020 kubectl delete, cp-021 docker-compose v1, cp-037 docker push, cp-051 docker system prune, cp-062 helm uninstall |
| Windows tools | cp-030 `Remove-Item -Recurse`, cp-031 `Set-ExecutionPolicy`, cp-033 winget, cp-034 `reg add/delete`, cp-056 cmd `del /s`, cp-066 choco |
| Not a rule: content and code style | cp-010, 016, 022, 025, 032, 035, 041, 047, 052, 067, 068, 069, 071 |
| Not a rule: commit-message text | cp-002, 044, 049 |
| Not a rule: conversation and process | cp-004, 013, 019, 028, 038, 070 |
| Not a rule: obligation after an action | cp-007, 055 |
| Not a rule: one-off situation | cp-058, 061 |
| Not a rule: too vague | cp-064 |

The examples use every tool: Bash, PowerShell, Codex `shell`, Write, Edit and `apply_patch` (Add, Update and Delete).

## Known gaps and judgment calls (for the plan owner)

1. **"never push to main directly" (cp-008)** becomes a rule that asks before every `git push`, because the neutral schema has no branch field. Feature-branch pushes are in neither list. L7's branch-aware rules would narrow it.
2. **"don't amend pushed commits" (cp-009)** asks before every `--amend`. "Pushed" cannot be seen on the call.
3. **"use pnpm" (cp-001) leaves out `npm run`.** L4c's own example derivation includes `run`, but that is a product choice, not something the correction states. It is in neither list here; see cx-008.
4. **"docker system prune" (cp-051)** can only target `system`, because `prune` is the second positional. The rule therefore also asks before `docker system df`.
5. **"chmod 777" (cp-053)** puts the mode in the `subcommands` slot, because it is the first non-option argument. It is a legitimate but unusual use of the schema.
6. **Things the schema cannot express**, all in `ambiguous.jsonl`:
   - argument values (cx-003 `--context prod`, cx-006 package name, cx-010 script name);
   - create vs edit (cx-001, append-only migrations);
   - wrapper programs as targets (cx-002 `sudo`, which normalisation strips);
   - time (cx-009);
   - cwd (cx-004);
   - pipe shape (cx-011 `curl | sh`, which fits the L7b starter policy better).

   These are schema limits rather than derivation errors. cx-001 and cx-010 deliberately fail their own allow example to show the limit.
7. **"Hinglish"** means romanised Hindi–English as typed in chat, with no Devanagari.

Frozen: do not edit; changes need a new corpus version and a new hash.
