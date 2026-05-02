# @nmnmcc/ability

An Effect-style authorization library backed by the official CASL rule engine.

## Installation

```sh
yarn add @nmnmcc/ability
```

The public API is a module of functions:

- `Ability.define` synchronously builds an immutable ability from a generator DSL.
- `Ability.check` is the only authorization check API and returns `Effect<void, AuthorizationError | ConditionError>`.
- Rule indexing and Mongo-style condition matching are delegated to `@casl/ability`.
- There is no synchronous `can` / `cannot` / `allows` API. Boolean checks are derived with Effect combinators.
- Use `Casl.toMongoAbility` to export JSON-safe abilities to the official CASL ecosystem.

## Basic usage

```ts
import {Effect} from "effect"
import {Ability} from "@nmnmcc/ability"

interface Post {
  readonly id: string
  readonly authorId: string
  readonly published: boolean
  readonly title: string
  readonly body: string
}

type Subjects = {
  readonly Post: Post
}

const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post")

  yield* ability.allow("update", "Post", {
    fields: ["title", "body"],
    conditions: {authorId: "u1"}
  })

  yield* ability.deny("delete", "Post", {
    conditions: {published: true},
    reason: "Published posts cannot be deleted"
  })
})

const program = Effect.gen(function* () {
  const post = {} as Post

  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })
})
```

Denied checks fail through the Effect error channel:

```ts
const guarded = Ability.check(ability, {
  action: "delete",
  subject: "Post",
  value: {
    id: "p1",
    authorId: "u1",
    published: true,
    title: "Hello",
    body: "World"
  }
}).pipe(Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error.reason)))
```

## CASL-style rules

Use `manage` for any action and `all` for any subject:

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("manage", "all")
  yield* ability.deny("delete", "Post", {
    conditions: {published: true}
  })
})
```

`allow` and `deny` accept arrays:

```ts
yield *
  ability.allow(["read", "update"], "Post", {
    fields: ["title", "body"],
    conditions: {authorId: "u1"}
  })
```

`conditions` use CASL's Mongo-style object matcher for in-memory objects:

```ts
yield *
  ability.allow("read", "Post", {
    conditions: {
      published: {$eq: false},
      comments: {$elemMatch: {authorId: "u1"}}
    }
  })
```

Rule conditions use CASL's `MongoQuery` type and matcher.

Action aliases can expand one rule into several checkable actions:

```ts
const ability = Ability.define<Subjects>()(
  function* (ability) {
    yield* ability.allow("modify", "Post", {
      fields: ["title", "body"]
    })
  },
  {
    actionAliases: {
      modify: ["update", "delete"]
    } as const
  }
)

yield *
  Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })
```

Aliases are one-directional: a `modify` rule matches `update`, but separate `update` and `delete` rules do not imply `modify`.

## CASL compatibility

`Casl` re-exports the official `@casl/ability` API:

```ts
import {Casl} from "@nmnmcc/ability"

const {can, cannot, build} = new Casl.AbilityBuilder(Casl.createMongoAbility)

can("read", "Post")
cannot("delete", "Post", {published: true})

const caslAbility = build()
```

You can also export this package's immutable abilities to official CASL Mongo abilities:

```ts
const caslAbility = yield * Casl.toMongoAbility(ability)

caslAbility.can("update", Casl.subject("Post", post), "title")
```

ORM adapters and `accessibleBy`-style helpers are not implemented in this package; export a CASL ability and use the official CASL ecosystem packages for those integrations.

## Subjects and fields

DTOs can be wrapped without mutation:

```ts
yield *
  Ability.check(ability, {
    action: "read",
    value: Ability.subject("Post", post)
  })
```

You can also pass `detectSubjectType` to `define` or `make`.

Fields support dot paths and CASL-style patterns:

```ts
yield *
  ability.allow("update", "Post", {
    fields: ["title", "comments.**"]
  })
```

To filter request payloads, compute permitted fields as an Effect:

```ts
const fields =
  yield *
  Ability.permittedFields(
    ability,
    {
      action: "update",
      subject: "Post",
      value: post
    },
    {
      fieldsFrom: (rule) => rule.fields ?? ["title", "body"]
    }
  )
```

For debugging or extensions, inspect indexed rules as Effects:

```ts
const rules =
  yield *
  Ability.rulesFor(ability, {
    action: "update",
    subject: "Post",
    field: "title"
  })

const rule =
  yield *
  Ability.relevantRuleFor(ability, {
    action: "delete",
    subject: "Post",
    value: post
  })

const actions =
  yield *
  Ability.actionsFor(ability, {
    subject: "Post"
  })
```

## Raw rules and dynamic updates

Raw rules are JSON-safe:

```ts
const ability =
  yield *
  Ability.fromRawRules<Subjects>([
    {action: "read", subject: "Post", conditions: {authorId: "u1"}},
    {action: "delete", subject: "Post", inverted: true, reason: "No deletes"}
  ])

const rules = yield * Ability.toRawRules(ability)
```

`Ability.update` returns a new immutable ability from raw rules while reusing the current ability options:

```ts
const nextAbility =
  yield *
  Ability.update(ability, [
    {action: "read", subject: "Post"}
  ])
```

Use `AbilityExtra` for compact raw-rule transport and ORM-independent rule transforms:

```ts
import {AbilityExtra} from "@nmnmcc/ability"

const packed = AbilityExtra.packRules(rules)
const unpacked = AbilityExtra.unpackRules(packed)

const defaults =
  yield *
  AbilityExtra.rulesToFields(ability, {
    action: "read",
    subject: "Post"
  })

const condition =
  yield *
  AbilityExtra.rulesToCondition(ability, {action: "read", subject: "Post"}, (rule) => rule.conditions ?? {}, {
    and: (conditions) => ({$and: conditions}),
    or: (conditions) => ({$or: conditions}),
    not: (condition) => ({$not: condition}),
    empty: () => ({})
  })
```

Rule transforms fail with `QueryGenerationError` when the caller-provided conversion callback fails.

See [examples/basic.ts](./examples/basic.ts), [examples/advanced.ts](./examples/advanced.ts), and [tests/Ability.test.ts](./tests/Ability.test.ts).
