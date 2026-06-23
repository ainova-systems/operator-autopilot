# Source Language: English Only

> **Every string the codebase emits or carries is written in English** — user-facing CLI and log output, code comments, JSDoc, identifiers, commit messages, and docs. The product runs for many operators in many locales; the source language is English so the engine reads the same to everyone.

This rule applies to source files (`engine/`, `packages/`, `app/`), tests, comments, docstrings, JSDoc, examples, fixtures, documentation (`docs/**`), intelligence content (`intelligence/**`), CI workflows (`.github/**`), and dev scripts (`dev/**`).

## FORBIDDEN

- **🚨 Non-English text in any user-facing output** — CLI status footer hints, log lines, error messages, prompts, PR/bot comment templates. The status footer `hint` field and every `log.*` / `console.*` call stay English.
- **🚨 Non-English text in code comments, JSDoc, or example/test literals.**
- **Non-English identifiers** — variable, function, class, file, KV-key, or env-var names.
- **Non-English commit messages.** One line, English, capital letter, past tense (see `context.md`).

Typographic symbols that are not language text — em dash `—`, middot `·`, ellipsis `…`, spinner glyphs (`⠋`), check/cross marks (`✓` `✗`) — are allowed. The rule bans non-English *words*, not Unicode symbols.

## REQUIRED

- **English literals for everything the user reads.** When a hint or message needs words, write them in English (e.g. `"ESC — quit · Ctrl+C — abort"`).
- **No i18n layer for engine/CLI output.** There is no translation framework; do not introduce one to "fix" a non-English string — just write English.
- **If localization is ever needed**, it is a deliberate, separately-designed feature (resource bundles, not inline literals).

## Why

The operator is a product meant to run for many repos, customers, and operators. A non-English literal makes the codebase read as one person's local artifact rather than a product, is inconsistent with the surrounding English logs and comments, and silently bypasses any future i18n boundary. Keep one source language.

## How to enforce

- New code review: any non-English word in `engine/`, `packages/`, `app/`, `intelligence/`, `docs/`, `.github/`, or `dev/` is a blocker.
