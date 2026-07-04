---
path: "app/**"
---

# Observability App Developer Context

`@operator/app` — Next.js 15 + React 19 + Tailwind observability and config-edit UI.
It reads the same SQLite state the engine writes. Full boundary rules:
`intelligence/rules/typescript.md`.

## Boundaries
- Imports `@operator/core` (types only) and `@operator/adapters` (read-only KVStore). NEVER imports `@operator/engine` runtime code.
- SQLite / KV access happens in server components or API routes only — never in `"use client"` files. If a client component needs data, fetch it through an API route.
- Named exports for shared modules; kebab-case filenames; TypeScript strict, no `any` / `@ts-ignore`.

## Testing
- `app/src/lib/**` is unit-tested with vitest and counts toward coverage (>=90% on touched files).
- Route files (`app/src/app/**`) and React components (`app/src/components/**`) are excluded from vitest coverage and verified via the dev server / typecheck — see `vitest.config.ts`.
- The app's TypeScript is gated by `npm run typecheck` (which runs the app workspace typecheck), so type errors here are caught by the standard verify command.

## Run / verify
- `npm run app:dev` (or `npm run dev --workspace @operator/app`) → http://localhost:3000.
- Gate: `npm run typecheck && npm run lint && npm test` from the repo root.
