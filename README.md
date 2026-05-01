# ability

An Effect-style authorization library inspired by CASL.

The public API is a module of functions:

- `Ability.define` synchronously builds an immutable ability from a generator DSL.
- `Ability.check` is the only authorization check API and returns `Effect<void, AuthorizationError | PredicateError | ConditionError>`.
- There is no synchronous `can` / `cannot` / `allows` API. Boolean checks are derived with Effect combinators.
- ORM adapters and `accessibleBy`-style helpers are intentionally out of scope.

## Basic usage

```ts
import { Effect } from "effect"
import { Ability } from "ability"

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
    when: (post) => post.authorId === "u1"
  })

  yield* ability.deny("delete", "Post", {
    when: (post) => post.published,
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
}).pipe(
  Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error.reason))
)
```

## CASL-style rules

Use `manage` for any action and `all` for any subject:

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("manage", "all")
  yield* ability.deny("delete", "Post", {
    conditions: { published: true }
  })
})
```

`allow` and `deny` accept arrays:

```ts
yield* ability.allow(["read", "update"], "Post", {
  fields: ["title", "body"],
  conditions: { authorId: "u1" }
})
```

`conditions` use Mongo-style object matching through `@ucast/mongo2js` for in-memory objects only:

```ts
yield* ability.allow("read", "Post", {
  conditions: {
    tags: { $in: ["effect"] },
    comments: { $elemMatch: { authorId: "u1" } }
  }
})
```

`conditions` and `when` are combined with AND. Predicate failures remain typed Effect failures.

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

yield* Ability.check(ability, {
  action: "update",
  subject: "Post",
  value: post,
  field: "title"
})
```

Aliases are one-directional: a `modify` rule matches `update`, but separate `update` and `delete` rules do not imply `modify`.

## Subjects and fields

DTOs can be wrapped without mutation:

```ts
yield* Ability.check(ability, {
  action: "read",
  value: Ability.subject("Post", post)
})
```

You can also pass `detectSubjectType` to `define` or `make`.

Fields support dot paths and CASL-style patterns:

```ts
yield* ability.allow("update", "Post", {
  fields: ["title", "comments.**"]
})
```

To filter request payloads, compute permitted fields as an Effect:

```ts
const fields = yield* Ability.permittedFields(ability, {
  action: "update",
  subject: "Post",
  value: post
}, {
  fieldsFrom: (rule) => rule.fields ?? ["title", "body"]
})
```

For debugging or extensions, inspect indexed rules as Effects:

```ts
const rules = yield* Ability.rulesFor(ability, {
  action: "update",
  subject: "Post",
  field: "title"
})

const rule = yield* Ability.relevantRuleFor(ability, {
  action: "delete",
  subject: "Post",
  value: post
})

const actions = yield* Ability.actionsFor(ability, {
  subject: "Post"
})
```

## Raw rules and dynamic updates

Raw rules are JSON-safe and do not include `when` predicates:

```ts
const ability = yield* Ability.fromRawRules<Subjects>([
  { action: "read", subject: "Post", conditions: { authorId: "u1" } },
  { action: "delete", subject: "Post", inverted: true, reason: "No deletes" }
])

const rules = yield* Ability.toRawRules(ability)
```

Use `AbilityExtra` for compact raw-rule transport and ORM-independent rule transforms:

```ts
import { AbilityExtra } from "ability"

const packed = AbilityExtra.packRules(rules)
const unpacked = AbilityExtra.unpackRules(packed)

const defaults = yield* AbilityExtra.rulesToFields(ability, {
  action: "read",
  subject: "Post"
})

const condition = yield* AbilityExtra.rulesToCondition(
  ability,
  { action: "read", subject: "Post" },
  (rule) => rule.conditions ?? {},
  {
    and: (conditions) => ({ $and: conditions }),
    or: (conditions) => ({ $or: conditions }),
    not: (condition) => ({ $not: condition }),
    empty: () => ({})
  }
)
```

Rule transforms fail with `QueryGenerationError` when a relevant rule contains a `when` predicate, because function predicates cannot be serialized into a query.

`Ability` stays immutable. Use `AbilityRef` when an application needs to replace the current ability:

```ts
import { AbilityRef } from "ability"

const ref = AbilityRef.make(ability)

const unsubscribe = yield* AbilityRef.on(ref, "updated", () =>
  Effect.sync(() => {
    console.log("ability updated")
  }))

yield* AbilityRef.set(ref, nextAbility)
unsubscribe()
```

See [examples/basic.ts](./examples/basic.ts), [examples/advanced.ts](./examples/advanced.ts), and [tests/Ability.test.ts](./tests/Ability.test.ts).
