import { expect, it } from "@effect/vitest"
import { Data, Effect } from "effect"
import { Ability } from "../src/index"

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

const draftPost: Post = {
  id: "p1",
  authorId: "u1",
  published: false,
  title: "Hello",
  body: "World"
}

const publishedPost: Post = {
  ...draftPost,
  published: true
}

const makeAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post")
  yield* ability.allow("update", "Post", {
    fields: ["title"],
    when: (post) => post.authorId === "u1"
  })
  yield* ability.allow("delete", "Post")
  yield* ability.deny("delete", "Post", {
    when: (post) => post.published,
    reason: "Published posts cannot be deleted"
  })
})

it.effect("allows a matching rule", () =>
  Effect.gen(function* () {
    const ability = yield* makeAbility
    const allowed = yield* Ability.allows(ability, {
      action: "read",
      subject: "Post",
      value: draftPost
    })

    expect(allowed).toBe(true)
  }))

it.effect("denies by default when no rule matches", () =>
  Effect.gen(function* () {
    const ability = yield* makeAbility
    const result = yield* Ability.check(ability, {
      action: "update",
      subject: "Post",
      value: {
        ...draftPost,
        authorId: "u2"
      },
      field: "title"
    }).pipe(
      Effect.catchTag("AuthorizationError", () => Effect.succeed("denied"))
    )

    expect(result).toBe("denied")
  }))

it.effect("uses the last matching rule", () =>
  Effect.gen(function* () {
    const ability = yield* makeAbility
    const reason = yield* Ability.check(ability, {
      action: "delete",
      subject: "Post",
      value: publishedPost
    }).pipe(
      Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error.reason))
    )

    expect(reason).toBe("Published posts cannot be deleted")
  }))

it.effect("checks fields against the matching rule", () =>
  Effect.gen(function* () {
    const ability = yield* makeAbility

    const canUpdateTitle = yield* Ability.allows(ability, {
      action: "update",
      subject: "Post",
      value: draftPost,
      field: "title"
    })

    expect(canUpdateTitle).toBe(true)
  }))

class PredicateError extends Data.TaggedError("PredicateError")<{}> {}

it.effect("preserves predicate errors in the Effect error channel", () =>
  Effect.gen(function* () {
    const ability = yield* Ability.define<Subjects>()(function* (ability) {
      yield* ability.allow("read", "Post", {
        when: () => Effect.fail(new PredicateError())
      })
    })

    const result = yield* Ability.check(ability, {
      action: "read",
      subject: "Post",
      value: draftPost
    }).pipe(
      Effect.catchTag("PredicateError", () => Effect.succeed("predicate failed"))
    )

    expect(result).toBe("predicate failed")
  }))

