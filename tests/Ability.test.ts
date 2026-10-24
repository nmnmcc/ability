import { assert, describe, it } from "@effect/vitest"
import { AbilityBuilder, createMongoAbility, subject } from "@casl/ability"
import { Effect, Equal, Hash } from "effect"
import { Ability, AbilityExtra } from "../src/index.ts"

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
	comments: [{ authorId: "u1", body: "Nice" }],
	address: {
		city: "Shanghai",
		street: "Century Avenue",
	},
}

const publishedPost: Post = {
	...draftPost,
	published: true,
}

describe("Ability", () => {
	it("makes an ability at once", () => {
		const ability = Ability.define<Subjects>()(function* (ability) {
			yield* ability.allow("read", "Post")
		})

		assert.strictEqual(Effect.isEffect(ability), false)
		assert.strictEqual(ability.rules.length, 1)
	})

	it.effect("lets manage and all work, and lets a later deny rule win", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(function* (ability) {
				yield* ability.allow("manage", "all")
				yield* ability.deny("delete", "Post", {
					conditions: { published: true },
					reason: "No one may delete a published post",
				})
			})

			yield* Ability.check(ability, {
				action: "read",
				subject: "User",
			})

			const reason = yield* Ability.check(ability, {
				action: "delete",
				subject: "Post",
				value: publishedPost,
			}).pipe(
				Effect.catchTag("AuthorizationError", (error) =>
					Effect.succeed(error.reason),
				),
			)

			assert.strictEqual(reason, "No one may delete a published post")
		}),
	)

	it.effect(
		"works with more than one action, with conditions, and with field limits",
		() =>
			Effect.gen(function* () {
				const ability = Ability.define<Subjects>()(function* (ability) {
					yield* ability.allow(["read", "update"], "Post", {
						fields: ["title", "address.**"],
						conditions: { authorId: "u1" },
					})
				})

				yield* Ability.check(ability, {
					action: "update",
					subject: "Post",
					value: draftPost,
					field: "address.city",
				})

				const deniedField = yield* Ability.check(ability, {
					action: "update",
					subject: "Post",
					value: draftPost,
					field: "body",
				}).pipe(
					Effect.catchTag("AuthorizationError", (error) =>
						Effect.succeed(error._tag),
					),
				)

				const deniedCondition = yield* Ability.check(ability, {
					action: "update",
					subject: "Post",
					value: {
						...draftPost,
						authorId: "u2",
					},
					field: "title",
				}).pipe(
					Effect.catchTag("AuthorizationError", (error) =>
						Effect.succeed(error._tag),
					),
				)

				assert.strictEqual(deniedField, "AuthorizationError")
				assert.strictEqual(deniedCondition, "AuthorizationError")
			}),
	)

	it.effect("works with Mongo condition operators", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(function* (ability) {
				yield* ability.allow("read", "Post", {
					conditions: {
						published: { $eq: false },
						comments: {
							$elemMatch: {
								authorId: "u1",
							},
						},
					},
				})
			})

			yield* Ability.check(ability, {
				action: "read",
				subject: "Post",
				value: draftPost,
			})
		}),
	)

	it.effect("puts subject names on values without changing the values", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(function* (ability) {
				yield* ability.allow("read", "Post", {
					conditions: { authorId: "u1" },
				})
			})
			const wrapped = Ability.subject("Post", draftPost)

			yield* Ability.check(ability, {
				action: "read",
				value: wrapped,
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
				"address",
			])
		}),
	)

	it.effect("gets subject types with a detectSubjectType function", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(
				function* (ability) {
					yield* ability.allow("read", "Post")
				},
				{
					detectSubjectType: (value) =>
						(value as { readonly __typename: "Post" }).__typename,
				},
			)

			yield* Ability.check(ability, {
				action: "read",
				value: {
					...draftPost,
					__typename: "Post",
				},
			})
		}),
	)

	it.effect("gives permitted fields, and deny rules take fields away", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(function* (ability) {
				yield* ability.allow("update", "Post", {
					fields: ["title", "body"],
					conditions: { authorId: "u1" },
				})
				yield* ability.deny("update", "Post", {
					fields: ["body"],
					conditions: { published: true },
				})
			})

			const fields = yield* Ability.permittedFields(
				ability,
				{
					action: "update",
					subject: "Post",
					value: publishedPost,
				},
				{
					fieldsFrom: (rule) =>
						rule.fields ?? ["id", "authorId", "published", "title", "body"],
				},
			)

			assert.deepStrictEqual(fields, ["title"])
		}),
	)

	it.effect("changes rules into raw rules and back", () =>
		Effect.gen(function* () {
			const ability = yield* Ability.fromRawRules<Subjects>([
				{
					action: "read",
					subject: "Post",
					conditions: { authorId: "u1" },
				},
				{
					action: "delete",
					subject: "Post",
					inverted: true,
					reason: "No deletes",
				},
			])

			const rawRules = yield* Ability.toRawRules(ability)

			assert.strictEqual(rawRules.length, 2)
			assert.strictEqual(rawRules[1]?.inverted, true)
		}),
	)

	it.effect(
		"gives a new ability on update and does not change the old one",
		() =>
			Effect.gen(function* () {
				const ability = Ability.define<Subjects>()(
					function* (ability) {
						yield* ability.allow("access", "Post")
					},
					{
						actionAliases: {
							access: ["read"],
						} as const,
					},
				)

				const next = yield* Ability.update(ability, [
					{
						action: "access",
						subject: "Post",
						inverted: true,
						reason: "Reading is off",
					},
				])
				const dataLast = yield* ability.pipe(
					Ability.update([
						{
							action: "access",
							subject: "Post",
						},
					]),
				)

				yield* Ability.check(ability, {
					action: "read",
					subject: "Post",
				})

				const reason = yield* Ability.check(next, {
					action: "read",
					subject: "Post",
				}).pipe(
					Effect.catchTag("AuthorizationError", (error) =>
						Effect.succeed(error.reason),
					),
				)

				assert.strictEqual(reason, "Reading is off")
				assert.strictEqual(ability.rules.length, 1)
				assert.strictEqual(next.rules.length, 1)
				assert.strictEqual(dataLast.rules.length, 1)
				assert.notStrictEqual(next, ability)
			}),
	)

	it.effect("fails fromRawRules with AliasError for bad aliases", () =>
		Effect.gen(function* () {
			const error = yield* Ability.fromRawRules<Subjects>(
				[
					{
						action: "read",
						subject: "Post",
					},
				],
				{
					actionAliases: {
						manage: "read",
					} as const,
				},
			).pipe(Effect.flip)

			assert.strictEqual(error._tag, "AliasError")
		}),
	)

	it.effect("makes action aliases go one way only", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(
				function* (ability) {
					yield* ability.allow("modify", "Post", {
						conditions: { authorId: "u1" },
					})
				},
				{
					actionAliases: {
						modify: ["update", "delete"],
					} as const,
				},
			)

			yield* Ability.check(ability, {
				action: "update",
				subject: "Post",
				value: draftPost,
			})

			const relevantRule = yield* Ability.relevantRuleFor(ability, {
				action: "delete",
				subject: "Post",
				value: draftPost,
			})

			const reverseAlias = yield* Ability.check(
				Ability.define<Subjects>()(
					function* (ability) {
						yield* ability.allow(["update", "delete"], "Post")
					},
					{
						actionAliases: {
							modify: ["update", "delete"],
						} as const,
					},
				),
				{
					action: "modify" as never,
					subject: "Post",
					value: draftPost,
				},
			).pipe(
				Effect.catchTag("AuthorizationError", (error) =>
					Effect.succeed(error._tag),
				),
			)

			assert.strictEqual(relevantRule?.action, "modify")
			assert.strictEqual(reverseAlias, "AuthorizationError")
		}),
	)

	it("throws an error for bad action aliases", () => {
		assert.throws(
			() =>
				Ability.define<Subjects>()(
					function* (ability) {
						yield* ability.allow("read", "Post")
					},
					{
						actionAliases: {
							access: "access",
						} as const,
					},
				),
			Ability.AliasError,
		)

		assert.throws(
			() => Ability.createAliasResolver({ manage: "read" }),
			Ability.AliasError,
		)
	})

	it.effect("lets you look at the rules and actions", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(
				function* (ability) {
					yield* ability.allow("manage", "all")
					yield* ability.allow("access", "Post", {
						fields: ["title"],
					})
					yield* ability.deny("delete", "Post", {
						reason: "No deletes",
					})
				},
				{
					actionAliases: {
						access: ["read", "update"],
					} as const,
				},
			)

			const possibleRules = yield* Ability.possibleRulesFor(ability, {
				action: "delete",
				subject: "Post",
			})
			const fieldRules = yield* Ability.rulesFor(ability, {
				action: "update",
				subject: "Post",
				field: "title",
			})
			const actions = yield* Ability.actionsFor(ability, {
				subject: "Post",
			})

			assert.deepStrictEqual(
				possibleRules.map((rule) => rule._tag),
				["Deny", "Allow"],
			)
			assert.deepStrictEqual(
				fieldRules.map((rule) => rule.action),
				["access", "manage"],
			)
			assert.deepStrictEqual([...actions].sort(), [
				"access",
				"delete",
				"manage",
				"read",
				"update",
			])
		}),
	)

	it("works with the CASL functions from the peer dependency", () => {
		const { can, cannot, build } = new AbilityBuilder(createMongoAbility)

		can("read", "Post")
		cannot("delete", "Post", { published: true })

		const caslAbility = build()

		assert.strictEqual(
			caslAbility.can("read", subject("Post", draftPost)),
			true,
		)
		assert.strictEqual(
			caslAbility.can("delete", subject("Post", publishedPost)),
			false,
		)
	})

	it.effect("has type tests, equality, hashing, and inspection", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(function* (ability) {
				yield* ability.allow("read", "Post")
			})
			const sameAbility = Ability.make<
				Subjects,
				(typeof ability.rules)[number]
			>(ability.rules, ability.options)
			const rule = ability.rules[0]!
			const wrapped = Ability.subject("Post", draftPost)

			assert.strictEqual(Ability.isAbility(ability), true)
			assert.strictEqual(Ability.isAbility(rule), false)
			assert.strictEqual(Ability.isRule(rule), true)
			assert.strictEqual(Ability.isRule(ability), false)
			assert.strictEqual(Ability.isSubject(wrapped), true)
			assert.strictEqual(Equal.equals(rule, rule), true)
			assert.strictEqual(
				Equal.equals(wrapped, Ability.subject("Post", draftPost)),
				true,
			)
			assert.strictEqual(Equal.equals(ability, sameAbility), true)
			assert.strictEqual(typeof Hash.hash(ability), "number")
			assert.strictEqual(typeof Hash.hash(rule), "number")
			assert.strictEqual(typeof Hash.hash(wrapped), "number")
			assert.strictEqual(String(ability).includes("Ability"), true)
			assert.strictEqual(String(rule).includes("Allow"), true)
		}),
	)
})

describe("AbilityExtra", () => {
	it("packs and unpacks raw rules, and keeps arrays as arrays", () => {
		const rawRules: ReadonlyArray<Ability.RawRule> = [
			{
				action: ["read", "update"],
				subject: "Post",
				fields: ["title", "body"],
				conditions: { authorId: "u1" },
			},
			{
				action: "delete",
				subject: "Post",
				inverted: true,
				reason: "No deletes",
			},
		]

		const packed = AbilityExtra.packRules(rawRules)
		const unpacked = AbilityExtra.unpackRules(packed)

		assert.deepStrictEqual(unpacked, rawRules)
		assert.deepStrictEqual(packed[0]?.[0], ["read", "update"])
	})

	it.effect("gets simple values from conditions", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(function* (ability) {
				yield* ability.allow("create", "Post", {
					conditions: {
						authorId: "u1",
						address: {
							city: "Shanghai",
						},
						title: { $regex: "^Draft" },
					},
				})
			})

			const fields = yield* AbilityExtra.rulesToFields(ability, {
				action: "create",
				subject: "Post",
			})

			assert.deepStrictEqual(fields, {
				authorId: "u1",
			})

			const dataLastFields = yield* ability.pipe(
				AbilityExtra.rulesToFields({
					action: "create",
					subject: "Post",
				}),
			)

			assert.deepStrictEqual(dataLastFields, fields)
		}),
	)

	it.effect("changes rules into general conditions", () =>
		Effect.gen(function* () {
			const ability = Ability.define<Subjects>()(function* (ability) {
				yield* ability.allow("read", "Post", {
					conditions: { authorId: "u1" },
				})
				yield* ability.allow("read", "Post", {
					conditions: { published: true },
				})
				yield* ability.deny("read", "Post", {
					conditions: { published: false },
				})
			})

			const condition = yield* AbilityExtra.rulesToCondition(
				ability,
				{
					action: "read",
					subject: "Post",
				},
				(rule) => rule.conditions as Record<string, unknown>,
				{
					and: (conditions) => ({ $and: conditions }),
					or: (conditions) => ({ $or: conditions }),
					not: (condition) => ({ $not: condition }),
					empty: () => ({}),
				},
			)

			assert.deepStrictEqual(condition, {
				$or: [
					{
						$and: [{ published: true }, { $not: { published: false } }],
					},
					{
						$and: [{ authorId: "u1" }, { $not: { published: false } }],
					},
				],
			})

			const dataLastCondition = yield* ability.pipe(
				AbilityExtra.rulesToCondition(
					{
						action: "read",
						subject: "Post",
					},
					(rule) => rule.conditions as Record<string, unknown>,
					{
						and: (conditions) => ({ $and: conditions }),
						or: (conditions) => ({ $or: conditions }),
						not: (condition) => ({ $not: condition }),
						empty: () => ({}),
					},
				),
			)

			assert.deepStrictEqual(dataLastCondition, condition)
		}),
	)

	it.effect(
		"fails with QueryGenerationError when a change function throws",
		() =>
			Effect.gen(function* () {
				const cause = new Error("boom")
				const ability = Ability.define<Subjects>()(function* (ability) {
					yield* ability.allow("read", "Post", {
						conditions: { authorId: "u1" },
					})
				})

				const error = yield* AbilityExtra.rulesToQuery(
					ability,
					{
						action: "read",
						subject: "Post",
					},
					() => {
						throw cause
					},
				).pipe(Effect.flip)

				assert.strictEqual(error._tag, "QueryGenerationError")
				assert.strictEqual(error.cause, cause)

				const dataLastQueryError = yield* ability.pipe(
					AbilityExtra.rulesToQuery(
						{
							action: "read",
							subject: "Post",
						},
						() => {
							throw cause
						},
					),
					Effect.catchTag("QueryGenerationError", (error) =>
						Effect.succeed(error._tag),
					),
				)

				assert.strictEqual(dataLastQueryError, "QueryGenerationError")
			}),
	)
})
