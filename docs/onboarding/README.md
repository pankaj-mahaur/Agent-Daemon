# Onboarding deck — export instructions

The canonical source is `docs/onboarding-deck.md` (Marp markdown, 28 slides). Theme overrides live in `docs/onboarding-deck.css`.

From this single source you can export **PPTX, PDF, or HTML** with one command each.

---

## One-time setup

```bash
# Install Marp CLI globally (Node 18+ required — you already have Node 22+ from agent-daemon install)
npm install -g @marp-team/marp-cli@4
```

Pin to `4.x` LTS so re-exports are byte-for-byte reproducible across the team.

---

## Export commands (run from repo root)

### PPTX — editable in PowerPoint / Google Slides / Keynote

```bash
marp docs/onboarding-deck.md \
  --allow-local-files \
  -o docs/onboarding/exports/agent-daemon-onboarding.pptx
```

### PDF — share-anywhere, fixed layout

```bash
marp docs/onboarding-deck.md \
  --pdf \
  --allow-local-files \
  -o docs/onboarding/exports/agent-daemon-onboarding.pdf
```

### HTML — self-contained, opens in any browser

```bash
marp docs/onboarding-deck.md \
  --html \
  --allow-local-files \
  -o docs/onboarding/exports/agent-daemon-onboarding.html
```

### All three in one command

```bash
# Bash / zsh
for fmt in pptx pdf html; do
  marp docs/onboarding-deck.md \
    --allow-local-files \
    ${fmt:+--$fmt} \
    -o docs/onboarding/exports/agent-daemon-onboarding.$fmt
done

# PowerShell
foreach ($fmt in 'pptx', 'pdf', 'html') {
  $flag = if ($fmt -eq 'pptx') { '' } else { "--$fmt" }
  marp docs/onboarding-deck.md --allow-local-files $flag `
    -o "docs/onboarding/exports/agent-daemon-onboarding.$fmt"
}
```

---

## Live preview while editing

```bash
marp docs/onboarding-deck.md --watch --server
# Open http://localhost:8080 in your browser
# Edits to onboarding-deck.md hot-reload
```

---

## Sharing the exports

The `exports/` folder content is **gitignored** (regenerable from source). Distribute via:

- **Slack** — upload the PPTX or PDF directly to `#agent-daemon` channel
- **GitHub release** — attach the PDF + PPTX as release assets when tagging a new version
- **Internal wiki** — embed the HTML version or link to the rendered file

---

## Font fallback

The deck specifies `Inter` (sans) and `JetBrains Mono` (mono). If those aren't installed on a reviewer's machine, fallback chain:

- **Inter** → `Segoe UI` (Windows) → `system-ui` (macOS) → generic sans-serif
- **JetBrains Mono** → `Fira Code` → `Consolas` (Windows) → generic monospace

For pixel-perfect output, install [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) on the presenting machine.

---

## Modifying for other audiences

The deck is engineering-focused. To create variants:

- **Mixed audience (PM / design):** simplify slides 5, 18, 20, 24, 25 (the architecture-heavy ones). Keep slides 1-6 + 14-17 + 22 + 28.
- **Workshop / hands-on:** add exercise slides between sections — interleave a "now you try this" slide after each install step.
- **Light-mode export:** change `class: invert` → `class: lead` in the frontmatter. Theme falls back to white-bg/black-text.

---

## Slide count audit

Total slides: **28**.

| Section | Slide range | Purpose |
|---|---|---|
| Hook + Problem | 1-3 | Title, problem statement, cost |
| What it does | 4-6 | Pitch, 3-loops diagram, before/after |
| Prerequisites | 7-9 | Tool checklist, Claude Code, Node + git |
| Install agent-daemon | 10-13 | Clone, `npm link`, `ad doctor`, optional add-ons |
| First project | 14-17 | `ad init`, what's created, bootstrap, memory files |
| Daily workflow | 18-22 | Session lifecycle, skills, session-close, persistence, proof |
| Advanced | 23-25 | skill-author, GEPA inline, multi-agent |
| Safety + troubleshooting | 26-27 | TOS analysis, top-6 fixes |
| Closing | 28 | CTA + Q&A |

---

## Reproducibility notes

- Marp CLI version pinned: `4.x` LTS
- Theme imports `gaia` (built-in Marp theme) — no external CDN
- All ASCII art inline (no external image dependencies)
- Generated exports are reproducible byte-for-byte given the same CLI version

If exports look different on different machines: it's almost always a font fallback. Install Inter + JetBrains Mono to match.
