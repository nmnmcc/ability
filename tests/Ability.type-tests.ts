import { Context, Data, Effect } from "effect"
import { Ability } from "../src/index"

interface Address {
  readonly city: string
  readonly street: string
}

interface Post {
  readonly id: string
  readonly authorId: string
  readonly published: boolean
  readonly title: string
  readonly body: string
  readonly address: Address
}

interface User {
  readonly id: string
  readonly role: "admin" | "editor" | "guest"
}

type Subjects = {
  readonly Post: Post
  readonly User: User
}

const ability = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow(["read", "update"], "Post", {
    fields: ["title", "address.city"],
    conditions: { authorId: "u1" },
    when: (post) => post.authorId === "u1"
  })
  yield* ability.deny("delete", "Post", {
    when: (post) => post.published
  })
})

export const validUsage = Effect.gen(function* () {
  const post = {} as Post

  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "address.city"
  })
})

export const invalidAction = Effect.gen(function* () {
  const post = {} as Post

  yield* Ability.check(ability, {
    // @ts-expect-error "publish" is not defined by the ability
    action: "publish",
    subject: "Post",
    value: post
  })
})

export const invalidField = Effect.gen(function* () {
  const post = {} as Post

  // @ts-expect-error only "title" and "address.city" are allowed by the update rule
  yield* Ability.check(ability, {
    action: "update",
    subject: "Post",
    value: post,
    field: "body"
  })
})

export const invalidSubject = Effect.gen(function* () {
  const user = {} as User

  yield* Ability.check(ability, {
    action: "read",
    // @ts-expect-error the read rule was defined for Post, not User
    subject: "User",
    value: user
  })
})

const manageAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("manage", "all")
})

export const manageAllUsage = Effect.gen(function* () {
  const user = {} as User

  yield* Ability.check(manageAbility, {
    action: "publish",
    subject: "User",
    value: user
  })
})

export const invalidManageValue = Effect.gen(function* () {
  const user = {} as User

  // @ts-expect-error value must match the explicit subject
  yield* Ability.check(manageAbility, {
    action: "publish",
    subject: "Post",
    value: user
  })
})

export const typedSubjectUsage = Effect.gen(function* () {
  const post = {} as Post

  yield* Ability.check(ability, {
    action: "read",
    value: Ability.subject("Post", post)
  })
})

class PredicateError extends Data.TaggedError("PredicateError")<{}> {}

class PolicyService extends Context.Service<PolicyService, {
  readonly allowed: boolean
}>()("PolicyService") {}

const effectfulAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post", {
    when: () => Effect.gen(function* () {
      const service = yield* PolicyService
      if (service.allowed) {
        return true
      }
      return yield* Effect.fail(new PredicateError())
    })
  })
})

export const predicateErrorProgram = Effect.gen(function* () {
  const post = {} as Post

  yield* Ability.check(effectfulAbility, {
    action: "read",
    subject: "Post",
    value: post
  })
})

type HasError<Errors, Error> = Extract<Errors, Error> extends never ? false : true
type HasService<Services, Service> = Extract<Services, Service> extends never ? false : true
type Expect<Condition extends true> = Condition

export type PredicateErrorIsCarried = Expect<HasError<Effect.Error<typeof predicateErrorProgram>, PredicateError>>
export type AuthorizationErrorIsCarried = Expect<HasError<Effect.Error<typeof predicateErrorProgram>, Ability.AuthorizationError>>
export type PolicyServiceIsCarried = Expect<HasService<Effect.Services<typeof predicateErrorProgram>, PolicyService>>
