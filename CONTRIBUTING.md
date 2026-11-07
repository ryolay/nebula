# Contributing to Nebula

Thanks for helping! Nebula aims to stay **simple, fast and honest**: every action maps to real `git`/`gh` commands, and the UI should never surprise the user.

## Getting started

```bash
npm install
npm start
```

## Before you open a pull request

1. `npm run lint` passes (ESLint + duplication check — Codacy runs the same rules).
2. `npm test` passes. New behaviour comes with a test: backend logic in `tests/*.test.js`, UI flows in `tests/e2e.test.js`.
3. UI changes include a screenshot in the PR description (light **and** dark theme if colours changed).
4. Keep the PR focused — one feature or fix per PR.

## Guidelines

- **Run git with argument arrays**, never through a shell string (`run(['commit', '-m', msg])`), so user input can't be interpreted by a shell.
- **Destructive actions are undoable or confirmed.** If you add one, register an undo step or ask for confirmation.
- **No new runtime dependencies** without a good reason; the renderer is plain JavaScript on purpose.
- Use the design tokens in `styles.css` (`--ink`, `--accent`, radii, spacing) instead of hard-coded colours, and keep text contrast at WCAG AA.
- Nebula runs on macOS, Windows and Linux: build paths with `path.join`, use `modKey(e)` for shortcuts and write shortcut labels as `⌘⇧P` (they become `Ctrl+Shift+P` on other systems).
- Write code, comments, UI copy and commit messages in English.

## Reporting bugs

Open an issue with your macOS version, Nebula version (or commit), what you did, what you expected, and what happened. A screenshot helps a lot.
