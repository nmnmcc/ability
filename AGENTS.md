# Agent Guidelines

This repository is a TypeScript authorization library inspired by Effect and CASL.

These instructions apply to the whole repository, except where a nested `AGENTS.md`
provides more specific rules. The `references/effect-smol/` directory is reference
material; do not edit it unless the user explicitly asks.

## Project Shape

- Package manager: `yarn@4.14.1`.
- Public API entry points:
  - `src/index.ts`
  - `src/Ability.ts`
- Internal implementation:
  - `src/internal/ability.ts`
- Examples live in `examples/`.
- Tests live in `tests/`.
- Conversation notes and archival summaries live in `notes/`.

## API Invariants

Keep the public API aligned with the current design unless the user explicitly asks
to change it:

- Use Effect-style module functions, not a mutable class API.
- `Ability.define()` is a pure synchronous constructor and returns `Ability`
  directly. Do not wrap ability definition in `Effect`.
- `ability.allow()` and `ability.deny()` return `Rule` values directly.
- `Rule` must remain generator-friendly so users can write
  `yield* ability.allow(...)` inside `Ability.define`.
- `Ability.check()` is the single authorization check API.
- Do not reintroduce `Ability.allows()` unless explicitly requested.
- `Ability.check()` returns an `Effect` whose success value is `void`.
- Authorization denial and predicate failures should use the Effect error channel.
  Do not encode check results as `Result` unless explicitly requested.
- Predicate functions may be synchronous booleans or `Effect<boolean, E, R>`.
  Preserve predicate error and service types in `Ability.check`.

## Implementation Guidance

- Keep public types and documentation in `src/Ability.ts`.
- Keep runtime construction and matching logic in `src/internal/ability.ts`.
- Prefer immutable data structures for rules and abilities.
- Keep rule matching behavior explicit. The current behavior is last matching rule
  wins, implemented by scanning rules from the end.
- Use the code under `references/` as reference material for implementation
  patterns, especially when aligning with Effect-style APIs and conventions.
- Follow existing local style before introducing abstractions.
- Keep changes narrowly scoped to the user's request.
- Do not manually edit generated or third-party reference material.

## Testing

Use `@effect/vitest` for tests in this repository.

Common verification commands:

```sh
yarn typecheck
yarn test
yarn tsx examples/basic.ts
git diff --check
```

Notes:

- Run `yarn typecheck` after type-level or public API changes.
- Run `yarn test` after behavior changes.
- Run `yarn tsx examples/basic.ts` after example or README-facing API changes.
- `tsx` may need to create an IPC pipe under `/tmp`; if sandboxed execution fails
  with `listen EPERM`, rerun with the appropriate sandbox escalation.
- For docs-only changes, `git diff --check` is usually enough unless the docs
  include executable examples that changed.

## Notes Protocol

When the user asks to end, archive, summarize, write notes, or otherwise preserve
conversation state, create a new Markdown file in `notes/` using the protocol in
`notes/README.md`.

Important requirements:

- Name note files with the current UTC timestamp:

  ```sh
  date -u +%Y-%m-%dT%H-%M-%SZ
  ```

- File format:

  ```txt
  notes/YYYY-MM-DDTHH-MM-SSZ.md
  ```

- Do not use non-timestamp names such as `session-summary.md`.
- Include starting state, final state, work performed, rationale, process,
  errors, fixes, and verification results.

## Working Rules

- Read relevant files before changing code.
- Use `rg` for search when possible.
- Use `apply_patch` for manual edits.
- Do not revert user changes or unrelated dirty worktree changes.
- If a command fails because of sandbox restrictions and is important for the task,
  rerun it with the proper escalation request.
- Mention verification that was actually run; do not imply unrun checks passed.
