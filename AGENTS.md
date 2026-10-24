# Rules for working on @nmnmcc/ability

This repository is a TypeScript authorization library. Authorization means the
work of deciding if a person may do an act. The design comes from Effect and
CASL.

These rules are for the whole repository. An `AGENTS.md` file in a folder can
give more exact rules for that folder. The `references/` folder is reference
material. Do not change it unless the user asks.

## Commands

- Run every command as `devenv shell -- <command>`.
- Format with `devenv shell -- treefmt`. It runs Prettier and nixfmt. The shell
  also runs treefmt when it starts.

## Language

- Write all text in [Basic English](https://en.wikipedia.org/wiki/Basic_English).
  This covers docs, comments, error messages, test names, test data, examples,
  and commit messages.
- Use the 850 words of Basic English where you can, plus the technical words you
  need. Use short sentences, one idea in each sentence, and active voice.
  Explain a technical word the first time you use it.

## Project Shape

- The package manager is `pnpm`. The exact version is in `package.json`.
- The development shell comes from [devenv](https://devenv.sh), in
  `devenv.nix`. It gives Node.js, pnpm (through corepack), and treefmt.
- The type checker is TypeScript 7 (`tsgo`) with the Effect language service
  from `@effect/tsgo`. `pnpm install` runs `effect-tsgo patch`, which puts the
  Effect checks into `tsc`. The check levels are in `tsconfig.json`.
- Source files import each other with `.ts` extensions. Node.js runs `.ts` files
  itself, so the examples need no other runner.
- Public entry points:
  - `src/index.ts`
  - `src/Ability.ts`
  - `src/AbilityExtra.ts`
- Internal code:
  - `src/internal/ability.ts`
  - `src/internal/serializable.ts`
- Examples are in `examples/`.
- Tests are in `tests/`.

## Public API

Keep the public API as it is unless the user asks for a change:

- Use Effect module functions. Do not make a class with changing state.
- `Ability.define()` is pure and synchronous. It gives back an `Ability`. Do not
  put ability definition inside an `Effect`.
- `ability.allow()` and `ability.deny()` give back `Rule` values.
- A `Rule` must work with generators, so users can write
  `yield* ability.allow(...)` inside `Ability.define`.
- `Ability.check()` is the only authorization check function.
- Do not add `Ability.allows()` again unless the user asks.
- `Ability.check()` gives an `Effect` with `void` on success.
- A "no" answer and a failed condition go into the Effect error channel. Do not
  give check results as a `Result` unless the user asks.
- A condition function may give a boolean or an `Effect<boolean, E, R>`. Keep
  its error type and service type in the type of `Ability.check`.

## Code

- Keep public types and their docs in `src/Ability.ts`.
- Keep the code that makes and matches rules in `src/internal/ability.ts`.
- Use data structures that do not change for rules and abilities.
- Keep rule matching clear. The last rule that matches wins. The code does this
  by looking at the rules from the end.
- Use the code in `references/` as an example of Effect patterns.
- Follow the style of the code near your change before you add new layers.
- Keep each change to what the user asked for.
- Do not change generated files or reference material by hand.
- When you must work around a bug in a dependency or a tool, explain the bug in
  a comment next to the workaround.

## Dependencies

- Pin each dependency to an exact version.
- pnpm does not install very new releases. Do not add
  `minimumReleaseAgeExclude` entries to get around this.

## Checks

Use `@effect/vitest` for tests. Type tests use `tstyche`.

```sh
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test-types
devenv shell -- node examples/basic.ts
git diff --check
```

- Run `pnpm typecheck` after a change to types or to the public API. An error
  from the Effect language service makes the typecheck fail.
- Run `pnpm test` after a change to behavior.
- Run `pnpm test-types` after a change to public types.
- Run the examples after a change to an example or to an API in the README.
- For a change to docs only, `git diff --check` is enough, unless a code example
  in the docs changed.

## Work

- Read the files before you change code.
- Use `rg` to search.
- Do not undo changes that the user made, or other changes you did not make.
- When a sandbox stops an important command, ask for the right permission and
  run it again.
- Say which checks you ran. Do not say that a check passed when you did not run
  it.
