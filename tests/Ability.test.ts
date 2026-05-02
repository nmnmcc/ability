import {assert, describe, it} from "@effect/vitest"
import {Effect, Equal, Hash} from "effect"
import {Ability, AbilityExtra, Casl} from "../src/index"

interface Comment {
  readonly authorId: string
  readonly body: string
}

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

const draftPost: Post = {
  id: "p1",
  authorId: "u1",
  published: false,
  title: "Hello",
  body: "World",
  tags: ["effect", "auth"],
  comments: [{authorId: "u1", body: "Nice"}],
  address: {
    city: "Shanghai",
    street: "Century Avenue"
  }
}

const publishedPost: Post = {
  ...draftPost,
  published: true
}

describe("Ability", () => {
  it("defines an ability synchronously", () => {
    const ability = Ability.define<Subjects>()(function* (ability) {
      yield* ability.allow("read", "Post")
    })

    assert.strictEqual(Effect.isEffect(ability), false)
    assert.strictEqual(ability.rules.length, 1)
  })

  it.effect("supports manage/all and later deny overrides", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("manage", "all")
        yield* ability.deny("delete", "Post", {
          conditions: {published: true},
          reason: "Published posts cannot be deleted"
        })
      })

      yield* Ability.check(ability, {
        action: "read",
        subject: "User"
      })

      const reason = yield* Ability.check(ability, {
        action: "delete",
        subject: "Post",
        value: publishedPost
      }).pipe(Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error.reason)))

      assert.strictEqual(reason, "Published posts cannot be deleted")
    })
  )

  it.effect("supports multiple actions, conditions, and field restrictions", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow(["read", "update"], "Post", {
          fields: ["title", "address.**"],
          conditions: {authorId: "u1"}
        })
      })

      yield* Ability.check(ability, {
        action: "update",
        subject: "Post",
        value: draftPost,
        field: "address.city"
      })

      const deniedField = yield* Ability.check(ability, {
        action: "update",
        subject: "Post",
        value: draftPost,
        field: "body"
      }).pipe(Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error._tag)))

      const deniedCondition = yield* Ability.check(ability, {
        action: "update",
        subject: "Post",
        value: {
          ...draftPost,
          authorId: "u2"
        },
        field: "title"
      }).pipe(Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error._tag)))

      assert.strictEqual(deniedField, "AuthorizationError")
      assert.strictEqual(deniedCondition, "AuthorizationError")
    })
  )

  it.effect("supports Mongo-style condition operators", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: {
            published: {$eq: false},
            comments: {
              $elemMatch: {
                authorId: "u1"
              }
            }
          }
        })
      })

      yield* Ability.check(ability, {
        action: "read",
        subject: "Post",
        value: draftPost
      })
    })
  )

  it.effect("uses pure subject wrappers without mutating values", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: {authorId: "u1"}
        })
      })
      const wrapped = Ability.subject("Post", draftPost)

      yield* Ability.check(ability, {
        action: "read",
        value: wrapped
      })

      assert.strictEqual(Ability.unwrapSubject(wrapped), draftPost)
      assert.deepStrictEqual(Object.keys(draftPost), [
        "id",
        "authorId",
        "published",
        "title",
        "body",
        "tags",
        "comments",
        "address"
      ])
    })
  )

  it.effect("detects subject types with a custom detector", () =>
    Effect.gen(function* () {
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
          ...draftPost,
          __typename: "Post"
        }
      })
    })
  )

  it.effect("computes permitted fields with deny rules removing fields", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("update", "Post", {
          fields: ["title", "body"],
          conditions: {authorId: "u1"}
        })
        yield* ability.deny("update", "Post", {
          fields: ["body"],
          conditions: {published: true}
        })
      })

      const fields = yield* Ability.permittedFields(
        ability,
        {
          action: "update",
          subject: "Post",
          value: publishedPost
        },
        {
          fieldsFrom: (rule) => rule.fields ?? ["id", "authorId", "published", "title", "body"]
        }
      )

      assert.deepStrictEqual(fields, ["title"])
    })
  )

  it.effect("round-trips raw rules", () =>
    Effect.gen(function* () {
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

      const rawRules = yield* Ability.toRawRules(ability)

      assert.strictEqual(rawRules.length, 2)
      assert.strictEqual(rawRules[1]?.inverted, true)
    })
  )

  it.effect("updates by returning a new ability without mutating the original", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("access", "Post")
        },
        {
          actionAliases: {
            access: ["read"]
          } as const
        }
      )

      const next = yield* Ability.update(ability, [
        {
          action: "access",
          subject: "Post",
          inverted: true,
          reason: "Read disabled"
        }
      ])
      const dataLast = yield* ability.pipe(
        Ability.update([
          {
            action: "access",
            subject: "Post"
          }
        ])
      )

      yield* Ability.check(ability, {
        action: "read",
        subject: "Post"
      })

      const reason = yield* Ability.check(next, {
        action: "read",
        subject: "Post"
      }).pipe(Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error.reason)))

      assert.strictEqual(reason, "Read disabled")
      assert.strictEqual(ability.rules.length, 1)
      assert.strictEqual(next.rules.length, 1)
      assert.strictEqual(dataLast.rules.length, 1)
      assert.notStrictEqual(next, ability)
    })
  )

  it.effect("fails fromRawRules with AliasError for invalid aliases", () =>
    Effect.gen(function* () {
      const error = yield* Ability.fromRawRules<Subjects>(
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
      ).pipe(Effect.flip)

      assert.strictEqual(error._tag, "AliasError")
    })
  )

  it.effect("expands action aliases in one direction", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("modify", "Post", {
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
        value: draftPost
      })

      const relevantRule = yield* Ability.relevantRuleFor(ability, {
        action: "delete",
        subject: "Post",
        value: draftPost
      })

      const reverseAlias = yield* Ability.check(
        Ability.define<Subjects>()(
          function* (ability) {
            yield* ability.allow(["update", "delete"], "Post")
          },
          {
            actionAliases: {
              modify: ["update", "delete"]
            } as const
          }
        ),
        {
          action: "modify" as never,
          subject: "Post",
          value: draftPost
        }
      ).pipe(Effect.catchTag("AuthorizationError", (error) => Effect.succeed(error._tag)))

      assert.strictEqual(relevantRule?.action, "modify")
      assert.strictEqual(reverseAlias, "AuthorizationError")
    })
  )

  it("rejects invalid action aliases", () => {
    assert.throws(
      () =>
        Ability.define<Subjects>()(
          function* (ability) {
            yield* ability.allow("read", "Post")
          },
          {
            actionAliases: {
              access: "access"
            } as const
          }
        ),
      Ability.AliasError
    )

    assert.throws(() => Ability.createAliasResolver({manage: "read"}), Ability.AliasError)
  })

  it.effect("exposes indexed rules and actions for introspection", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("manage", "all")
          yield* ability.allow("access", "Post", {
            fields: ["title"]
          })
          yield* ability.deny("delete", "Post", {
            reason: "No deletes"
          })
        },
        {
          actionAliases: {
            access: ["read", "update"]
          } as const
        }
      )

      const possibleRules = yield* Ability.possibleRulesFor(ability, {
        action: "delete",
        subject: "Post"
      })
      const fieldRules = yield* Ability.rulesFor(ability, {
        action: "update",
        subject: "Post",
        field: "title"
      })
      const actions = yield* Ability.actionsFor(ability, {
        subject: "Post"
      })

      assert.deepStrictEqual(
        possibleRules.map((rule) => rule._tag),
        ["Deny", "Allow"]
      )
      assert.deepStrictEqual(
        fieldRules.map((rule) => rule.action),
        ["access", "manage"]
      )
      assert.deepStrictEqual([...actions].sort(), ["access", "delete", "manage", "read", "update"])
    })
  )

  it.effect("converts JSON-safe abilities to official CASL Mongo abilities", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(
        function* (ability) {
          yield* ability.allow("access", "Post", {
            fields: ["title"],
            conditions: {authorId: "u1"}
          })
        },
        {
          actionAliases: {
            access: ["read", "update"]
          } as const
        }
      )

      const caslAbility = yield* Casl.toMongoAbility(ability)

      assert.strictEqual(caslAbility.can("update", Casl.subject("Post", draftPost), "title"), true)
      assert.strictEqual(
        caslAbility.can("update", Casl.subject("Post", {...draftPost, authorId: "u2"}), "title"),
        false
      )
    })
  )

  it.effect("implements guards, equality, hashing, and inspection protocols", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post")
      })
      const sameAbility = Ability.make<Subjects, (typeof ability.rules)[number]>(ability.rules, ability.options)
      const rule = ability.rules[0]!
      const wrapped = Ability.subject("Post", draftPost)

      assert.strictEqual(Ability.isAbility(ability), true)
      assert.strictEqual(Ability.isAbility(rule), false)
      assert.strictEqual(Ability.isRule(rule), true)
      assert.strictEqual(Ability.isRule(ability), false)
      assert.strictEqual(Ability.isSubject(wrapped), true)
      assert.strictEqual(Equal.equals(rule, rule), true)
      assert.strictEqual(Equal.equals(wrapped, Ability.subject("Post", draftPost)), true)
      assert.strictEqual(Equal.equals(ability, sameAbility), true)
      assert.strictEqual(typeof Hash.hash(ability), "number")
      assert.strictEqual(typeof Hash.hash(rule), "number")
      assert.strictEqual(typeof Hash.hash(wrapped), "number")
      assert.strictEqual(String(ability).includes("Ability"), true)
      assert.strictEqual(String(rule).includes("Allow"), true)
    })
  )
})

describe("AbilityExtra", () => {
  it("packs and unpacks raw rules without comma-joining arrays", () => {
    const rawRules: ReadonlyArray<Ability.RawRule> = [
      {
        action: ["read", "update"],
        subject: "Post",
        fields: ["title", "body"],
        conditions: {authorId: "u1"}
      },
      {
        action: "delete",
        subject: "Post",
        inverted: true,
        reason: "No deletes"
      }
    ]

    const packed = AbilityExtra.packRules(rawRules)
    const unpacked = AbilityExtra.unpackRules(packed)

    assert.deepStrictEqual(unpacked, rawRules)
    assert.deepStrictEqual(packed[0]?.[0], ["read", "update"])
  })

  it.effect("extracts scalar condition fields", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("create", "Post", {
          conditions: {
            authorId: "u1",
            address: {
              city: "Shanghai"
            },
            title: {$regex: "^Draft"}
          }
        })
      })

      const fields = yield* AbilityExtra.rulesToFields(ability, {
        action: "create",
        subject: "Post"
      })

      assert.deepStrictEqual(fields, {
        authorId: "u1"
      })

      const dataLastFields = yield* ability.pipe(
        AbilityExtra.rulesToFields({
          action: "create",
          subject: "Post"
        })
      )

      assert.deepStrictEqual(dataLastFields, fields)
    })
  )

  it.effect("converts rules to generic logical conditions", () =>
    Effect.gen(function* () {
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: {authorId: "u1"}
        })
        yield* ability.allow("read", "Post", {
          conditions: {published: true}
        })
        yield* ability.deny("read", "Post", {
          conditions: {published: false}
        })
      })

      const condition = yield* AbilityExtra.rulesToCondition(
        ability,
        {
          action: "read",
          subject: "Post"
        },
        (rule) => rule.conditions as Record<string, unknown>,
        {
          and: (conditions) => ({$and: conditions}),
          or: (conditions) => ({$or: conditions}),
          not: (condition) => ({$not: condition}),
          empty: () => ({})
        }
      )

      assert.deepStrictEqual(condition, {
        $or: [
          {
            $and: [{published: true}, {$not: {published: false}}]
          },
          {
            $and: [{authorId: "u1"}, {$not: {published: false}}]
          }
        ]
      })

      const dataLastCondition = yield* ability.pipe(
        AbilityExtra.rulesToCondition(
          {
            action: "read",
            subject: "Post"
          },
          (rule) => rule.conditions as Record<string, unknown>,
          {
            and: (conditions) => ({$and: conditions}),
            or: (conditions) => ({$or: conditions}),
            not: (condition) => ({$not: condition}),
            empty: () => ({})
          }
        )
      )

      assert.deepStrictEqual(dataLastCondition, condition)
    })
  )

  it.effect("fails query generation when conversion throws", () =>
    Effect.gen(function* () {
      const cause = new Error("boom")
      const ability = Ability.define<Subjects>()(function* (ability) {
        yield* ability.allow("read", "Post", {
          conditions: {authorId: "u1"}
        })
      })

      const error = yield* AbilityExtra.rulesToQuery(
        ability,
        {
          action: "read",
          subject: "Post"
        },
        () => {
          throw cause
        }
      ).pipe(Effect.flip)

      assert.strictEqual(error._tag, "QueryGenerationError")
      assert.strictEqual(error.cause, cause)

      const dataLastQueryError = yield* ability.pipe(
        AbilityExtra.rulesToQuery(
          {
            action: "read",
            subject: "Post"
          },
          () => {
            throw cause
          }
        ),
        Effect.catchTag("QueryGenerationError", (error) => Effect.succeed(error._tag))
      )

      assert.strictEqual(dataLastQueryError, "QueryGenerationError")
    })
  )
})
