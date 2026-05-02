import {Context, Effect} from "effect"
import {describe, expect, it} from "tstyche"
import {Ability, AbilityExtra} from "../src/index"

interface Comment {
  readonly authorId: string
  readonly body: string
}

interface Address {
  readonly city: string
  readonly street: string
  readonly location: {
    readonly lat: number
    readonly lng: number
  }
}

interface Post {
  readonly id: string
  readonly authorId: string
  readonly published: boolean
  readonly title: string
  readonly body: string
  readonly tags: ReadonlyArray<string>
  readonly comments: ReadonlyArray<Comment>
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

class QueryService extends Context.Service<
  QueryService,
  {
    readonly make: (rule: Ability.Rule<Ability.RuleKind, string, string, object, string>) => Effect.Effect<
      {
        readonly rule: string
      },
      "query-error"
    >
  }
>()("QueryService") {}

declare const post: Post
declare const user: User
declare const queryWithService: Effect.Effect<{readonly ownerId: string}, "query-error", QueryService>

const builder = {} as Ability.Builder<Subjects>

const postAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow(["read", "update"], "Post", {
    fields: ["title", "address.city"],
    conditions: {
      authorId: "u1",
      published: {$eq: false}
    }
  })
  yield* ability.deny("delete", "Post", {
    conditions: {published: true},
    reason: "Published posts cannot be deleted"
  })
})

const aliasAbility = Ability.define<Subjects>()(
  function* (ability) {
    yield* ability.allow("maintain", "Post", {
      fields: ["title"]
    })
  },
  {
    actionAliases: {
      maintain: "modify",
      modify: ["update", "delete"]
    } as const
  }
)

const manageAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("manage", "all")
})

const mixedSubjectAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "User")
  yield* ability.allow("delete", "Post")
})

type CheckRequestOf<Self> =
  Self extends Ability.Ability<infer Subjects, infer Rules, infer Aliases>
    ? Ability.CheckRequest<Subjects, Rules, Aliases>
    : never

type SubjectQueryRequestOf<Self> =
  Self extends Ability.Ability<infer Subjects, infer Rules, infer _Aliases>
    ? Ability.SubjectQueryRequest<Subjects, Rules>
    : never

const acceptPostCheckRequest = (_request: CheckRequestOf<typeof postAbility>): void => {}
const acceptAliasCheckRequest = (_request: CheckRequestOf<typeof aliasAbility>): void => {}
const acceptManageCheckRequest = (_request: CheckRequestOf<typeof manageAbility>): void => {}
const acceptMixedSubjectCheckRequest = (_request: CheckRequestOf<typeof mixedSubjectAbility>): void => {}
const acceptPostSubjectQueryRequest = (_request: SubjectQueryRequestOf<typeof postAbility>): void => {}

describe("Ability type tests", () => {
  describe("builder", () => {
    it("infers rule literals and field literals", () => {
      const allowRule = builder.allow("read", "Post")
      const updateRule = builder.allow("update", "Post", {
        fields: ["title", "address.city"],
        conditions: {authorId: "u1"}
      })
      const denyRule = builder.deny(["delete", "archive"], "Post", {
        reason: "locked"
      })

      expect(allowRule).type.toBe<Ability.Rule<"Allow", "read", "Post", Post, Ability.FieldOf<Post>>>()
      expect(updateRule).type.toBe<Ability.Rule<"Allow", "update", "Post", Post, "title" | "address.city">>()
      expect(denyRule).type.toBe<Ability.Rule<"Deny", "delete" | "archive", "Post", Post, Ability.FieldOf<Post>>>()
    })

    it("rejects unknown subjects, fields, and condition shapes", () => {
      expect(builder.allow).type.not.toBeCallableWith("read", "Account")
      expect(builder.allow).type.not.toBeCallableWith("read", "Post", {
        fields: ["address.country"]
      })
      expect(builder.allow).type.not.toBeCallableWith("read", "Post", {
        conditions: {published: "yes"}
      })
      expect(builder.allow).type.not.toBeCallableWith("read", "Post", {
        conditions: {
          tags: {$in: ["effect"]}
        }
      })
    })
  })

  describe("define", () => {
    it("returns an Ability synchronously and records yielded rules", () => {
      expect(postAbility).type.toBeAssignableTo<Ability.Ability<Subjects, (typeof postAbility)["rules"][number]>>()
      expect(postAbility).type.not.toBeAssignableTo<Effect.Effect<unknown, unknown, unknown>>()
      expect<(typeof postAbility)["rules"][number]["subject"]>().type.toBe<Ability.SingleOrReadonlyArray<"Post">>()
      expect<(typeof postAbility)["rules"][number]["action"]>().type.toBe<
        Ability.SingleOrReadonlyArray<"read" | "update"> | Ability.SingleOrReadonlyArray<"delete">
      >()
    })
  })

  describe("check", () => {
    it("preserves the Effect success and error contract", () => {
      const result = Ability.check(postAbility, {
        action: "update",
        subject: "Post",
        value: post,
        field: "address.city"
      })

      expect(result).type.toBe<
        Effect.Effect<void, Ability.AuthorizationError | Ability.ConditionError | Ability.SubjectDetectionError>
      >()
    })

    it("accepts data-first and data-last valid requests", () => {
      expect(acceptPostCheckRequest).type.toBeCallableWith({
        action: "read",
        subject: "Post",
        value: post,
        field: "title"
      })
      expect(postAbility.pipe(Ability.check({action: "read", subject: "Post", value: post}))).type.toBe<
        Effect.Effect<void, Ability.AuthorizationError | Ability.ConditionError | Ability.SubjectDetectionError>
      >()
    })

    it("rejects invalid explicit requests", () => {
      expect(acceptPostCheckRequest).type.not.toBeCallableWith({
        action: "publish",
        subject: "Post",
        value: post
      })
      expect(acceptPostCheckRequest).type.not.toBeCallableWith({
        action: "read",
        subject: "User",
        value: user
      })
      expect(acceptPostCheckRequest).type.not.toBeCallableWith({
        action: "read",
        subject: "Post",
        value: user
      })
      expect(acceptPostCheckRequest).type.not.toBeCallableWith({
        action: "update",
        subject: "Post",
        value: post,
        field: "body"
      })
    })

    it("keeps action and subject pairs correlated", () => {
      expect(acceptMixedSubjectCheckRequest).type.toBeCallableWith({
        action: "read",
        subject: "User",
        value: user
      })
      expect(acceptMixedSubjectCheckRequest).type.toBeCallableWith({
        action: "delete",
        subject: "Post",
        value: post
      })
      expect(acceptMixedSubjectCheckRequest).type.not.toBeCallableWith({
        action: "delete",
        subject: "User",
        value: user
      })
      expect(acceptMixedSubjectCheckRequest).type.not.toBeCallableWith({
        action: "read",
        subject: "Post",
        value: post
      })
    })

    it("supports typed subjects and detected subjects", () => {
      const wrapped = Ability.subject("Post", post)

      expect(wrapped).type.toBe<Ability.TypedSubject<"Post", Post>>()
      expect(Ability.unwrapSubject(wrapped)).type.toBe<Post>()
      expect(Ability.unwrapSubject(post)).type.toBe<Post>()
      expect(acceptPostCheckRequest).type.toBeCallableWith({
        action: "read",
        value: wrapped,
        field: "title"
      })
      expect(acceptPostCheckRequest).type.toBeCallableWith({
        action: "read",
        value: post,
        field: "runtime.path"
      })
      expect(acceptPostCheckRequest).type.not.toBeCallableWith({
        action: "read",
        subject: "User",
        value: wrapped
      })
    })

    it("expands aliases in one direction", () => {
      expect(acceptAliasCheckRequest).type.toBeCallableWith({
        action: "maintain",
        subject: "Post",
        value: post,
        field: "title"
      })
      expect(acceptAliasCheckRequest).type.toBeCallableWith({
        action: "modify",
        subject: "Post",
        value: post,
        field: "title"
      })
      expect(acceptAliasCheckRequest).type.toBeCallableWith({
        action: "update",
        subject: "Post",
        value: post,
        field: "title"
      })
      expect(acceptAliasCheckRequest).type.not.toBeCallableWith({
        action: "publish",
        subject: "Post",
        value: post
      })
    })

    it("allows manage/all while preserving explicit subject values", () => {
      expect(acceptManageCheckRequest).type.toBeCallableWith({
        action: "publish",
        subject: "User",
        value: user
      })
      expect(acceptManageCheckRequest).type.not.toBeCallableWith({
        action: "publish",
        subject: "Post",
        value: user
      })
    })
  })

  describe("rule accessors", () => {
    it("narrows matching rules for request-aware APIs", () => {
      const rules = Ability.rulesFor(postAbility, {
        action: "read",
        subject: "Post"
      })
      const relevant = Ability.relevantRuleFor(postAbility, {
        action: "delete",
        subject: "Post",
        value: post
      })

      expect<Effect.Success<typeof rules>[number]["action"]>().type.toBe<
        Ability.SingleOrReadonlyArray<"read" | "update">
      >()
      expect<Effect.Success<typeof rules>[number]["subject"]>().type.toBe<Ability.SingleOrReadonlyArray<"Post">>()
      expect(relevant).type.toBe<
        Effect.Effect<
          Ability.Rule<"Deny", "delete", "Post", Post, Ability.FieldOf<Post>> | undefined,
          Ability.ConditionError | Ability.SubjectDetectionError
        >
      >()
    })

    it("preserves action and subject query constraints", () => {
      const actions = Ability.actionsFor(postAbility, {subject: "Post"})

      expect(actions).type.toBe<
        Effect.Effect<ReadonlyArray<"read" | "update" | "delete">, Ability.SubjectDetectionError>
      >()
      expect(acceptPostSubjectQueryRequest).type.not.toBeCallableWith({subject: "Account"})
    })
  })

  describe("raw rules", () => {
    it("preserves constructor error channels and subject constraints", () => {
      const rawRules = [
        {
          action: "read",
          subject: "Post",
          fields: ["title"],
          conditions: {authorId: "u1"}
        }
      ] as const satisfies ReadonlyArray<Ability.RawRule<"read", "Post", "title", {readonly authorId: "u1"}>>

      const fromRaw = Ability.fromRawRules<Subjects>(rawRules)
      const updated = Ability.update(postAbility, rawRules)

      expect<Effect.Error<typeof fromRaw>>().type.toBe<Ability.AliasError | Ability.RawRuleError>()
      expect<Effect.Error<typeof updated>>().type.toBe<Ability.AliasError | Ability.RawRuleError>()
      expect(Ability.fromRawRules<Subjects>).type.not.toBeCallableWith([
        {
          action: "read",
          subject: "Account"
        }
      ])
      expect(Ability.update).type.not.toBeCallableWith(postAbility, [
        {
          action: "read",
          subject: "Account"
        }
      ])
    })
  })

  describe("AbilityExtra", () => {
    it("preserves compact raw rule tuple types", () => {
      const rawRules = [
        {
          action: "read",
          subject: "Post",
          fields: ["title"],
          conditions: {authorId: "u1"},
          reason: "owner"
        }
      ] as const satisfies ReadonlyArray<Ability.RawRule<"read", "Post", "title", {readonly authorId: "u1"}>>

      const packed = AbilityExtra.packRules(rawRules)
      const unpacked = AbilityExtra.unpackRules(packed)

      expect(packed).type.toBe<ReadonlyArray<AbilityExtra.PackRule<(typeof rawRules)[number]>>>()
      expect(unpacked).type.toBe<ReadonlyArray<(typeof rawRules)[number]>>()
    })

    it("preserves query conversion errors and services", () => {
      const fields = AbilityExtra.rulesToFields(postAbility, {
        action: "read",
        subject: "Post"
      })
      const query = AbilityExtra.rulesToQuery(
        postAbility,
        {
          action: "read",
          subject: "Post"
        },
        () => queryWithService
      )

      expect(fields).type.toBe<
        Effect.Effect<Readonly<Record<string, unknown>>, Ability.QueryGenerationError | Ability.SubjectDetectionError>
      >()
      expect(query).type.toBe<
        Effect.Effect<
          AbilityExtra.LogicalQuery<{readonly ownerId: string}> | null,
          Ability.QueryGenerationError | Ability.SubjectDetectionError | "query-error",
          QueryService
        >
      >()
    })

    it("checks data-last query helpers", () => {
      const hooks: AbilityExtra.RulesToConditionHooks<{readonly allow: boolean}> = {
        and: () => ({allow: true}),
        or: () => ({allow: true}),
        not: () => ({allow: false}),
        empty: () => ({allow: true})
      }

      expect(
        AbilityExtra.rulesToCondition(
          {
            action: "read",
            subject: "Post"
          },
          (rule) => ({allow: rule._tag === "Allow"}),
          hooks
        )
      ).type.toBeAssignableTo<
        (self: typeof postAbility) => Effect.Effect<{readonly allow: boolean} | null, unknown, unknown>
      >()
      expect(
        postAbility.pipe(
          AbilityExtra.rulesToQuery(
            {
              action: "read",
              subject: "Post"
            },
            () => ({ownerId: "u1"})
          )
        )
      ).type.toBe<
        Effect.Effect<
          AbilityExtra.LogicalQuery<{ownerId: string}> | null,
          Ability.QueryGenerationError | Ability.SubjectDetectionError
        >
      >()
    })
  })
})
