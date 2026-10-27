import { assert, describe, it } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	Equal,
	Exit,
	Hash,
	Schema,
} from "effect"
import {
	Condition,
	Decision,
	Domain,
	Limits,
	Policy,
	Resource,
} from "../src/index.ts"
import {
	alice,
	aliceBot,
	aliceTrigger,
	App,
	bob,
	Bot,
	Caller,
	emptyOf,
	rulesOf,
	sharedBot,
	Trigger,
} from "./fixtures.ts"
import * as Analysis from "../src/internal/analysis.ts"
import * as Catalog from "../src/internal/catalog.ts"
import * as ResourceData from "../src/internal/resource.ts"

type App = typeof App

const tagOf = (decision: Decision.Decision) => decision._tag

// A principal from a loader may have no user id, for example a guest. The
// Schema of `Caller` does not let this happen, so the test makes it by hand.
const guest = {
	organizationId: "acme",
	role: "guest",
} as unknown as Caller

describe("Policy", () => {
	describe("algorithms", () => {
		const rules = (_: Policy.Builder<App>) => [
			_.allow("update", Bot),
			_.deny("update", Bot, {
				when: ($) => $.eq("ownerUserId", null),
				reason: "Shared Bots are locked",
			}),
			_.allow("update", Bot, { when: ($) => $.eq("ownerUserId", null) }),
		]
		it("gives each algorithm its own winner", () => {
			const make = (algorithm: Policy.Algorithm) =>
				Policy.define(App, { algorithm })(function* (_) {
					yield* rules(_)
				})
			const decide = (algorithm: Policy.Algorithm) =>
				Policy.decideSync(make(algorithm), {
					principal: alice,
					action: "update",
					resource: sharedBot,
				})
			assert.strictEqual(tagOf(decide("denyOverrides")), "Deny")
			assert.strictEqual(tagOf(decide("permitOverrides")), "Allow")
			assert.strictEqual(tagOf(decide("firstApplicable")), "Allow")
			assert.strictEqual(tagOf(decide("lastApplicable")), "Allow")
			assert.strictEqual(
				Decision.reason(decide("denyOverrides")),
				"Shared Bots are locked",
			)
		})

		it("is not applicable when no rule applies", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("read", Trigger)
			})
			assert.strictEqual(
				tagOf(
					Policy.decideSync(policy, {
						principal: alice,
						action: "update",
						resource: aliceBot,
					}),
				),
				"NotApplicable",
			)
			assert.strictEqual(
				tagOf(
					Policy.decideSync(emptyOf(App), {
						principal: alice,
						action: "read",
						resource: aliceBot,
					}),
				),
				"NotApplicable",
			)
		})
	})

	describe("principal fields with no value", () => {
		const decide = (policy: Policy.Policy<App>, principal: Caller) =>
			tagOf(
				Policy.decideSync(policy, {
					principal,
					action: "update",
					resource: sharedBot,
				}),
			)
		const residual = (policy: Policy.Policy<App>, principal: Caller) =>
			Policy.residual(policy, { principal, action: "update", kind: "Bot" })

		it("never lets a principal with no id match a resource with no owner", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot, {
					when: ($) => $.eq("ownerUserId", $.principal("userId")),
				})
			})
			assert.strictEqual(decide(policy, guest), "NotApplicable")
			assert.deepStrictEqual(residual(policy, guest), Condition.never)
		})

		it("never matches with in, ne or under", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot, {
					when: ($) => $.in("ownerUserId", [$.principal("userId")]),
				})
				yield* _.allow("update", Bot, {
					when: ($) => $.ne("ownerUserId", $.principal("userId")),
				})
				yield* _.allow("update", Bot, {
					when: ($) =>
						$.under(
							"org",
							$.principal("organizationId"),
							"user",
							$.principal("userId"),
						),
				})
			})
			assert.strictEqual(decide(policy, guest), "NotApplicable")
			assert.deepStrictEqual(residual(policy, guest), Condition.never)
		})

		it("lets a deny rule with not apply", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot)
				yield* _.deny("update", Bot, {
					when: ($) => $.not($.eq("ownerUserId", $.principal("userId"))),
					reason: "Only the owner may change a Bot",
				})
			})
			assert.strictEqual(decide(policy, guest), "Deny")
			assert.deepStrictEqual(residual(policy, guest), Condition.never)
		})

		it("keeps a fixed null value as a test for null", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot, {
					when: ($) => $.eq("ownerUserId", null),
				})
			})
			assert.strictEqual(decide(policy, guest), "Allow")
		})
	})

	describe("fields", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("update", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("userId")),
			})
			yield* _.deny("update", Bot, { fields: ["settings"] })
			yield* _.allow("read", Bot, { fields: ["name", "settings"] })
		})

		it("matches exact fields and parent fields", () => {
			const decide = (action: "read" | "update", field: string) =>
				tagOf(
					Policy.decideSync(policy, {
						principal: alice,
						action,
						resource: aliceBot,
						field: field as never,
					}),
				)
			assert.strictEqual(decide("update", "name"), "Allow")
			assert.strictEqual(decide("update", "settings.secret"), "Deny")
			assert.strictEqual(decide("read", "settings.model"), "Allow")
			assert.strictEqual(decide("read", "level"), "NotApplicable")
		})

		it("gives the permitted fields in the same way as decide", () => {
			const fields = Effect.runSync(
				Policy.permittedFields(policy, {
					principal: alice,
					action: "update",
					resource: aliceBot,
				}),
			)
			assert.deepStrictEqual(fields, [
				"id",
				"organizationId",
				"ownerUserId",
				"name",
				"level",
			])
		})

		it("lets an allow rule with fields cover a request for the whole value", () => {
			assert.strictEqual(
				tagOf(
					Policy.decideSync(policy, {
						principal: bob,
						action: "read",
						resource: aliceBot,
					}),
				),
				"Allow",
			)
		})
	})

	describe("OpenBot roles, tokens and the platform ceiling", () => {
		// An OpenBot policy covers a resource key and every key under it. Here a
		// key is the path of a resource, and `{org}` and `{self}` are fields of
		// the principal.
		const member = Policy.define(App)(function* (_) {
			yield* _.allow(["read", "update", "delete"], Bot, {
				when: ($) =>
					$.under(
						"org",
						$.principal("organizationId"),
						"user",
						$.principal("userId"),
					),
			})
			yield* _.allow("read", "*", {
				when: ($) => $.under("org", $.principal("organizationId")),
			})
			yield* _.deny("delete", Bot, {
				when: ($) => $.eq("level", 5),
				reason: "Level 5 Bots stay",
			})
		})
		const token = Policy.define(App)(function* (_) {
			yield* _.allow("read", "*")
		})
		const platform = Policy.define(App)(function* (_) {
			yield* _.deny("*", "*", {
				when: ($) => $.under("org", "blocked"),
				reason: "This organization is blocked",
			})
		})
		const session = member.pipe(Policy.ceiling(platform))
		const withToken = Policy.all([member, token]).pipe(Policy.ceiling(platform))
		const blockedBot = Bot.make({ ...aliceBot, organizationId: "blocked" })

		const decide = (
			policy: Policy.Policy<App>,
			action: "read" | "update" | "delete",
			resource: Bot,
		) =>
			tagOf(Policy.decideSync(policy, { principal: alice, action, resource }))

		it("lets a member act on their own Bots and read the organization", () => {
			assert.strictEqual(decide(session, "update", aliceBot), "Allow")
			assert.strictEqual(decide(session, "update", sharedBot), "NotApplicable")
			assert.strictEqual(decide(session, "read", sharedBot), "Allow")
		})

		it("never lets a token do more than its member", () => {
			assert.strictEqual(decide(withToken, "read", aliceBot), "Allow")
			assert.strictEqual(decide(withToken, "update", aliceBot), "NotApplicable")
		})

		it("lets the ceiling deny but never allow", () => {
			assert.strictEqual(decide(session, "read", blockedBot), "Deny")
			assert.strictEqual(
				decide(emptyOf(App).pipe(Policy.ceiling(token)), "read", aliceBot),
				"NotApplicable",
			)
		})

		it("gives the condition for a list of readable Bots", () => {
			const residual = Policy.residual(withToken, {
				principal: alice,
				action: "read",
				kind: "Bot",
			})
			assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
			assert.isFalse(Condition.evaluateSync(residual, { value: blockedBot }))
			assert.deepStrictEqual(
				Policy.residual(withToken, {
					principal: alice,
					action: "update",
					kind: "Bot",
				}),
				Condition.never,
			)
		})

		it("explains a decision", () => {
			const explanation = Effect.runSync(
				Policy.explain(session, {
					principal: alice,
					action: "delete",
					resource: sharedBot,
				}),
			)
			assert.strictEqual(explanation.decision._tag, "Deny")
			assert.deepStrictEqual(
				explanation.steps.map((step) => [step.path, step.applies]),
				[
					[[0, 0], false],
					[[1, 2], true],
				],
			)
		})
	})

	describe("grants and rules in order", () => {
		const grants = Policy.define(App)(function* (_) {
			yield* _.allow("delegate", Bot, {
				when: ($) => $.eq("id", "b1"),
				meta: { scope: "once" },
			})
		})
		const rules = Policy.define(App)(function* (_) {
			yield* _.deny("delegate", Bot)
		})

		it("lets the first policy with an answer win", () => {
			const policy = Policy.firstOf([grants, rules])
			const decision = Policy.decideSync(policy, {
				principal: alice,
				action: "delegate",
				resource: aliceBot,
			})
			assert.strictEqual(decision._tag, "Allow")
			assert.deepStrictEqual(
				decision._tag === "Allow" ? decision.rule?.meta : undefined,
				{ scope: "once" },
			)
			assert.strictEqual(
				tagOf(
					Policy.decideSync(policy, {
						principal: alice,
						action: "delegate",
						resource: sharedBot,
					}),
				),
				"Deny",
			)
		})

		it("lets one allow win with any", () => {
			assert.strictEqual(
				tagOf(
					Policy.decideSync(Policy.any([rules, grants]), {
						principal: alice,
						action: "delegate",
						resource: aliceBot,
					}),
				),
				"Allow",
			)
		})
	})

	describe("predicates", () => {
		it.effect("keeps the errors of predicates in the error channel", () =>
			Effect.gen(function* () {
				const policy = Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot, {
						when: ($) =>
							$.predicate("quota", () =>
								Effect.fail({ _tag: "QuotaError" as const }),
							),
					})
				})
				const exit = yield* Effect.exit(
					Policy.decide(policy, {
						principal: alice,
						action: "read",
						resource: aliceBot,
					}),
				)
				assert.isTrue(Exit.isFailure(exit))
			}),
		)
	})

	describe("JSON text", () => {
		const codec = Policy.schema(App)
		const basic = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.under("org", $.principal("organizationId")),
				fields: ["name", "settings"],
				reason: "Read",
				id: "r1",
				meta: { scope: "chat", count: 2, flags: [true, null] },
			})
		})

		it("keeps a tree and JSON meta through text", () => {
			const policy = Policy.all([
				basic,
				Policy.define(App, { algorithm: "lastApplicable" })(function* (_) {
					yield* _.deny("*", "*")
				}),
			])
			const text = Schema.encodeSync(codec)(policy)
			assert.strictEqual(typeof text, "string")
			const decoded = Schema.decodeSync(codec)(text)
			assert.isTrue(Equal.equals(decoded, policy))
			assert.strictEqual(Hash.hash(decoded), Hash.hash(policy))
		})

		it("takes text only and reports invalid input in the error channel", () => {
			const inputs = [
				JSON.parse(Schema.encodeSync(codec)(basic)),
				"{",
				"null",
				'{"_tag":"Other"}',
				'{"_tag":"All"}',
				'{"_tag":"Rules","algorithm":"other","rules":[]}',
			]
			Arr.forEach(inputs, (input) => {
				const exit = Schema.decodeUnknownExit(codec)(input)
				assert.isTrue(Exit.isFailure(exit))
				assert.isFalse(Exit.hasDies(exit))
			})
		})

		const decodeRule = (change: Record<string, unknown>) =>
			Schema.decodeExit(codec)(
				JSON.stringify({
					_tag: "Rules",
					algorithm: "denyOverrides",
					rules: [
						{
							_tag: "Allow",
							actions: ["read"],
							resources: ["Bot"],
							...change,
						},
					],
				}),
			)

		it("checks names, selectors, values and condition structure at load", () => {
			Arr.forEach(
				[
					{ actions: ["fly"] },
					{ resources: ["Ghost"] },
					{ fields: ["settings.*"] },
					{ fields: ["**.secret"] },
					{ fields: ["missing"] },
					{ when: { _tag: "Not" } },
					{ when: { _tag: "Other" } },
					{ when: { _tag: "Exists", field: "shared" } },
					{
						when: {
							_tag: "Compare",
							op: "eq",
							field: "level",
							value: { _tag: "Literal", value: "high" },
						},
					},
					{
						when: {
							_tag: "Compare",
							op: "eq",
							field: "ownerUserId",
							value: { _tag: "Principal", path: "missing" },
						},
					},
				],
				(change) => {
					const exit = decodeRule(change)
					assert.isTrue(Exit.isFailure(exit), JSON.stringify(change))
					assert.isFalse(Exit.hasDies(exit))
				},
			)
		})

		it("gives the path of the first binding error", () => {
			const exit = decodeRule({ fields: ["missing"] })
			assert.isTrue(Exit.isFailure(exit))
			const message = String(Exit.isFailure(exit) ? exit.cause : "")
			assert.include(message, "missing")
			assert.include(message, "fields")
		})

		it.prop(
			"decodes JSON text or returns a failure without a defect",
			{ input: Schema.Json },
			({ input }) => {
				const exit = Schema.decodeExit(codec)(JSON.stringify(input))
				return Exit.isSuccess(exit) || !Exit.hasDies(exit)
			},
		)
	})

	it("denies a parent field when a child field is denied", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { fields: ["settings"] })
			yield* _.deny("read", Bot, { fields: ["settings.secret"] })
		})
		const decide = (field: "settings" | "settings.model" | "settings.secret") =>
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
				field,
			})._tag
		assert.strictEqual(decide("settings"), "Deny")
		assert.strictEqual(decide("settings.secret"), "Deny")
		assert.strictEqual(decide("settings.model"), "Allow")
		assert.deepStrictEqual(
			Effect.runSync(
				Policy.permittedFields(policy, {
					principal: alice,
					action: "read",
					resource: aliceBot,
				}),
			),
			["settings.model"],
		)
		assert.isFalse(
			Condition.evaluateSync(
				Policy.residual(policy, {
					principal: alice,
					action: "read",
					kind: "Bot",
					field: "settings",
				}),
				{ value: aliceBot },
			),
		)
	})

	it("allows or denies an opaque field as one field", () => {
		const Entry = Resource.make("Entry", {
			actions: ["read"],
			fields: {
				id: Schema.String,
				data: Schema.Record(Schema.String, Schema.String),
			},
		})
		const Entries = Domain.make({ principal: Caller, resources: [Entry] })
		const policy = Policy.define(Entries)(function* (_) {
			yield* _.allow("read", Entry, { fields: ["*"] })
			yield* _.deny("read", Entry, { fields: ["data"] })
		})
		const value = Entry.make({ id: "one", data: { secret: "value" } })
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: value,
				field: "data",
			})._tag,
			"Deny",
		)
		assert.deepStrictEqual(
			Effect.runSync(
				Policy.permittedFields(policy, {
					principal: alice,
					action: "read",
					resource: value,
				}),
			),
			["id"],
		)
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "Entry",
		})
		assert.strictEqual(covered._tag, "Unknown")
		assert.strictEqual(
			covered._tag === "Unknown" ? covered.reason : undefined,
			"schema",
		)
	})

	it("counts rules, lists, conditions and meta at the fixed policy bound", () => {
		const codec = Policy.schema(App)
		const make = (values: number, metaItems: number) =>
			Policy.define(App)(function* (_) {
				yield* _.allow(["read", "update"], Bot, {
					fields: ["name", "level"],
					when: ($) => $.in("level", Arr.range(1, values)),
					meta: Array.from({ length: metaItems }, () => null),
				})
			})
		// Nine fixed units: the policy, rule, two actions, kind, two fields,
		// condition and meta array. Every operand and meta value adds one.
		const policy = make(1000, 8991)
		assert.strictEqual(policy.node.size, Limits.policyNodes)
		const text = Schema.encodeSync(codec)(policy)
		assert.isTrue(Equal.equals(Schema.decodeSync(codec)(text), policy))
		assert.throws(() => make(1000, 8992), /The most is 10000/)
		const data = JSON.parse(text) as { rules: [{ meta: Array<null> }] }
		data.rules[0].meta.push(null)
		const exit = Schema.decodeExit(codec)(JSON.stringify(data))
		assert.isTrue(Exit.isFailure(exit))
		assert.isFalse(Exit.hasDies(exit))

		// Each use of a shared subtree counts. Two parts of 4999 units and
		// one empty part, under the All node, use exactly 10000 units.
		const half = make(1, 4989)
		assert.strictEqual(half.node.size, 4999)
		const empty = emptyOf(App)
		const shared = Policy.all([half, half, empty])
		assert.strictEqual(shared.node.size, Limits.policyNodes)
		const sharedText = Schema.encodeSync(codec)(shared)
		assert.isTrue(Equal.equals(Schema.decodeSync(codec)(sharedText), shared))
		assert.throws(
			() => Policy.all([half, half, empty, empty]),
			/The most is 10000/,
		)
		const sharedData = JSON.parse(sharedText) as { policies: Array<unknown> }
		sharedData.policies.push(JSON.parse(Schema.encodeSync(codec)(empty)))
		assert.isTrue(
			Exit.isFailure(Schema.decodeExit(codec)(JSON.stringify(sharedData))),
		)
	})

	it("stops and closes a generator at the first rule past the unit bound", () => {
		const meta = Array.from({ length: 5996 }, () => null)
		const progress = { first: false, second: false, closed: false }
		assert.throws(
			() =>
				Policy.define(App)(function* (_) {
					try {
						yield* _.allow("read", Bot, { meta })
						progress.first = true
						yield* _.allow("read", Bot, { meta })
						progress.second = true
					} finally {
						progress.closed = true
					}
				}),
			/The most is 10000/,
		)
		assert.deepStrictEqual(progress, {
			first: true,
			second: false,
			closed: true,
		})
	})

	it("stops a residual that grows beyond a fixed bound", () => {
		const base = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: ($) => $.eq("level", 1) })
			yield* _.deny("read", Bot, { when: ($) => $.eq("name", "Team") })
		})
		const policy = Arr.reduce(Arr.range(0, 23), base, (inner, depth) =>
			depth % 2 === 0 ? Policy.any([inner]) : Policy.all([inner]),
		)
		assert.throws(
			() =>
				Policy.residual(policy, {
					principal: alice,
					action: "read",
					kind: "Bot",
				}),
			/The most is/,
		)
	})

	it("copies mutable arrays and JSON meta at construction", () => {
		const actions: Array<"read" | "update"> = ["read"]
		const fields: Array<"name" | "level"> = ["name"]
		const meta = { values: ["one"] }
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow(actions, Bot, { fields, meta })
		})
		actions.push("update")
		fields.push("level")
		meta.values.push("two")
		const decision = Policy.decideSync(policy, {
			principal: alice,
			action: "read",
			resource: aliceBot,
			field: "name",
		})
		assert.strictEqual(decision._tag, "Allow")
		assert.deepStrictEqual(
			decision._tag === "Allow" ? decision.rule?.meta : undefined,
			{
				values: ["one"],
			},
		)
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "update",
				resource: aliceBot,
				field: "name",
			})._tag,
			"NotApplicable",
		)
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
				field: "level",
			})._tag,
			"NotApplicable",
		)
	})

	it("does not take a spread of a rule or policy", () => {
		const rule = Policy.builder(App).allow("read", Bot)
		const policy = rulesOf(App, [rule])
		assert.throws(() => rulesOf(App, [{ ...rule } as typeof rule]))
		assert.throws(() => Policy.all([{ ...policy } as typeof policy]))
	})

	it.effect("keeps the services of predicates and can provide them", () =>
		Effect.gen(function* () {
			class Quota extends Context.Service<
				Quota,
				{ readonly allowed: boolean }
			>()("@nmnmcc/ability/tests/Policy.test/Quota") {}
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("read", Bot, {
					when: ($) =>
						$.predicate("quota", () =>
							Effect.map(Quota, (quota) => quota.allowed),
						),
				})
			})
			const allowed = Policy.provideContext(
				policy,
				Context.make(Quota, { allowed: true }),
			)
			const denied = policy.pipe(
				Policy.provideContext(Context.make(Quota, { allowed: false })),
			)
			const request = {
				principal: alice,
				action: "read",
				resource: aliceBot,
			} as const
			assert.strictEqual((yield* Policy.decide(allowed, request))._tag, "Allow")
			assert.strictEqual(
				(yield* Policy.decide(denied, request))._tag,
				"NotApplicable",
			)
		}),
	)

	describe("properties", () => {
		const Spec = Schema.Struct({
			tag: Schema.Literals(["Allow", "Deny"]),
			action: Schema.Literals(["read", "update", "*"]),
			when: Schema.Literals([
				"none",
				"owner",
				"shared",
				"level",
				"under",
				"notName",
				"either",
				"notOwner",
				"ownerIn",
				"underUser",
			]),
			fields: Schema.Boolean,
		})
		const BotInput = Schema.Struct({
			organizationId: Schema.Literals(["acme", "other"]),
			ownerUserId: Schema.NullOr(Schema.Literals(["alice", "bob"])),
			name: Schema.Literals(["Helper", "Team"]),
			level: Schema.Literals([0, 2, 5]),
		})
		const Request = Schema.Struct({
			action: Schema.Literals(["read", "update"]),
			field: Schema.Literals(["none", "name", "level"]),
			algorithm: Schema.Literals([
				"denyOverrides",
				"permitOverrides",
				"firstApplicable",
				"lastApplicable",
			]),
			shape: Schema.Literals(["rules", "all", "any", "firstOf", "ceiling"]),
			principal: Schema.Literals(["alice", "guest"]),
		})
		const principals = { alice, guest }

		type BotBuilder = Condition.Builder<App, "Bot">
		const conditions: Record<
			Exclude<(typeof Spec.Type)["when"], "none">,
			($: BotBuilder) => Condition.Test<Bot, Caller>
		> = {
			owner: ($) => $.eq("ownerUserId", $.principal("userId")),
			shared: ($) => $.eq("ownerUserId", null),
			level: ($) => $.gte("level", 2),
			under: ($) => $.under("org", $.principal("organizationId")),
			notName: ($) => $.not($.eq("name", "Team")),
			either: ($) => $.or($.eq("level", 5), $.exists("ownerUserId")),
			notOwner: ($) => $.not($.eq("ownerUserId", $.principal("userId"))),
			ownerIn: ($) => $.in("ownerUserId", [$.principal("userId"), "bob"]),
			underUser: ($) =>
				$.under(
					"org",
					$.principal("organizationId"),
					"user",
					$.principal("userId"),
				),
		}

		const toRule = (
			_: Policy.Builder<App>,
			spec: typeof Spec.Type,
		): Policy.Rule<App, Condition.Reads<Bot, Caller>> => {
			const make = spec.tag === "Allow" ? _.allow : _.deny
			return make(spec.action, Bot, {
				...(spec.fields ? { fields: ["name"] } : {}),
				...(spec.when === "none" ? {} : { when: conditions[spec.when] }),
			})
		}

		const build = (
			specs: ReadonlyArray<typeof Spec.Type>,
			request: typeof Request.Type,
		): Policy.Policy<App> => {
			const half = Math.floor(specs.length / 2)
			const withAlgorithm = (part: ReadonlyArray<typeof Spec.Type>) =>
				Policy.define(App, { algorithm: request.algorithm })(function* (_) {
					yield* Arr.map(part, (spec) => toRule(_, spec))
				})
			const left = withAlgorithm(specs.slice(0, half))
			const right = withAlgorithm(specs.slice(half))
			switch (request.shape) {
				case "rules":
					return withAlgorithm(specs)
				case "all":
					return Policy.all([left, right])
				case "any":
					return Policy.any([left, right])
				case "firstOf":
					return Policy.firstOf([left, right])
				case "ceiling":
					return Policy.ceiling(left, right)
			}
		}

		it.prop(
			"gives a residual condition that agrees with decide",
			{
				specs: Schema.Array(Spec),
				bot: BotInput,
				request: Request,
			},
			({ specs, bot, request }) => {
				const policy = build(specs, request)
				const value = Bot.make({
					...bot,
					id: "b9",
					settings: { model: "small", secret: "s" },
				})
				const field = request.field === "none" ? undefined : request.field
				const principal = principals[request.principal]
				const decision = Policy.decideSync(policy, {
					principal,
					action: request.action,
					resource: value,
					...(field === undefined ? {} : { field }),
				})
				const residual = Policy.residual(policy, {
					principal,
					action: request.action,
					kind: "Bot",
					...(field === undefined ? {} : { field }),
				})
				return (
					Condition.evaluateSync(residual, { value }) ===
					(decision._tag === "Allow")
				)
			},
		)

		it.prop(
			"keeps every policy the same through JSON",
			{ specs: Schema.Array(Spec), request: Request },
			({ specs, request }) => {
				const policy = build(specs, request)
				const PolicySchema = Policy.schema(App)
				const json = JSON.parse(
					JSON.stringify(Schema.encodeSync(PolicySchema)(policy)),
				)
				return Equal.equals(
					Schema.decodeUnknownSync(PolicySchema)(json),
					policy,
				)
			},
		)

		it.prop(
			"keeps the meaning of a condition when it makes it smaller",
			{
				specs: Schema.Array(Spec),
				bot: BotInput,
				principal: Request.fields.principal,
			},
			({ specs, bot, principal }) => {
				const value = Bot.make({
					...bot,
					id: "b9",
					settings: { model: "small", secret: "s" },
				})
				const _ = Policy.define(App)
				const policy = _(function* (builder) {
					yield* Arr.map(specs, (spec) => toRule(builder, spec))
				})
				const node = policy.node as Policy.RulesNode
				// A node keeps no types. These rules have no predicates.
				const conditions = node.rules.flatMap((rule) =>
					rule.when === undefined ? [] : [rule.when as Condition.Condition],
				)
				const whole = Condition.not(
					Condition.or(...conditions, Condition.and(...conditions)),
				)
				const input = {
					value,
					principal: principals[principal],
					path: [
						"org",
						{ _tag: "Field", field: "organizationId" },
						"user",
						{ _tag: "Field", field: "ownerUserId" },
					] as const,
				}
				return (
					Condition.evaluateSync(whole, input) ===
					Condition.evaluateSync(
						Condition.simplify(Condition.partial(whole, input)),
						{ value },
					)
				)
			},
		)

		const scopes = {
			all: undefined,
			acme: ($) => $.under("org", "acme"),
			ownOrganization: ($) => $.under("org", $.principal("organizationId")),
			own: ($) =>
				$.under(
					"org",
					$.principal("organizationId"),
					"user",
					$.principal("userId"),
				),
			team: ($) => $.eq("name", "Team"),
			high: ($) => $.gte("level", 2),
			sharedOrLow: ($) => $.or($.eq("ownerUserId", null), $.lt("level", 2)),
		} satisfies Record<string, Policy.Scope<App, "Bot"> | undefined>
		const ScopeName = Schema.Literals([
			"all",
			"acme",
			"ownOrganization",
			"own",
			"team",
			"high",
			"sharedOrLow",
		])

		// Every value that `BotInput` can make.
		const everyBot = BotInput.fields.organizationId.literals.flatMap(
			(organizationId) =>
				[...BotInput.fields.ownerUserId.members[0].literals, null].flatMap(
					(ownerUserId) =>
						BotInput.fields.name.literals.flatMap((name) =>
							BotInput.fields.level.literals.map((level) =>
								Bot.make({
									id: "b9",
									organizationId,
									ownerUserId,
									name,
									level,
									settings: { model: "small", secret: "s" },
								}),
							),
						),
				),
		)

		/** A plain value of the kind, made from an example of a search. */
		// The data of a Bot with the fields of the example. `Bot.make` would
		// check the example, and a test here needs the value as the search made
		// it. The conditions read only the data, so the cast is safe here.
		const fromExample = (example: Condition.Example): Bot =>
			({ ...aliceBot, _tag: "Bot", ...example }) as unknown as Bot

		const scopedRequest = (
			request: typeof Request.Type,
			scope: typeof ScopeName.Type,
		) => {
			const field = request.field === "none" ? undefined : request.field
			const within = scopes[scope]
			return {
				principal: principals[request.principal],
				action: request.action,
				kind: "Bot" as const,
				...(field === undefined ? {} : { field }),
				...(within === undefined ? {} : { within }),
			}
		}

		const inScope = (
			scope: typeof ScopeName.Type,
			principal: Caller,
			value: Bot,
		) => {
			const within = scopes[scope]
			return (
				within === undefined ||
				Condition.evaluateSync(within(Condition.builder(App, "Bot")), {
					value,
					principal,
					path: Bot.descriptor.path,
				})
			)
		}

		const allows = (
			policy: Policy.Policy<App>,
			request: ReturnType<typeof scopedRequest>,
			value: object,
		) =>
			Policy.decideSync(policy, {
				principal: request.principal,
				action: request.action,
				resource: value as Bot,
				...(request.field === undefined ? {} : { field: request.field }),
			})._tag === "Allow"

		it.prop(
			"gives a residual in a scope that agrees with decide",
			{
				specs: Schema.Array(Spec),
				bot: BotInput,
				request: Request,
				scope: ScopeName,
			},
			({ specs, bot, request, scope }) => {
				const policy = build(specs, request)
				const value = Bot.make({
					...bot,
					id: "b9",
					settings: { model: "small", secret: "s" },
				})
				const scoped = scopedRequest(request, scope)
				const residual = Policy.residual(policy, scoped)
				return (
					Condition.evaluateSync(residual, { value }) ===
					(inScope(scope, scoped.principal, value) &&
						allows(policy, scoped, value))
				)
			},
		)

		it.effect.prop(
			"keeps predicate order, calls and errors in every residual",
			{
				specs: Schema.Array(
					Schema.Struct({
						tag: Schema.Literals(["allow", "deny"]),
						answer: Schema.Literals(["yes", "no", "fail"]),
						guard: Schema.Boolean,
					}),
				).check(Schema.isMaxLength(8)),
				bot: BotInput,
				request: Request,
				scope: ScopeName,
			},
			({ specs, bot, request, scope }) =>
				Effect.gen(function* () {
					let calls: ReadonlyArray<string> = []
					const withAlgorithm = (part: typeof specs) =>
						Policy.define(App, { algorithm: request.algorithm })(function* (_) {
							yield* Arr.map(part, (spec, index) =>
								_[spec.tag](request.action, Bot, {
									when: ($) =>
										$.and(
											spec.guard
												? $.eq("ownerUserId", $.principal("userId"))
												: Condition.always,
											$.predicate(`step ${index}`, () =>
												Effect.suspend(() => {
													calls = [...calls, `${index}:${spec.answer}`]
													return spec.answer === "fail"
														? Effect.fail("offline")
														: Effect.succeed(spec.answer === "yes")
												}),
											),
										),
								}),
							)
						})
					const half = Math.floor(specs.length / 2)
					const left = withAlgorithm(specs.slice(0, half))
					const right = withAlgorithm(specs.slice(half))
					const policy =
						request.shape === "rules"
							? withAlgorithm(specs)
							: request.shape === "all"
								? Policy.all([left, right])
								: request.shape === "any"
									? Policy.any([left, right])
									: request.shape === "firstOf"
										? Policy.firstOf([left, right])
										: Policy.ceiling(left, right)
					const value = Bot.make({
						...bot,
						id: "b9",
						settings: { model: "small", secret: "s" },
					})
					const scoped = scopedRequest(request, scope)
					const expected = inScope(scope, scoped.principal, value)
						? yield* Effect.exit(
								Effect.map(
									Policy.decide(policy, {
										principal: scoped.principal,
										action: scoped.action,
										resource: value,
										...(scoped.field === undefined
											? {}
											: { field: scoped.field }),
									}),
									(decision) => decision._tag === "Allow",
								),
							)
						: Exit.succeed(false)
					const expectedCalls = calls
					calls = []
					const residual = Policy.residual(policy, scoped)
					const actual = yield* Effect.exit(
						Condition.evaluate(residual, { value }),
					)
					assert.deepStrictEqual(actual, expected)
					assert.deepStrictEqual(calls, expectedCalls)
				}),
		)

		it.prop(
			"gives a coverage that agrees with decide, with examples",
			{ specs: Schema.Array(Spec), request: Request, scope: ScopeName },
			({ specs, request, scope }) => {
				const policy = build(specs, request)
				const scoped = scopedRequest(request, scope)
				const covered = Policy.coverage(policy, scoped)
				const inside = everyBot.filter((value) =>
					inScope(scope, scoped.principal, value),
				)
				// The condition is the exact filter, for every case.
				const exact = everyBot.every(
					(value) =>
						Condition.evaluateSync(covered.condition, { value }) ===
						(inScope(scope, scoped.principal, value) &&
							allows(policy, scoped, value)),
				)
				switch (covered._tag) {
					case "All":
						return (
							exact &&
							inside.length > 0 &&
							inside.every((value) => allows(policy, scoped, value))
						)
					case "None":
						return (
							exact && inside.every((value) => !allows(policy, scoped, value))
						)
					case "Some": {
						// The examples prove the answer: one value in the scope is
						// allowed, and one is not.
						const allowed = fromExample(covered.allowed)
						const refused = fromExample(covered.refused)
						return (
							exact &&
							inScope(scope, scoped.principal, allowed) &&
							allows(policy, scoped, allowed) &&
							inScope(scope, scoped.principal, refused) &&
							!allows(policy, scoped, refused)
						)
					}
					case "Unknown":
						// These policies have no predicates, and they are small.
						return false
				}
			},
		)

		it.prop(
			"gives a coverage that is right for any value of the Schema",
			{
				specs: Schema.Array(Spec),
				request: Request,
				scope: ScopeName,
				bots: Schema.Array(Bot),
			},
			({ specs, request, scope, bots }) => {
				const policy = build(specs, request)
				const scoped = scopedRequest(request, scope)
				const covered = Policy.coverage(policy, scoped)
				const inside = [...bots, ...everyBot].filter((value) =>
					inScope(scope, scoped.principal, value),
				)
				switch (covered._tag) {
					case "All":
						return inside.every((value) => allows(policy, scoped, value))
					case "None":
						return inside.every((value) => !allows(policy, scoped, value))
					default:
						return true
				}
			},
		)

		it.prop(
			"decides a kind so that each value of the Schema agrees",
			{
				specs: Schema.Array(Spec),
				request: Request,
				scope: ScopeName,
				bots: Schema.Array(Bot),
			},
			({ specs, request, scope, bots }) => {
				const policy = build(specs, request)
				const scoped = scopedRequest(request, scope)
				const inside = [...bots, ...everyBot].filter((value) =>
					inScope(scope, scoped.principal, value),
				)
				const tagOf = (value: Bot) =>
					Policy.decideSync(policy, {
						principal: scoped.principal,
						action: scoped.action,
						resource: value,
						...(scoped.field === undefined ? {} : { field: scoped.field }),
					})._tag
				switch (Analysis.decideKind(policy, scoped)._tag) {
					case "Allow":
						return inside.every((value) => tagOf(value) === "Allow")
					case "NotApplicable":
						return inside.every((value) => tagOf(value) !== "Deny")
					case "Deny":
						return true
				}
			},
		)

		it.prop(
			"permits the fields that decide allows, and no others",
			{ specs: Schema.Array(Spec), bot: BotInput, request: Request },
			({ specs, bot, request }) => {
				const policy = build(specs, request)
				const value = Bot.make({
					...bot,
					id: "b9",
					settings: { model: "small", secret: "s" },
				})
				const principal = principals[request.principal]
				const permitted = Effect.runSync(
					Policy.permittedFields(policy, {
						principal,
						action: request.action,
						resource: value,
					}),
				)
				const allows = (field: string) =>
					Policy.decideSync(policy, {
						principal,
						action: request.action,
						resource: value,
						// A field from the list is a field of a Bot.
						field: field as never,
					})._tag === "Allow"
				// Each listed field that holds no parts is in the list when
				// decide allows it.
				const plain = Arr.filter(
					Catalog.fieldsOf(ResourceData.descriptor(Bot).catalog),
					(field) => field.listed && !field.open,
				)
				return (
					permitted.every(allows) &&
					plain.every(
						(field) => permitted.includes(field.text) === allows(field.text),
					)
				)
			},
		)
	})

	it("checks the trigger rules too", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("write", Trigger, {
				when: ($) => $.eq("enabled", true),
			})
		})
		assert.strictEqual(
			tagOf(
				Policy.decideSync(policy, {
					principal: alice,
					action: "write",
					resource: aliceTrigger,
				}),
			),
			"Allow",
		)
	})

	it.effect("gives a new trace each time an explanation runs", () =>
		Effect.gen(function* () {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("read", Bot)
			})
			const explain = Policy.explain(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})
			const first = yield* explain
			const second = yield* explain
			assert.strictEqual(first.steps.length, 1)
			assert.strictEqual(second.steps.length, 1)
		}),
	)

	describe("keeps a predicate that may fail in the residual", () => {
		const _ = Policy.builder(App)
		const offline = (tag: "allow" | "deny") =>
			_[tag]("read", Bot, {
				when: ($) => $.predicate("offline", () => Effect.fail("offline")),
			})
		const request = {
			principal: alice,
			action: "read",
			kind: "Bot",
		} as const
		const valueRequest = {
			principal: alice,
			action: "read",
			resource: aliceBot,
		} as const
		const check = (policy: Policy.Policy<App, Condition.Opaque<string>>) =>
			Effect.gen(function* () {
				const decision = yield* Effect.exit(Policy.decide(policy, valueRequest))
				assert.isTrue(Exit.isFailure(decision))
				const residual = Policy.residual(policy, request)
				assert.notStrictEqual(residual._tag, "True")
				const result = yield* Effect.exit(
					Condition.evaluate(residual, { value: aliceBot }),
				)
				assert.isTrue(Exit.isFailure(result))
			})

		it.effect("in the deny rules of permitOverrides", () =>
			check(
				rulesOf(App, [offline("deny")], {
					algorithm: "permitOverrides",
				}),
			),
		)

		it.effect("does not run a child of all after a deny", () =>
			Effect.gen(function* () {
				const policy = Policy.any([
					Policy.all([
						rulesOf(App, [_.deny("read", Bot)]),
						rulesOf(App, [offline("allow")]),
					]),
					rulesOf(App, [_.allow("read", Bot)]),
				])
				const residual = Policy.residual(policy, request)
				assert.deepStrictEqual(
					yield* Effect.exit(Condition.evaluate(residual, { value: aliceBot })),
					Exit.succeed(true),
				)
			}),
		)

		it.effect("runs each predicate as many times as decide", () =>
			Effect.gen(function* () {
				let calls = 0
				const policy = Policy.all([
					rulesOf(App, [
						_.deny("read", Bot, {
							when: ($) =>
								$.predicate("first", () => {
									calls = calls + 1
									return calls === 1
								}),
						}),
						_.allow("read", Bot),
					]),
				])
				const decision = yield* Policy.decide(policy, valueRequest)
				assert.strictEqual(decision._tag, "Deny")
				calls = 0
				const residual = Policy.residual(policy, request)
				assert.isFalse(yield* Condition.evaluate(residual, { value: aliceBot }))
				assert.strictEqual(calls, 1)
			}),
		)

		it.effect("in a list of rules", () =>
			check(
				rulesOf(App, [offline("allow"), _.allow("read", Bot)], {
					algorithm: "firstApplicable",
				}),
			),
		)

		it.effect("in a child of all after a child with no answer", () =>
			check(
				Policy.any([
					Policy.all([emptyOf(App), rulesOf(App, [offline("allow")])]),
					rulesOf(App, [_.allow("read", Bot)]),
				]),
			),
		)

		it.effect("in a child that does not allow", () =>
			check(
				Policy.any([
					rulesOf(App, [offline("deny")], {
						algorithm: "permitOverrides",
					}),
					rulesOf(App, [_.allow("read", Bot)]),
				]),
			),
		)
	})

	it("gives the fields inside an optional struct", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				settings: Schema.optionalKey(
					Schema.Struct({ open: Schema.String, secret: Schema.String }),
				),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
			yield* _.deny("read", Note, { fields: ["settings.secret"] })
		})
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ settings: { open: "a", secret: "b" } }),
			}),
		)
		assert.deepStrictEqual(fields, ["settings.open"])
	})

	it("decodes a rule with a field of an optional principal struct", () => {
		class User extends Schema.Class<User, { readonly brand: unique symbol }>(
			"User",
		)({
			user: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
		}) {}
		const Blog = Domain.make({ principal: User, resources: [Bot] })
		const policy = Policy.define(Blog)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("user.id")),
			})
		})
		const PolicySchema = Policy.schema(Blog)
		const json = Schema.encodeSync(PolicySchema)(policy)
		assert.isTrue(Equal.equals(Schema.decodeSync(PolicySchema)(json), policy))
	})

	it("is not applicable for an action that the kind does not have", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("*", "*")
		})
		const request = {
			principal: alice,
			action: "write",
			resource: aliceBot,
		} as unknown as Policy.Request<App>
		assert.strictEqual(Policy.decideSync(policy, request)._tag, "NotApplicable")
	})

	it("gives a predicate residual no answer for a value of another kind", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("level", (bot) => bot.level !== 0),
			})
		})
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.isFalse(
			Effect.runSync(
				// The types stop a Trigger here. The test casts, to check the code.
				Condition.evaluate(
					residual as unknown as Condition.Condition<unknown, Condition.Opaque>,
					{ value: aliceTrigger },
				),
			),
		)
	})

	it("does not let a rule for no fields cover a request", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { fields: [] })
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"NotApplicable",
		)
		assert.deepStrictEqual(
			Policy.residual(policy, {
				principal: alice,
				action: "read",
				kind: "Bot",
			}),
			Condition.never,
		)
	})

	it("does not let a field name be empty", () => {
		assert.throws(() =>
			Resource.make("Note", {
				actions: ["read"],
				fields: { "": Schema.Struct({ secret: Schema.String }) },
			}),
		)
	})

	it("does not call a policy with a predicate a plain policy", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: ($) => $.predicate("p", () => true) })
		})
		assert.isFalse(Schema.is(Policy.schema(App))(policy))
	})

	it("keeps class methods and opaque data for predicates", () => {
		class Doc extends Resource.Class<Doc>()("Doc", {
			actions: ["read"],
			fields: { flags: Schema.Record(Schema.String, Schema.Boolean) },
		}) {
			get blocked() {
				return this.flags["blocked"] === true
			}
		}
		const Docs = Domain.make({ principal: Caller, resources: [Doc] })
		Policy.define(Docs)(function* (_) {
			yield* _.allow("read", Doc, {
				when: ($) =>
					$.predicate("active", (doc) => doc.flags["active"] === true),
			})
		})
		const doc = Doc.make({ flags: { blocked: true } })
		assert.isTrue(doc instanceof Doc)
		assert.isTrue(doc.blocked)
	})

	it("does not let a field name have a dot", () => {
		assert.throws(() =>
			Resource.make("Note", {
				actions: ["read"],
				fields: { "owner.id": Schema.String },
			}),
		)
	})

	it("does not let a resource have a field named _tag", () => {
		assert.throws(() =>
			Resource.make("Secret", {
				actions: ["read"],
				fields: { _tag: Schema.String, id: Schema.String },
			}),
		)
	})

	it("does not use a condition from a different domain with the same types", () => {
		const First = Domain.make({ principal: Caller, resources: [Bot] })
		const Second = Domain.make({ principal: Caller, resources: [Bot] })
		const condition = Condition.builder(First, "Bot").eq("name", "Helper")
		assert.throws(() =>
			Policy.define(Second)(function* (_) {
				yield* _.allow("read", Bot, { when: () => condition })
			}),
		)
		const policy = Policy.define(First)(function* (_) {
			yield* _.allow("read", Bot, { when: () => condition })
		})
		const exit = Schema.encodeExit(Policy.schema(Second))(policy)
		assert.isTrue(Exit.isFailure(exit))
		assert.isFalse(Exit.hasDies(exit))
	})

	it("does not take a rule from the builder of a domain with the same types", () => {
		const First = Domain.make({ principal: Caller, resources: [Bot] })
		const Second = Domain.make({ principal: Caller, resources: [Bot] })
		const rule = Policy.builder(First).allow("read", Bot)
		assert.throws(() => rulesOf(Second, [rule]))
		assert.doesNotThrow(() => rulesOf(First, [rule]))
	})

	it("does not take a rule of another domain", () => {
		const Small = Resource.make("Bot", {
			actions: ["read"],
			fields: { id: Schema.String },
		})
		const Other = Domain.make({ principal: Caller, resources: [Small] })
		const rule = Policy.builder(App).allow("read", Bot, {
			when: ($) => $.eq("ownerUserId", null),
		})
		// The types stop this. The test casts the rule, to check the code too.
		assert.throws(() => rulesOf(Other, [rule as Policy.AnyRule]))
	})
})
