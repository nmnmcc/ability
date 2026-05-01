import { Data, Effect } from "effect"
import { Ability } from "../src/index"

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

const makeAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post")
  yield* ability.allow("update", "Post", {
    fields: ["title"],
    when: (post) => post.authorId === "u1"
  })
  yield* ability.deny("delete", "Post", {
    when: (post) => post.published
  })
})

export const validUsage = Effect.gen(function* () {
  const ability = yield* makeAbility
  const post = {} as Post

  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })
})

export const invalidAction = Effect.gen(function* () {
  const ability = yield* makeAbility
  const post = {} as Post

  yield* Ability.check(ability, {
    // @ts-expect-error "publish" is not defined by the ability
    action: "publish",
    subject: "Post",
    value: post
  })
})

export const invalidField = Effect.gen(function* () {
  const ability = yield* makeAbility
  const post = {} as Post

  // @ts-expect-error only "title" is allowed by the update rule
  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "body"
  })
})

export const invalidSubject = Effect.gen(function* () {
  const ability = yield* makeAbility
  const user = {} as User

  yield* Ability.check(ability, {
    action: "read",
    // @ts-expect-error the read rule was defined for Post, not User
    subject: "User",
    // @ts-expect-error the value must match the selected subject type
    value: user
  })
})

class PredicateError extends Data.TaggedError("PredicateError")<{}> {}

const makeEffectfulAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post", {
    when: () => Effect.fail(new PredicateError())
  })
})

export const predicateErrorProgram = Effect.gen(function* () {
  const ability = yield* makeEffectfulAbility
  const post = {} as Post

  yield* Ability.check(ability, {
    action: "read",
    subject: "Post",
    value: post
  })
})

type HasError<Errors, Error> = Extract<Errors, Error> extends never ? false : true
type Expect<Condition extends true> = Condition

export type PredicateErrorIsCarried = Expect<HasError<Effect.Error<typeof predicateErrorProgram>, PredicateError>>

