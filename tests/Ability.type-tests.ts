import {Effect} from "effect"
import {Ability, AbilityExtra, Casl} from "../src/index"

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
  readonly tags: ReadonlyArray<string>
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
    conditions: {authorId: "u1"}
  })
  yield* ability.deny("delete", "Post", {
    conditions: {published: true}
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

export const caslAdapterUsage = Effect.gen(function* () {
  const post = {} as Post
  const caslAbility = yield* Casl.toMongoAbility(ability)

  caslAbility.can("read", Casl.subject("Post", post))
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

const aliasAbility = Ability.define<Subjects>()(
  function* (ability) {
    yield* ability.allow("modify", "Post", {
      fields: ["title"],
      conditions: {authorId: "u1"}
    })
  },
  {
    actionAliases: {
      modify: ["update", "delete"]
    } as const
  }
)

export const aliasUsage = Effect.gen(function* () {
  const post = {} as Post

  yield* Ability.check(aliasAbility, {
    action: "update",
    subject: "Post",
    value: post,
    field: "title"
  })
})

export const invalidReverseAliasUsage = Effect.gen(function* () {
  const post = {} as Post
  const reverseAliasAbility = Ability.define<Subjects>()(
    function* (ability) {
      yield* ability.allow(["update", "delete"], "Post")
    },
    {
      actionAliases: {
        modify: ["update", "delete"]
      } as const
    }
  )

  yield* Ability.check(reverseAliasAbility, {
    // @ts-expect-error aliases are one-directional; update/delete rules do not imply modify
    action: "modify",
    subject: "Post",
    value: post
  })
})

export const typedSubjectUsage = Effect.gen(function* () {
  const post = {} as Post

  yield* Ability.check(ability, {
    action: "read",
    value: Ability.subject("Post", post)
  })
})

export const strictCaslConditionTypes = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Post", {
    conditions: {
      published: {$eq: false}
    }
  })

  yield* ability.allow("read", "Post", {
    conditions: {
      // @ts-expect-error CASL MongoQuery does not accept scalar $in values for array fields
      tags: {$in: ["effect"]}
    }
  })
})

export const rawAliasProgram = Ability.fromRawRules<Subjects>(
  [
    {
      action: "read",
      subject: "Post"
    }
  ],
  {
    actionAliases: {
      manage: "read"
    } as const
  }
)

export const updateProgram = Effect.gen(function* () {
  const next = yield* Ability.update(ability, [
    {
      action: "read",
      subject: "Post"
    }
  ])

  yield* ability.pipe(
    Ability.update([
      {
        action: "read",
        subject: "Post"
      }
    ])
  )

  return next
})

export const abilityExtraDataLastProgram = Effect.gen(function* () {
  yield* ability.pipe(
    AbilityExtra.rulesToFields({
      action: "read",
      subject: "Post"
    })
  )
  yield* ability.pipe(
    AbilityExtra.rulesToQuery(
      {
        action: "read",
        subject: "Post"
      },
      (rule) => rule.conditions ?? {}
    )
  )
})

type HasError<Errors, Error> = Extract<Errors, Error> extends never ? false : true
type Expect<Condition extends true> = Condition

export type AuthorizationErrorIsCarried = Expect<HasError<Effect.Error<typeof validUsage>, Ability.AuthorizationError>>
export type RawAliasErrorIsCarried = Expect<HasError<Effect.Error<typeof rawAliasProgram>, Ability.AliasError>>
export type UpdateAliasErrorIsCarried = Expect<HasError<Effect.Error<typeof updateProgram>, Ability.AliasError>>
export type AbilityExtraQueryErrorIsCarried = Expect<
  HasError<Effect.Error<typeof abilityExtraDataLastProgram>, Ability.QueryGenerationError>
>
