# ability

An Effect-style authorization library inspired by CASL.

The public API is a module of pure functions instead of mutable classes:

- `Ability.define` builds an immutable ability from a generator DSL.
- `Ability.check` returns an `Effect` that fails with a typed `AuthorizationError`.
- `Ability.allows` returns an effectful boolean for predicates that may need services.

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

interface User {
  readonly id: string
  readonly role: "admin" | "editor" | "guest"
}

type Subjects = {
  readonly Post: Post
  readonly User: User
}

const currentUser = {
  id: "u1",
  role: "editor"
} as const

const makeAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post")

  yield* ability.allow("update", "Post", {
    fields: ["title", "body"],
    when: (post) => post.authorId === currentUser.id,
    reason: "Authors can edit their own draft content"
  })

  yield* ability.deny("delete", "Post", {
    when: (post) => post.published,
    reason: "Published posts cannot be deleted"
  })
})

const program = Effect.gen(function* () {
  const ability = yield* makeAbility
  const post: Post = {
    id: "p1",
    authorId: "u1",
    published: false,
    title: "Hello",
    body: "World"
  }

  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })
})
```

The ability is automatically typed from the rules yielded in `Ability.define`.

```ts
Effect.gen(function* () {
  const ability = yield* makeAbility
  const post = {} as Post

  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })

  yield* Ability.check(ability, {
    action: "publish",
    subject: "Post",
    value: post
  })
  // TypeScript error: "publish" was not defined by this ability.
})
```

Denied checks fail through the Effect error channel:

```ts
const guarded = Effect.gen(function* () {
  const ability = yield* makeAbility
  yield* Ability.check(ability, {
    action: "delete",
    subject: "Post",
    value: {
      id: "p1",
      authorId: "u1",
      published: true,
      title: "Hello",
      body: "World"
    }
  })
}).pipe(
  Effect.catchTag("AuthorizationError", (error) =>
    Effect.succeed(error.reason)
  )
)
```

See [examples/basic.ts](./examples/basic.ts) for a runnable example and [tests/Ability.test.ts](./tests/Ability.test.ts) for `@effect/vitest` coverage.
