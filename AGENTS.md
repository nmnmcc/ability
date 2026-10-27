# Rules for working on @nmnmcc/ability

This repository is a TypeScript authorization library. Authorization means the
work of deciding if a principal may do an act. It is made with Effect only. Its
ideas come from Effect, CASL and XACML, but it does not use CASL.

These rules are for the whole repository. An `AGENTS.md` file in a folder can
give more exact rules for that folder. The `references/` folder is reference
material. Do not change it unless the user asks.

## Commands

- Run every command as `devenv shell -- <command>`.
- Format with `devenv shell -- treefmt`. It runs Prettier and nixfmt. The shell
  also runs treefmt when it starts.

## Language

- Write all text that goes into the repository in Basic English. This covers
  docs, comments, error messages, logs, prompts, test names, test data, and
  commit messages.
- Use the 850 words of Basic English where you can, plus the technical words you
  need. Use short sentences, one idea in each sentence, and active voice.
  Explain a technical word the first time you use it.

## Project Shape

- The package manager is `pnpm`. The exact version is in `package.json`.
- The development shell comes from [devenv](https://devenv.sh), in `devenv.nix`.
  It gives Node.js, pnpm (through corepack), and treefmt.
- The type checker is TypeScript 7 (`tsgo`) with the Effect language service
  from `@effect/tsgo`. `pnpm install` runs `effect-tsgo patch`, which puts the
  Effect checks into `tsc`. The check levels are in `tsconfig.json`.
- Source files import each other with `.ts` extensions. Node.js runs `.ts` files
  itself, so the examples need no other runner.
- Public entry points: `src/index.ts`, and one module for each concept:
  `Resource`, `Domain`, `Condition`, `Policy`, `Decision`, `Authorizer`,
  `Limits`. The types and the builder of rules are in `Policy`.
- `src/HttpApi.ts` is a separate entry point, because `effect/http-api` is not
  stable. Do not export it from `src/index.ts`.
- A public module in `src/` keeps the public types, the docs, and short exports.
  The code is in `src/internal/`, with one file for each part of the work.
  `package.json` does not export `src/internal/`, so a user can not import it.
- Examples are in `examples/`.
- Tests are in `tests/`.

## Public API

- Use Effect module functions and data that does not change. Do not make a class
  with changing state.
- All types come from the `Domain`. A rule may only use the actions of its
  resource, and a condition may only use the fields of its resource and of the
  principal. Keep these checks in the types. Every builder is bound to a domain.
- Read paths come from Schema `fields`, not the type of a class instance. Paths
  have at most five parts. Getters, methods, array items and dynamic record keys
  are not read paths. A predicate may use the full class value.
- Field permissions take a real path, a parent path or `"*"`. Do not add field
  patterns or a second API for deeper paths.
- A policy or condition Codec reads and writes JSON text only. Bind decoded
  nodes to the domain before returning them. Rule `meta` is bounded JSON data;
  the domain has no meta Codec.
- The caller gives stable, checked principal and resource values. Read only own
  data fields. Do not copy or encode a principal to load its policy. A business
  layer owns any cache, its keys, its expiry and its invalidation.
- `Resource.Class` works like `Schema.TaggedClass`. Every resource value has a
  `_tag`. Do not find a resource from a constructor name.
- `Policy.define()` is pure and synchronous. A rule must work with generators,
  so users can write `yield* _.allow(...)`.
- A condition is plain data. Only a predicate may run code. A condition has two
  type fields: `Condition<I, X>`. `I` is what it reads (`Reads`). `X` is
  `Opaque<E, R>` when it has a predicate, with the error type and the service
  type of the predicates, and `never` when it is plain. A policy keeps `X` too:
  `Policy<D, X>`. Every check gets `E` and `R` from `X`. A policy with a
  predicate must not become JSON, so the Schema takes only `X = never`.
- The types of conditions, rules and policies are their own: a node is a class,
  and a policy has a private field. A spread of one, or an object made by hand,
  is not one. The children of a node have no types, so they go into nothing.
- The public functions take the data first. Only `ceiling`, `provideContext` and
  `Condition.fold` also take their options first, for `pipe`.
- A decision is `Allow`, `Deny` or `NotApplicable`. `Policy.decide` gives a
  decision. `Authorizer.check` puts a "no" into the error channel.
- Fail closed. An error while loading a policy is never a "yes".
- `Policy.residual` must agree with `Policy.decide`. The property tests in
  `tests/Policy.test.ts` check this. Add a case there when you add an algorithm,
  a combinator, or a kind of condition node.

## Code

- Build the library on Effect. Do not copy the way Effect builds itself: Effect
  had no Effect to build on, so its own code uses tricks that this library does
  not need.
  - Make values with Effect data types: `Data.Class` for values with methods,
    `Data.taggedEnum` for small plain values, and `Schema` classes for errors
    and for data that comes from outside.
  - A node of a condition is a class in `src/internal/nodes.ts`. Only its
    constructor makes one, also for JSON. The constructor checks the fixed
    limits. It keeps the size, depth and predicate mark in private fields. Size
    includes nodes, operands and list items. Copy arrays and JSON meta at this
    boundary; reuse valid child nodes. A plain object or a spread is not a node.
  - Do not make prototypes by hand. Do not write `Equal.symbol`, `Hash.symbol`
    or `NodeInspectSymbol` methods, and do not use `Object.create`. Effect data
    types give equality, hashing and `pipe`. The fixed depth limits keep those
    walks small. Do not add a custom tree hash or equality runner.
  - Do not mark values with a `TypeId`. A guard tests the class with
    `instanceof`.
  - Use the tools that Effect gives to its users, such as `Function.dual`,
    `Effect.fn`, `Context.Service`, `Layer`, `Cache` and `Schema`.
- Do not keep state for the whole program. A module may not have a `Map`, a
  `Set`, a `WeakMap`, a cache or a `let` at its top level. When a walk needs a
  memo, the walk makes it, and the memo goes away when the walk ends. State that
  must live longer belongs to a value, such as a layer. A memo that lives for
  one walk is a `Map`, not a `WeakMap`: its keys stay alive until the walk ends,
  and a `WeakMap` is slower.
- Use bounded recursion for trees and Effect for effectful work. Check depth
  before going to a child of an external input. Do not add a generic runner or
  promise to support arbitrary depth.
- The fixed limits are: policy depth 32; condition and residual depth 64; paths
  five parts; meta depth 16; 10000 structural units per policy or condition;
  1000 catalog fields per Schema; JSON text 1000000 UTF-16 code units, depth 256
  and 100000 items; analysis 16 fields and 100000 steps. Shared parts count each
  time they appear. A domain may not raise a limit.
- Catalogs describe fixed fields only. Complex Schema parts are opaque: their
  fields are not read by plain conditions. Coverage returns `Unknown` with
  reason `"schema"` when it can not prove a result for a Schema. Unknown never
  grants a kind check or calls a fallback decider. A filter gives a residual
  without a coverage search.
- Change as little state as you can. Use `const` and values that do not change.
  Make a new value in place of a change to an old one. A memo `Map` inside one
  call is the usual exception.
- Pick the set or map that is right for its keys, and say why in a comment:
  - Keys that come from a policy, as paths, values or the text of a node, go
    into a native `Map` or `Set`. The hash of a string in Effect has no random
    seed, so a policy could hold very many keys with one hash.
  - A native `Map` or `Set` finds an object by the object itself. `Equal`
    compares Effect data, Schema nodes and plain objects by structure.
  - Keys that the code makes one time and finds with the same strings are faster
    in a native `Map`, about five times.
  - Names from a Schema that a lookup gets from `split`, as new strings, are
    faster in a `HashMap` of Effect, about 20%.
  - A value that is shared and changes by steps, as the set of the places on a
    path, is a `HashSet` of Effect, which shares its parts.
  - `Arr.dedupe` is slower than a native `Set`, about ten times.
- Do not write `for` or `while` loops. Use the tools of Effect: `Array` from
  `effect` (`map`, `flatMap`, `filter`, `reduce`, `reduceRight`, `some`,
  `every`, `findFirst`, `groupWith`, `unfold`) for values, and `Effect.forEach`,
  `Effect.filter` and `Effect.findFirst` for Effects. A walk that must stop
  early may call itself with the next index.
- A public function gives its full types. The code in `src/internal/` works on
  values with no types, and the public module gives the public type in the
  `export const` line, as in `export const f: PublicType = internal.f`. A file
  may turn off the `anyUnknownInErrorContext` check, with a comment that says
  why.
- Follow the style of the code near your change before you add new layers.
- Keep each change to what the user asked for.
- Do not change generated files or reference material by hand.
- When you must work around a bug in a dependency or a tool, explain the bug in
  a comment next to the workaround.

## Dependencies

- Pin each dependency to an exact version.
- pnpm does not install very new releases. Do not add `minimumReleaseAgeExclude`
  entries to get around this.

## Checks

Use `@effect/vitest` for tests. Type tests use `tstyche`.

```sh
devenv shell -- pnpm build
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm test-types
devenv shell -- node examples/basic.ts
devenv shell -- node examples/authorizer.ts
devenv shell -- node examples/multi-tenant.ts
devenv shell -- node examples/field-access.ts
devenv shell -- node examples/stored-policies.ts
devenv shell -- node examples/predicates.ts
devenv shell -- node examples/algorithms.ts
devenv shell -- node examples/http-api.ts
devenv shell -- git diff --check
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
