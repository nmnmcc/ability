# @nmnmcc/ability

Authorization primitives for Effect programs, backed by CASL's rule engine.

This package models authorization checks as `Effect` values and keeps failures
in the typed error channel, while preserving the familiar CASL rule model:
actions, subjects, fields, conditions, allow rules, and deny rules.

## Requirements

- TypeScript projects should use strict type checking to get the full public API
  guarantees.
- `effect` and `@casl/ability` are peer dependencies.
- CASL APIs are not re-exported. Import official CASL helpers directly from
  `@casl/ability`.

## Installation

```sh
yarn add @nmnmcc/ability effect @casl/ability
```

## Overview

The main entry point is the following import:

```ts
import {Ability, AbilityExtra} from "@nmnmcc/ability"
```

| Concept | Description |
| ------- | ----------- |
| `Ability` | An immutable, ordered set of authorization rules. |
| `Rule` | A yieldable allow or deny rule recorded by `Ability.define`. |
| `Ability.define` | Synchronously builds an `Ability` from a generator DSL. |
| `Ability.check` | The authorization decision API. It succeeds with `void` or fails through the Effect error channel. |
| `Ability.subject` | Wraps a plain object with an explicit subject name without mutating the object. |
| `AbilityExtra` | Helpers for compact rule transport and rule-to-query transforms. |

Important behavior:

- Last matching rule wins.
- `manage` means any action.
- `all` means any subject.
- Checks do not return booleans. Use Effect combinators to derive booleans when
  needed.

## Getting Started

Define your domain subjects as a type-level map:

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
```

Define an ability synchronously:

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post")

  yield* ability.allow("update", "Post", {
    fields: ["title", "body"],
    conditions: {authorId: "u1"},
    reason: "Authors can edit their own content"
  })

  yield* ability.deny("delete", "Post", {
    conditions: {published: true},
    reason: "Published posts cannot be deleted"
  })
})
```

Check permissions inside an Effect program:

```ts
const post: Post = {
  id: "p1",
  authorId: "u1",
  published: true,
  title: "Hello",
  body: "World"
}

const program = Effect.gen(function* () {
  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })

  const deleteResult = yield* Ability.check(ability, {
    action: "delete",
    subject: "Post",
    value: post
  }).pipe(
    Effect.match({
      onFailure: (error) =>
        error._tag === "AuthorizationError" ? error.reason : "unexpected failure",
      onSuccess: () => "deleted"
    })
  )

  return deleteResult
})
```

## Defining Rules

**Syntax**

```ts
Ability.define<Subjects>()(
  function* (ability) {
    yield* ability.allow(action, subject, options)
    yield* ability.deny(action, subject, options)
  },
  options
)
```

`Ability.define` returns an `Ability` directly. It is not wrapped in `Effect`.
The yielded `Rule` values are collected in order and stored immutably.

**Example** (Multiple Actions)

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow(["read", "update"], "Post", {
    fields: ["title", "body"],
    conditions: {authorId: "u1"}
  })
})
```

**Example** (`manage` and `all`)

```ts
const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("manage", "all")
  yield* ability.deny("delete", "Post", {
    conditions: {published: true},
    reason: "Published posts cannot be deleted"
  })
})
```

Rules are resolved from the end of the rule list. In the example above, the
later `deny("delete", "Post")` can override the earlier `allow("manage", "all")`
when its condition matches.

## Checking Permissions

**Syntax**

```ts
Ability.check(ability, request)
ability.pipe(Ability.check(request))
```

`Ability.check` returns:

```ts
Effect.Effect<void, Ability.AuthorizationError | Ability.ConditionError | Ability.SubjectDetectionError>
```

- Success means the request is authorized.
- `AuthorizationError` means no allow rule matched, or the winning rule was a
  deny rule.
- `ConditionError` means condition matching threw while evaluating a rule.
- `SubjectDetectionError` means the request did not provide a subject and the
  subject could not be detected from the value.

**Example** (Boolean Derived From Effect)

```ts
const canUpdateTitle = yield* Ability.check(ability, {
  action: "update",
  subject: "Post",
  value: post,
  field: "title"
}).pipe(
  Effect.match({
    onFailure: () => false,
    onSuccess: () => true
  })
)
```

There is no synchronous `can`, `cannot`, or `allows` API in this package.

## Conditions And Fields

Conditions use CASL's Mongo-style matcher and `MongoQuery` type.

**Example** (Mongo-Style Conditions)

```ts
interface Comment {
  readonly authorId: string
  readonly body: string
}

interface PostWithComments extends Post {
  readonly comments: ReadonlyArray<Comment>
}

type Subjects = {
  readonly Post: PostWithComments
}

const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post", {
    conditions: {
      published: {$eq: false},
      comments: {$elemMatch: {authorId: "u1"}}
    }
  })
})
```

Fields are typed as dot paths, with bounded recursion for predictable
type-checking. CASL-style field patterns are also accepted.

**Example** (Field Restrictions)

```ts
interface Address {
  readonly city: string
  readonly street: string
}

interface PostWithAddress extends Post {
  readonly address: Address
}

type Subjects = {
  readonly Post: PostWithAddress
}

const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("update", "Post", {
    fields: ["title", "address.**"],
    conditions: {authorId: "u1"}
  })
})

const post = {} as PostWithAddress

yield* Ability.check(ability, {
  action: "update",
  subject: "Post",
  value: post,
  field: "address.city"
})
```

When you check a request without `value`, conditional allow rules can still
authorize the action for the subject type. Pass `value` when you need object
conditions to be evaluated for a specific resource. Conditional deny rules also
need a value before their conditions can match; unconditional deny rules still
apply without a value.

## Permitted Fields

Use `Ability.permittedFields` to derive the request fields allowed by matching
rules. Allow rules add fields; deny rules remove fields.

**Syntax**

```ts
Ability.permittedFields(ability, request, {
  fieldsFrom: (rule) => rule.fields ?? fallbackFields
})
```

**Example**

```ts
const fields = yield* Ability.permittedFields(
  ability,
  {
    action: "update",
    subject: "Post",
    value: post
  },
  {
    fieldsFrom: (rule) => rule.fields ?? ["id", "authorId", "published", "title", "body"]
  }
)
```

`fieldsFrom` is used when a matching rule does not declare explicit fields.

## Subjects

A check request can provide the subject name explicitly:

```ts
yield* Ability.check(ability, {
  action: "read",
  subject: "Post",
  value: post
})
```

You can also wrap a value with a subject name:

```ts
const wrapped = Ability.subject("Post", post)

yield* Ability.check(ability, {
  action: "read",
  value: wrapped
})

const original = Ability.unwrapSubject(wrapped)
```

`Ability.subject` is pure and does not mutate the wrapped object.

If neither `subject` nor a typed subject wrapper is provided, configure subject
detection:

```ts
const ability = Ability.define<Subjects>()(
  function* (ability) {
    yield* ability.allow("read", "Post")
  },
  {
    detectSubjectType: (value) => (value as {readonly __typename: "Post"}).__typename
  }
)

yield* Ability.check(ability, {
  action: "read",
  value: {
    ...post,
    __typename: "Post"
  }
})
```

Without a custom detector, subject detection falls back to constructor metadata
when available.

## Action Aliases

Action aliases expand one rule action into additional checkable actions.

**Example**

```ts
const ability = Ability.define<Subjects>()(
  function* (ability) {
    yield* ability.allow("modify", "Post", {
      fields: ["title", "body"],
      conditions: {authorId: "u1"}
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

Aliases are one-directional. A `modify` rule matches `update` and `delete`, but
separate `update` and `delete` rules do not imply `modify`.

Invalid aliases fail fast:

- `manage` cannot be used as an alias name.
- Aliases cannot target `manage`.
- Aliases cannot target an empty list.
- Cyclic aliases are rejected.

## Raw Rules And Updates

Raw rules are JSON-safe data structures.

**Syntax**

```ts
Ability.fromRawRules<Subjects>(rules, options)
Ability.toRawRules(ability)
Ability.update(ability, rules)
ability.pipe(Ability.update(rules))
```

**Example**

```ts
const ability = yield* Ability.fromRawRules<Subjects>([
  {
    action: "read",
    subject: "Post",
    conditions: {authorId: "u1"}
  },
  {
    action: "delete",
    subject: "Post",
    inverted: true,
    reason: "No deletes"
  }
])

const rules = yield* Ability.toRawRules(ability)

const nextAbility = yield* Ability.update(ability, [
  {
    action: "read",
    subject: "Post"
  }
])
```

`Ability.update` returns a new immutable ability and reuses the current ability
options, including action aliases and subject detection.

`Ability.fromRawRules` and `Ability.update` can fail with:

- `RawRuleError` for invalid raw rules.
- `AliasError` for invalid action alias configuration.

## Introspection

The introspection helpers are also Effect values and support data-first and
data-last usage.

| Function | Behavior |
| -------- | -------- |
| `Ability.possibleRulesFor` | Returns rules that may apply before field and condition checks. |
| `Ability.rulesFor` | Returns rules that may apply after field checks, but before condition checks. |
| `Ability.relevantRuleFor` | Returns the winning rule after field and condition checks. |
| `Ability.actionsFor` | Returns actions that have rules for a subject. |

**Example**

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

const actions = yield* ability.pipe(
  Ability.actionsFor({
    subject: "Post"
  })
)
```

`possibleRulesFor`, `rulesFor`, and `actionsFor` can fail with
`SubjectDetectionError`. `relevantRuleFor` can also fail with `ConditionError`.

## AbilityExtra

`AbilityExtra` works with already-defined abilities and JSON-safe rules.

### Compact Rule Transport

```ts
import {AbilityExtra} from "@nmnmcc/ability"

const packed = AbilityExtra.packRules(rules)
const unpacked = AbilityExtra.unpackRules(packed)
```

`packRules` converts raw rules into compact tuples. `unpackRules` restores the
raw rule objects.

### Default Fields From Conditions

`rulesToFields` extracts scalar condition values from matching allow rules. This
is useful when creating initial values from authorization rules.

```ts
const defaults = yield* AbilityExtra.rulesToFields(ability, {
  action: "read",
  subject: "Post"
})
```

For a rule with `{conditions: {authorId: "u1"}}`, the returned object includes
`{authorId: "u1"}`.

### Rule-To-Query Conversion

Use `rulesToCondition` when you own the logical query representation:

```ts
const condition = yield* AbilityExtra.rulesToCondition(
  ability,
  {
    action: "read",
    subject: "Post"
  },
  (rule) => rule.conditions ?? {},
  {
    and: (conditions) => ({$and: conditions}),
    or: (conditions) => ({$or: conditions}),
    not: (condition) => ({$not: condition}),
    empty: () => ({})
  }
)
```

Use `rulesToQuery` for the built-in generic logical shape:

```ts
const query = yield* ability.pipe(
  AbilityExtra.rulesToQuery(
    {
      action: "read",
      subject: "Post"
    },
    (rule) => rule.conditions ?? {}
  )
)
```

Rule conversion callbacks may return plain values or Effects. If a conversion
callback throws, the helper fails with `QueryGenerationError`.

## CASL Peer Dependency

This package uses the official CASL rule engine for indexing and Mongo-style
condition matching, but it does not re-export CASL APIs.

Import CASL APIs from `@casl/ability` when you need them:

```ts
import {AbilityBuilder, createMongoAbility, subject} from "@casl/ability"

const {can, cannot, build} = new AbilityBuilder(createMongoAbility)

can("read", "Post")
cannot("delete", "Post", {published: true})

const caslAbility = build()
const canRead = caslAbility.can("read", subject("Post", post))
```

ORM adapters and `accessibleBy`-style helpers are not implemented here. Use the
official CASL ecosystem packages for those integrations.

## Examples

- [examples/basic.ts](./examples/basic.ts)
- [examples/advanced.ts](./examples/advanced.ts)
- [tests/Ability.test.ts](./tests/Ability.test.ts)
