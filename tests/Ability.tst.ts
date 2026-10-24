import { Context, Effect } from "effect"
import { describe, expect, it } from "tstyche"
import { Ability, AbilityExtra } from "../src/index.ts"

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
		readonly make: (
			rule: Ability.Rule<Ability.RuleKind, string, string, object, string>,
		) => Effect.Effect<
			{
				readonly rule: string
			},
			"query-error"
		>
	}
>()("@nmnmcc/ability/tests/Ability.tst/QueryService") {}

declare const post: Post
declare const user: User
declare const queryWithService: Effect.Effect<
	{ readonly ownerId: string },
	"query-error",
	QueryService
>

const builder = {} as Ability.Builder<Subjects>

const postAbility = Ability.define<Subjects>()(function* (ability) {
	yield* ability.allow(["read", "update"], "Post", {
		fields: ["title", "address.city"],
		conditions: {
			authorId: "u1",
			published: { $eq: false },
		},
	})
	yield* ability.deny("delete", "Post", {
		conditions: { published: true },
		reason: "No one may delete a published post",
	})
})

const aliasAbility = Ability.define<Subjects>()(
	function* (ability) {
		yield* ability.allow("maintain", "Post", {
			fields: ["title"],
		})
	},
	{
		actionAliases: {
			maintain: "modify",
			modify: ["update", "delete"],
		} as const,
	},
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

const acceptPostCheckRequest = (
	_request: CheckRequestOf<typeof postAbility>,
): void => {}
const acceptAliasCheckRequest = (
	_request: CheckRequestOf<typeof aliasAbility>,
): void => {}
const acceptManageCheckRequest = (
	_request: CheckRequestOf<typeof manageAbility>,
): void => {}
const acceptMixedSubjectCheckRequest = (
	_request: CheckRequestOf<typeof mixedSubjectAbility>,
): void => {}
const acceptPostSubjectQueryRequest = (
	_request: SubjectQueryRequestOf<typeof postAbility>,
): void => {}

describe("Ability types", () => {
	describe("builder", () => {
		it("keeps the exact action, subject, and field names of a rule", () => {
			const allowRule = builder.allow("read", "Post")
			const updateRule = builder.allow("update", "Post", {
				fields: ["title", "address.city"],
				conditions: { authorId: "u1" },
			})
			const denyRule = builder.deny(["delete", "archive"], "Post", {
				reason: "locked",
			})

			expect(allowRule).type.toBe<
				Ability.Rule<"Allow", "read", "Post", Post, Ability.FieldOf<Post>>
			>()
			expect(updateRule).type.toBe<
				Ability.Rule<"Allow", "update", "Post", Post, "title" | "address.city">
			>()
			expect(denyRule).type.toBe<
				Ability.Rule<
					"Deny",
					"delete" | "archive",
					"Post",
					Post,
					Ability.FieldOf<Post>
				>
			>()
		})

		it("says no to unknown subjects, unknown fields, and wrong conditions", () => {
			expect(builder.allow).type.not.toBeCallableWith("read", "Account")
			expect(builder.allow).type.not.toBeCallableWith("read", "Post", {
				fields: ["address.country"],
			})
			expect(builder.allow).type.not.toBeCallableWith("read", "Post", {
				conditions: { published: "yes" },
			})
			expect(builder.allow).type.not.toBeCallableWith("read", "Post", {
				conditions: {
					tags: { $in: [1] },
				},
			})
		})

		it("lets $in work on array fields", () => {
			expect(builder.allow).type.toBeCallableWith("read", "Post", {
				conditions: {
					tags: { $in: ["effect"] },
				},
			})
		})
	})

	describe("define", () => {
		it("gives an Ability at once and keeps the given rules", () => {
			expect(postAbility).type.toBeAssignableTo<
				Ability.Ability<Subjects, (typeof postAbility)["rules"][number]>
			>()
			expect(postAbility).type.not.toBeAssignableTo<
				Effect.Effect<unknown, unknown, unknown>
			>()
			expect<(typeof postAbility)["rules"][number]["subject"]>().type.toBe<
				Ability.SingleOrReadonlyArray<"Post">
			>()
			expect<(typeof postAbility)["rules"][number]["action"]>().type.toBe<
				| Ability.SingleOrReadonlyArray<"read" | "update">
				| Ability.SingleOrReadonlyArray<"delete">
			>()
		})
	})

	describe("check", () => {
		it("keeps the success type and error type of the Effect", () => {
			const result = Ability.check(postAbility, {
				action: "update",
				subject: "Post",
				value: post,
				field: "address.city",
			})

			expect(result).type.toBe<
				Effect.Effect<
					void,
					| Ability.AuthorizationError
					| Ability.ConditionError
					| Ability.SubjectDetectionError
				>
			>()
		})

		it("takes good requests with the ability first or with pipe", () => {
			expect(acceptPostCheckRequest).type.toBeCallableWith({
				action: "read",
				subject: "Post",
				value: post,
				field: "title",
			})
			expect(
				postAbility.pipe(
					Ability.check({ action: "read", subject: "Post", value: post }),
				),
			).type.toBe<
				Effect.Effect<
					void,
					| Ability.AuthorizationError
					| Ability.ConditionError
					| Ability.SubjectDetectionError
				>
			>()
		})

		it("says no to bad requests that name the subject", () => {
			expect(acceptPostCheckRequest).type.not.toBeCallableWith({
				action: "publish",
				subject: "Post",
				value: post,
			})
			expect(acceptPostCheckRequest).type.not.toBeCallableWith({
				action: "read",
				subject: "User",
				value: user,
			})
			expect(acceptPostCheckRequest).type.not.toBeCallableWith({
				action: "read",
				subject: "Post",
				value: user,
			})
			expect(acceptPostCheckRequest).type.not.toBeCallableWith({
				action: "update",
				subject: "Post",
				value: post,
				field: "body",
			})
		})

		it("keeps each action with its own subjects", () => {
			expect(acceptMixedSubjectCheckRequest).type.toBeCallableWith({
				action: "read",
				subject: "User",
				value: user,
			})
			expect(acceptMixedSubjectCheckRequest).type.toBeCallableWith({
				action: "delete",
				subject: "Post",
				value: post,
			})
			expect(acceptMixedSubjectCheckRequest).type.not.toBeCallableWith({
				action: "delete",
				subject: "User",
				value: user,
			})
			expect(acceptMixedSubjectCheckRequest).type.not.toBeCallableWith({
				action: "read",
				subject: "Post",
				value: post,
			})
		})

		it("works with named subjects and detected subjects", () => {
			const wrapped = Ability.subject("Post", post)

			expect(wrapped).type.toBe<Ability.TypedSubject<"Post", Post>>()
			expect(Ability.unwrapSubject(wrapped)).type.toBe<Post>()
			expect(Ability.unwrapSubject(post)).type.toBe<Post>()
			expect(acceptPostCheckRequest).type.toBeCallableWith({
				action: "read",
				value: wrapped,
				field: "title",
			})
			expect(acceptPostCheckRequest).type.toBeCallableWith({
				action: "read",
				value: post,
				field: "runtime.path",
			})
			expect(acceptPostCheckRequest).type.not.toBeCallableWith({
				action: "read",
				subject: "User",
				value: wrapped,
			})
		})

		it("makes aliases go one way only", () => {
			expect(acceptAliasCheckRequest).type.toBeCallableWith({
				action: "maintain",
				subject: "Post",
				value: post,
				field: "title",
			})
			expect(acceptAliasCheckRequest).type.toBeCallableWith({
				action: "modify",
				subject: "Post",
				value: post,
				field: "title",
			})
			expect(acceptAliasCheckRequest).type.toBeCallableWith({
				action: "update",
				subject: "Post",
				value: post,
				field: "title",
			})
			expect(acceptAliasCheckRequest).type.not.toBeCallableWith({
				action: "publish",
				subject: "Post",
				value: post,
			})
		})

		it("lets manage and all work, and keeps the subject value types", () => {
			expect(acceptManageCheckRequest).type.toBeCallableWith({
				action: "publish",
				subject: "User",
				value: user,
			})
			expect(acceptManageCheckRequest).type.not.toBeCallableWith({
				action: "publish",
				subject: "Post",
				value: user,
			})
		})
	})

	describe("rule accessors", () => {
		it("gives only the rules that match the request", () => {
			const rules = Ability.rulesFor(postAbility, {
				action: "read",
				subject: "Post",
			})
			const relevant = Ability.relevantRuleFor(postAbility, {
				action: "delete",
				subject: "Post",
				value: post,
			})

			expect<Effect.Success<typeof rules>[number]["action"]>().type.toBe<
				Ability.SingleOrReadonlyArray<"read" | "update">
			>()
			expect<Effect.Success<typeof rules>[number]["subject"]>().type.toBe<
				Ability.SingleOrReadonlyArray<"Post">
			>()
			expect(relevant).type.toBe<
				Effect.Effect<
					| Ability.Rule<"Deny", "delete", "Post", Post, Ability.FieldOf<Post>>
					| undefined,
					Ability.ConditionError | Ability.SubjectDetectionError
				>
			>()
		})

		it("keeps the limits on actions and subjects in queries", () => {
			const actions = Ability.actionsFor(postAbility, { subject: "Post" })

			expect(actions).type.toBe<
				Effect.Effect<
					ReadonlyArray<"read" | "update" | "delete">,
					Ability.SubjectDetectionError
				>
			>()
			expect(acceptPostSubjectQueryRequest).type.not.toBeCallableWith({
				subject: "Account",
			})
		})
	})

	describe("raw rules", () => {
		it("keeps the error types and subject limits of the raw rule functions", () => {
			const rawRules = [
				{
					action: "read",
					subject: "Post",
					fields: ["title"],
					conditions: { authorId: "u1" },
				},
			] as const satisfies ReadonlyArray<
				Ability.RawRule<"read", "Post", "title", { readonly authorId: "u1" }>
			>

			const fromRaw = Ability.fromRawRules<Subjects>(rawRules)
			const updated = Ability.update(postAbility, rawRules)

			expect<Effect.Error<typeof fromRaw>>().type.toBe<
				Ability.AliasError | Ability.RawRuleError
			>()
			expect<Effect.Error<typeof updated>>().type.toBe<
				Ability.AliasError | Ability.RawRuleError
			>()
			expect(Ability.fromRawRules<Subjects>).type.not.toBeCallableWith([
				{
					action: "read",
					subject: "Account",
				},
			])
			expect(Ability.update).type.not.toBeCallableWith(postAbility, [
				{
					action: "read",
					subject: "Account",
				},
			])
		})
	})

	describe("AbilityExtra", () => {
		it("keeps the types of packed raw rules", () => {
			const rawRules = [
				{
					action: "read",
					subject: "Post",
					fields: ["title"],
					conditions: { authorId: "u1" },
					reason: "owner",
				},
			] as const satisfies ReadonlyArray<
				Ability.RawRule<"read", "Post", "title", { readonly authorId: "u1" }>
			>

			const packed = AbilityExtra.packRules(rawRules)
			const unpacked = AbilityExtra.unpackRules(packed)

			expect(packed).type.toBe<
				ReadonlyArray<AbilityExtra.PackRule<(typeof rawRules)[number]>>
			>()
			expect(unpacked).type.toBe<ReadonlyArray<(typeof rawRules)[number]>>()
		})

		it("keeps the errors and services of query change functions", () => {
			const fields = AbilityExtra.rulesToFields(postAbility, {
				action: "read",
				subject: "Post",
			})
			const query = AbilityExtra.rulesToQuery(
				postAbility,
				{
					action: "read",
					subject: "Post",
				},
				() => queryWithService,
			)

			expect(fields).type.toBe<
				Effect.Effect<
					Readonly<Record<string, unknown>>,
					Ability.QueryGenerationError | Ability.SubjectDetectionError
				>
			>()
			expect(query).type.toBe<
				Effect.Effect<
					AbilityExtra.LogicalQuery<{ readonly ownerId: string }> | null,
					| Ability.QueryGenerationError
					| Ability.SubjectDetectionError
					| "query-error",
					QueryService
				>
			>()
		})

		it("checks the query tools with pipe", () => {
			const hooks: AbilityExtra.RulesToConditionHooks<{
				readonly allow: boolean
			}> = {
				and: () => ({ allow: true }),
				or: () => ({ allow: true }),
				not: () => ({ allow: false }),
				empty: () => ({ allow: true }),
			}

			expect(
				AbilityExtra.rulesToCondition(
					{
						action: "read",
						subject: "Post",
					},
					(rule) => ({ allow: rule._tag === "Allow" }),
					hooks,
				),
			).type.toBeAssignableTo<
				(
					self: typeof postAbility,
				) => Effect.Effect<{ readonly allow: boolean } | null, unknown, unknown>
			>()
			expect(
				postAbility.pipe(
					AbilityExtra.rulesToQuery(
						{
							action: "read",
							subject: "Post",
						},
						() => ({ ownerId: "u1" }),
					),
				),
			).type.toBe<
				Effect.Effect<
					AbilityExtra.LogicalQuery<{ ownerId: string }> | null,
					Ability.QueryGenerationError | Ability.SubjectDetectionError
				>
			>()
		})
	})
})
