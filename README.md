# context-diet 🥗

Your Claude context window is not unlimited.
(It is, but it fills up fast.)

Find out what's eating it and put it on a diet.

```bash
npx context-diet scan
```

*node_modules/: 712,000 tokens. That's why.*

---

## Install

```bash
# Run once without installing
npx context-diet scan

# Install globally
npm install -g context-diet
```

## Commands

### `scan` — See what's eating your context

```bash
context-diet scan
context-diet scan --path ./my-project
```

Scans all files, estimates token costs, identifies the biggest hogs, and tells you exactly what to exclude. Shows a smart loading strategy for what's left.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CONTEXT DIET REPORT
  Project: ./my-project
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Claude's context window:  200,000 tokens
  Your project (all files): 847,234 tokens  ← 4.2x too big

  What fits in one session: 23% of your project

TOP CONTEXT HOGS:
  📁 node_modules/         712,000 tokens  (84%)  → EXCLUDE
  📄 package-lock.json      45,000 tokens  (5%)   → EXCLUDE
  📄 src/server.js           8,200 tokens  (1%)   → Large — use with subagent
  📄 docs/api.md             4,100 tokens  (0.5%) → Load on demand only
```

### `audit` — See what burned context in past sessions

```bash
context-diet audit
```

Reads `~/.claude/projects/` session files to show:
- Which files appear in 90%+ of your sessions
- Average bash output size (huge source of waste)
- Recent session sizes

### `diet` — Get recommendations + generate .claudeignore

```bash
context-diet diet          # Show recommendations
context-diet diet --write  # Generate .claudeignore file
```

Detects what's in your project and generates a `.claudeignore` — like `.gitignore` but tells Claude Code what not to load.

### `watch` — Live context budget monitor

```bash
context-diet watch
context-diet watch --path ./src
```

Live updating bar that shows your current context budget as files change.

---

## Token Estimation

No API key needed. Uses the `~4 chars = 1 token` approximation — accurate enough to identify waste, fast enough to run on any project size.

## .claudeignore

`context-diet diet --write` generates a `.claudeignore` for your project. It works exactly like `.gitignore` — Claude Code reads it to skip files that would waste your context budget.

Example `.claudeignore`:
```
node_modules/
dist/
build/
package-lock.json
yarn.lock
*.min.js
*.map
coverage/
```

## Why This Exists

Every token loaded into context is a token that could have been used for actual work. Most projects have 80%+ of their token budget eaten by files that are never useful in context: lock files, build output, minified code, dependencies.

`context-diet` makes the invisible visible.

---

## License

MIT — [NickCirv/context-diet](https://github.com/NickCirv/context-diet)
