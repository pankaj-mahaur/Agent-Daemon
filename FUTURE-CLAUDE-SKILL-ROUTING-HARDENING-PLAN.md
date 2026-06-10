# Future Claude Skill Routing Hardening Plan

## Status

Deferred plan only. No runtime, hook, settings, memory, or installed skill changes are part of this document.

## Observed Behavior

Fresh Claude validation on 2026-05-25 confirmed Agent Daemon hooks are healthy, but skill selection is not guaranteed:

- A prompt such as `check the seo of this site` caused Claude to run its native `Explore` agent path instead of invoking the installed `review-slice` skill.
- An explicit request to deploy two sub-agents correctly caused native background agents to run; this should not be treated as a routing failure.
- The managed `CLAUDE.md` block tells Claude to invoke `review-slice` for audit/review prompts, but this is instruction-only guidance. Current hooks observe skill calls after Claude chooses them; they do not enforce or recommend a matching skill at prompt time.
- The debug log showed Claude loading skills from `~/.claude/skills/`, then issuing an `Agent` tool call with `subagent_type: Explore`. No `Skill(review-slice)` event occurred for the SEO audit.
- The same startup log reported YAML frontmatter parse warnings for installed `session-close` and `seed-data` skills. Their unquoted `description:` values include YAML-significant punctuation such as `:`, so Claude may omit or degrade those skills even though Agent Daemon's current lightweight linter passes them.

## Goal

Make Claude first classify the size/risk of the user's request, then choose proportionate execution:

- Simple, low-risk work should proceed normally without skill-routing ceremony.
- Substantial, specialized, risky, or repeated work should trigger a brief capability check for relevant skills, plugins, MCP servers, memory, or native agents before execution.
- High-confidence Agent Daemon skill intents should route predictably while preserving Claude's native agents when the user explicitly requests agents or parallel workers.

## Non-Goals

- Do not force every exploration task through a skill.
- Do not add noticeable routing overhead to greetings, simple questions, or trivial one-line actions.
- Do not replace explicit user requests to launch sub-agents.
- Do not add Cursor or Codex routing behavior.
- Do not require an API key, deployed model, or external service.
- Do not auto-accept GEPA skill updates.

## Proposed Changes

### 1. Add A Task-Complexity Gate To Managed CLAUDE.md

Update the generated managed `CLAUDE.md` block so Claude applies a short decision gate before beginning work.

Proposed managed guidance:

```text
Before acting, size the request:

1. Simple/direct:
   Greetings, factual questions, tiny reads, one-line explanations, or clearly trivial edits.
   Act normally. Do not search for skills/plugins/MCPs unless the user asks.

2. Substantial/specialized:
   Audits, reviews, debugging, implementation, architecture, migrations, security,
   research, session close, recurring workflows, or tasks expected to use multiple tools.
   Pause briefly and check which installed skill, plugin, MCP, memory retrieval path,
   or native agent is relevant. Use the narrowest useful capability before freelancing.

3. High-risk/parallel:
   Security findings, destructive operations, broad codebase audits, cross-domain work,
   or explicitly delegated parallel work.
   Select the appropriate skill/guard first; use native agents only when useful or requested.
```

The instruction should emphasize proportionality:

- Saying `hey` should never invoke a capability discovery workflow.
- Reading one known file or answering a basic question should not require a skill.
- `audit this project`, `debug this failure`, `implement this feature`, and `close this session` should cause Claude to check for a matching installed capability first.
- The user can override routing by explicitly saying `do not use skills`, `use only Read/Grep`, or `deploy two agents`.

This is the first layer because it improves Claude's default judgment even when deterministic prompt matching does not cover a phrasing.

### 2. Add Prompt-Time Capability Route Advice

Add a Claude-only `UserPromptSubmit` hook handler, for example `ad hook capability-route-advice`, installed by the Claude profiles.

The handler should:

- Classify prompts as `simple`, `substantial`, or `high-risk/parallel` using deterministic, conservative rules.
- Return no advice for `simple` prompts.
- Match only high-confidence intent phrases using a small deterministic routing map.
- Return official Claude hook JSON with brief `additionalContext`, such as: `This is a substantial audit request. Relevant installed capability: review-slice. Invoke it before starting audit work.`
- Recommend the narrowest useful type of capability: installed skill first for known workflows, then available MCP/plugin only when the prompt requires its domain, then native agents for parallelizable work or explicit delegation.
- Remain no-API and fail-safe.
- Never run a skill itself and never block the prompt.
- Respect explicit constraints such as `do not use skills`, `do not use tools`, or `use only Read/Grep`.
- Suppress forced-skill advice when the user explicitly asks for `sub-agent`, `agent`, `spawn`, `parallel worker`, or named background agents; the advice may still identify useful safety/memory context without replacing the requested execution path.

Initial routing map:

| Intent | Example prompts | Recommended skill |
|---|---|---|
| General review/audit | `audit this project`, `review this page`, `check karo properly` | `review-slice` |
| Security-focused audit | `security audit`, `vulnerability check`, `CSP review` | `security-audit` if installed, otherwise `review-slice` |
| Debugging | `broken`, `error aa raha hai`, `why is this failing` | `debug-triage` |
| Session close | `bye`, `session khatam`, `done for today` | `session-close` |
| Capability discovery | `which tool can help`, `use the best skill/plugin` | Summarize relevant available capabilities only |

SEO audit needs an explicit policy decision during implementation:

- Preferred initial behavior: route broad `SEO audit` requests to `review-slice` with the audit focus preserved in the prompt.
- Alternative: add an SEO-specific skill only if repeated traces show `review-slice` is too generic.

Capability selection policy:

- Skills are preferred for established repeatable workflows and local learning feedback.
- MCP/plugin tools are preferred when they provide required domain access or efficient retrieval, such as QMD/context-mode for indexed context work.
- Native `Explore`/agents are preferred for explicitly requested parallel work or genuinely parallel investigation, not as a silent substitute for a matching required skill.
- Multiple capabilities may be combined only when the task justifies the added overhead.

### 3. Make Managed Instructions Accurate

Update the generated `CLAUDE.md` managed block and README wording to distinguish:

- The task-complexity gate that tells Claude when direct work is appropriate versus when capability selection is expected.
- Installed skills available to Claude.
- Prompt-time capability route advice generated deterministically by Agent Daemon.
- Actual skill invocation, which is performed by Claude and recorded only when it occurs.

Do not describe skills as reliably auto-triggering until prompt-time routing is installed and tested.

### 4. Add Routing Telemetry Without False Failures

Extend local telemetry to distinguish recommendation from execution:

- Record `task_size`, `recommended_capability_type`, `recommended_capability`, `routing_intent`, `routing_source`, and whether the prompt explicitly requested or prohibited native agents/tools/skills.
- Correlate a subsequent `PreToolUse:Skill` or `UserPromptExpansion` event with the recommendation in the same session.
- Mark `not_invoked` as an observation, not a skill failure.
- Do not count explicit agent requests as bypass failures.
- Keep actual outcome tracking unchanged: unknown until explicit correction or reliable failure evidence is observed.

Possible implementation options:

- Add a new `skill_route_events` table, preferred to avoid overloading `skill_executions`.
- Or extend `skill_executions` only if a recommended-but-not-invoked row can be represented without confusing GEPA failure sampling.

### 5. Repair And Validate Skill Frontmatter

Fix Claude-unparseable installed skill metadata at the source and installation path:

- Quote YAML `description` values that contain colons, apostrophes, or other parser-sensitive characters, including the reviewed `session-close` and `seed-data` cases.
- Locate the canonical source for each installed skill before updating the installed copy.
- Make `ad init` refresh daemon-managed installed skills when source metadata changes, without overwriting unrelated user-authored skills.
- Add an installation validation diagnostic to `ad doctor` for Claude skill frontmatter parseability.

Upgrade skill linting:

- Parse frontmatter with a real YAML parser, or use the same parsing constraints Claude applies.
- Add regression fixtures for quoted/unquoted colon descriptions and multiline descriptions.
- Fail CI for daemon-owned skills that Claude cannot load.

### 6. Validate Native-Agent Compatibility

The routing fix must preserve direct user control:

- `hey` and simple known-file questions should execute without skill/plugin/MCP route advice.
- `audit this project` should produce route advice and lead to `Skill(review-slice)` in a controlled Claude smoke session.
- `deploy two sub agents, one design audit and one security audit` should permit native Agent/Explore execution without claiming a missing skill failure.
- If a user requests both, such as `use review-slice and then delegate security checks`, both invocation types should be represented correctly in logs.
- `audit this project, do not use skills` should preserve the user constraint and avoid falsely recording a route failure.

## Interfaces

Potential hook addition:

```text
UserPromptSubmit -> ad hook capability-route-advice
```

Potential diagnostics:

```text
ad doctor
  Claude capability routing hook  wired
  Claude skill frontmatter        all daemon-managed skills parseable
```

Potential local storage:

```text
skill_route_events
  session_id
  project_slug
  task_size
  prompt_intent
  recommended_capability_type
  recommended_capability
  recommendation_source
  explicit_agent_request
  explicit_capability_constraint
  invoked_skill
  created_at
```

## Test Plan

### Automated Runtime Tests

- Complexity gate classifies greetings/basic prompts as simple and returns no route advice.
- Complexity gate classifies audits, debugging, implementation, session-close, and cross-domain tasks as substantial or high-risk.
- Route advice emits official `UserPromptSubmit` hook envelope for `audit this project`.
- Route advice maps review, security, debugging, close-session, and Hinglish prompts correctly.
- Explicit sub-agent prompts return no forced-skill advice.
- Explicit negative constraints such as `do not use skills` and `use only Read/Grep` are honored.
- MCP/plugin suggestions are surfaced only for capability-relevant prompts, not for every substantial task.
- Profile installation includes the route advice hook only for Claude installation paths.
- Recommendation telemetry records an advice event and links a later skill invocation.
- GEPA candidate selection ignores recommended-but-not-invoked events.
- YAML parser validation rejects the currently observed unquoted colon metadata fixture.
- `ad doctor` reports malformed daemon-managed installed skills.

### Isolated Claude Smoke

- Initialize a temporary project with an isolated HOME and no `ANTHROPIC_API_KEY`.
- Ask Claude `hey` and one trivial known-file question; confirm it does not invoke skills or enter capability-search overhead.
- Ask Claude `audit this project only, do not edit`; confirm a matching skill is invoked before audit tools.
- Ask Claude explicitly for two audit sub-agents; confirm native agents remain allowed and no false skill failure is stored.
- Ask Claude `audit this project but do not use skills`; confirm it follows the explicit override while retaining safe read-only behavior.
- Invoke `/session-close` and `seed-data` from the installed temporary skill set; confirm no YAML frontmatter parse warnings appear.

### Live Read-Only Verification

- Back up live Claude settings, installed daemon-managed skill files, and episodic DB first.
- Refresh the installed Claude profile and skills.
- Start a new Claude session in `mobiux-website`; old sessions are not authoritative.
- Run a read-only audit prompt and inspect debug logs for the advised skill invocation.
- Run an explicit sub-agent prompt and confirm intended native agent behavior.
- Verify `ad doctor` passes and no new frontmatter warnings are emitted.

## Acceptance Criteria

- Simple prompts stay lightweight: no unnecessary skill/plugin/MCP route advice or invocation.
- General audit/review prompts reliably result in a visible matched-skill recommendation and a testable `Skill(review-slice)` invocation in the controlled Claude smoke.
- Explicit sub-agent requests remain native-agent operations and are not recorded as skill-routing failures.
- Explicit capability restrictions are honored and recorded as intentional overrides, not failures.
- Claude starts without daemon-owned skill frontmatter parse warnings.
- Routing and frontmatter validation remain deterministic and no-API by default.
- Skill outcome and GEPA traces distinguish actual failures from non-invocation decisions.

## Implementation Sequence

1. Capture failing prompt and YAML warning fixtures from current debug evidence.
2. Repair canonical skill frontmatter and upgrade linter coverage.
3. Add the proportional task-complexity gate to the generated `CLAUDE.md` instructions and documentation.
4. Implement prompt-time capability route advice hook plus profile installation and diagnostics.
5. Add route telemetry without altering GEPA failure semantics.
6. Run isolated no-API Claude smoke tests.
7. Back up, refresh, and validate the live Claude installation.

## Evidence Reference

Observed live debug log:

```text
C:\Users\panka\.claude\debug\ffae18eb-81b2-4409-9283-703c055ea1c5.txt
```

Key evidence:

- Native tool invocation was `Agent` with `subagent_type: Explore`.
- Claude reported no skill invocation for the audit path.
- Startup reported YAML parse warnings for installed `session-close` and `seed-data`.
- Existing Agent Daemon hook smoke validation had already confirmed clean `SessionStart`, retrieval, and session-end operation independently of this routing gap.
