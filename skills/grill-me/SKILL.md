---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me", "stress-test this", "poke holes in my plan", "what am I missing".
source: vendored from mattpocock/skills (MIT)
---

# Grill Me

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead — don't waste a question on me.

## When to stop

Stop when every branch of the design tree has been resolved — not when a fixed number of questions has been asked. Some plans need 3 questions; some need 30. The user can also end the session at any time by saying "wrap up" or "summarize what we have".
