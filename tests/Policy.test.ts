import { assert, describe, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import {
	Array as Arr,
	Context,
	Effect,
	Equal,
	Exit,
	Hash,
	Result,
	Schema,
	SchemaTransformation,
} from "effect"
import { Condition, Decision, Domain, Policy, Resource } from "../src/index.ts"
import { readPart } from "../src/internal/read.ts"
import * as RuleData from "../src/internal/rule.ts"
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

const PolicySchemaOfApp = Policy.schema(App)

/** Tests if the catalog of a resource has a field at a path. */
const hasField = (resource: Resource.Any, path: string): boolean =>
	Catalog.lookup(ResourceData.descriptor(resource).catalog, path) !== undefined

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
			yield* _.deny("update", Bot, { fields: ["settings.*"] })
			yield* _.allow("read", Bot, { fields: ["name", "settings.**"] })
		})

		it("matches field patterns", () => {
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

	describe("schema", () => {
		const PolicySchema = Policy.schema(App)

		it("keeps a policy tree as JSON", () => {
			const policy = Policy.all([
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot, {
						when: ($) => $.under("org", $.principal("organizationId")),
						fields: ["name", "settings.*"],
						reason: "Read",
						id: "r1",
						meta: { scope: "chat" },
					})
				}),
				Policy.define(App, { algorithm: "lastApplicable" })(function* (_) {
					yield* _.deny("*", "*")
				}),
			])
			const json = JSON.parse(
				JSON.stringify(Schema.encodeSync(PolicySchema)(policy)),
			)
			const decoded = Schema.decodeUnknownSync(PolicySchema)(json)
			assert.isTrue(Equal.equals(decoded, policy))
		})

		it("keeps the JSON form of meta in JSON.stringify", () => {
			const Counted = Domain.make({
				principal: Caller,
				resources: [Bot],
				meta: Schema.FiniteFromString,
			})
			const policy = Policy.define(Counted)(function* (_) {
				yield* _.allow("read", Bot, { meta: 5 })
			})
			const CountedSchema = Policy.schema(Counted)
			const json = JSON.parse(JSON.stringify(policy))
			assert.deepStrictEqual(json, Schema.encodeSync(CountedSchema)(policy))
			assert.isTrue(
				Equal.equals(Schema.decodeUnknownSync(CountedSchema)(json), policy),
			)
		})

		it("decodes a deep tree with very many rules in a small heap", () => {
			const output = execFileSync(
				process.execPath,
				[
					"--max-old-space-size=150",
					new URL("./scripts/deep-policy.ts", import.meta.url).pathname,
				],
				{ encoding: "utf8" },
			)
			assert.strictEqual(output.trim(), "decoded")
		}, 60_000)

		it("binds a deep rule with very many problems in a small heap", () => {
			const output = execFileSync(
				process.execPath,
				[
					"--max-old-space-size=150",
					new URL("./scripts/many-problems.ts", import.meta.url).pathname,
				],
				{ encoding: "utf8" },
			)
			assert.strictEqual(output.trim(), "failed")
		}, 60_000)

		it("stops a very long list of values before it reads them, in a small heap", () => {
			// The values count in the limit of a condition and of a policy.
			Arr.forEach(["conditionNodes", "policyNodes"], (limit) => {
				const output = execFileSync(
					process.execPath,
					[
						"--max-old-space-size=96",
						new URL("./scripts/long-in.ts", import.meta.url).pathname,
						limit,
					],
					{ encoding: "utf8" },
				)
				assert.strictEqual(output.trim(), "failed")
			})
		}, 60_000)

		it("makes no more than the most issues for a long list of wrong values, in a small heap", () => {
			// The values of an `In` test, and the parts of the prefix of an
			// `Under` test.
			Arr.forEach(["wrong-in.ts", "wrong-under.ts"], (script) => {
				const output = execFileSync(
					process.execPath,
					[
						"--max-old-space-size=128",
						new URL(`./scripts/${script}`, import.meta.url).pathname,
					],
					{ encoding: "utf8" },
				)
				assert.strictEqual(output.trim(), "failed")
			})
		}, 60_000)

		it("makes the catalog of a union that holds one union in many places, in a small heap", () => {
			const output = execFileSync(
				process.execPath,
				[
					"--max-old-space-size=128",
					new URL("./scripts/shared-union.ts", import.meta.url).pathname,
				],
				{ encoding: "utf8" },
			)
			assert.strictEqual(output.trim(), "made")
		}, 60_000)

		it("does not decode a shared input that would be too large", () => {
			// A domain with small limits, so the test is short. A decoder stops
			// at the first node past a limit, so the time grows with the limit,
			// not with the input.
			const Small = Domain.make({
				principal: Caller,
				resources: [Bot],
				limits: { policyNodes: 100_000, conditionNodes: 50_000 },
			})
			const SmallSchema = Policy.schema(Small)
			const shared = Arr.reduce(
				Arr.range(1, 26),
				{ _tag: "Rules", algorithm: "denyOverrides", rules: [] } as unknown,
				(inner) => ({ _tag: "All", policies: [inner, inner] }),
			)
			const start = Date.now()
			const exit = Schema.decodeUnknownExit(SmallSchema)(shared)
			assert.isTrue(Exit.isFailure(exit))
			assert.include(
				String(Exit.isFailure(exit) ? exit.cause : ""),
				"A policy tree has more than 100000 nodes. The most is 100000.",
			)
			const condition = Arr.reduce(
				Arr.range(1, 30),
				{ _tag: "True" } as unknown,
				(inner) => ({ _tag: "And", conditions: [inner, inner] }),
			)
			const conditionExit = Schema.decodeUnknownExit(SmallSchema)({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Bot"],
						when: condition,
					},
				],
			})
			assert.isTrue(Exit.isFailure(conditionExit))
			assert.include(
				String(Exit.isFailure(conditionExit) ? conditionExit.cause : ""),
				"A condition has more than 50000 nodes and values. The most is 50000.",
			)
			// The full inputs have more than 10 ** 7 nodes, so a short time shows
			// that the decoders stop at the limit.
			assert.isBelow(Date.now() - start, 3000)
			const high = Arr.reduce(Arr.range(1, 1001), {} as unknown, (inner) => ({
				a: inner,
				b: inner,
			}))
			const startHigh = Date.now()
			assert.isTrue(
				Exit.isFailure(Schema.decodeUnknownExit(PolicySchema)(high)),
			)
			assert.isTrue(
				Exit.isFailure(Schema.decodeUnknownExit(Condition.schema)(high)),
			)
			assert.isBelow(Date.now() - startHigh, 3000)
		})

		it("does not decode an input with keys that a loop does not see", () => {
			const condition: Record<string, unknown> = { _tag: "Not" }
			Object.defineProperty(condition, "condition", { value: condition })
			const exit = Schema.decodeUnknownExit(Condition.schema)(condition)
			assert.isTrue(Exit.isFailure(exit))
			assert.notInclude(
				String(Exit.isFailure(exit) ? exit.cause : ""),
				"RangeError",
			)
			const policy: Record<string, unknown> = { _tag: "All" }
			Object.defineProperty(policy, "policies", { value: [policy] })
			const policyExit = Schema.decodeUnknownExit(PolicySchema)(policy)
			assert.isTrue(Exit.isFailure(policyExit))
			assert.notInclude(
				String(Exit.isFailure(policyExit) ? policyExit.cause : ""),
				"RangeError",
			)
		})

		it("does not decode an input with keys from a prototype", () => {
			const deep = Arr.reduce(
				Arr.range(1, 5000),
				{ _tag: "True" } as unknown,
				(child) => Object.create({ _tag: "Not", condition: child }) as unknown,
			)
			const exit = Schema.decodeUnknownExit(Condition.schema)(deep)
			assert.isTrue(Exit.isFailure(exit))
			assert.notInclude(
				String(Exit.isFailure(exit) ? exit.cause : ""),
				"RangeError",
			)
		})

		it("decodes deep JSON without filling the stack", () => {
			const one = Schema.encodeSync(PolicySchema)(
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot)
				}),
			) as unknown
			const deep = Arr.reduce(Arr.range(1, 50_000), one, (inner) => ({
				_tag: "All",
				policies: [inner],
			}))
			const exit = Schema.decodeUnknownExit(PolicySchema)(deep)
			assert.isTrue(Exit.isSuccess(exit))
			if (Exit.isSuccess(exit)) {
				assert.strictEqual(
					Policy.decideSync(exit.value, {
						principal: alice,
						action: "read",
						resource: aliceBot,
					})._tag,
					"Allow",
				)
			}
			const when = Arr.reduce(
				Arr.range(1, 50_000),
				{ _tag: "True" } as unknown,
				(inner) => ({ _tag: "Not", condition: inner }),
			)
			const exitWhen = Schema.decodeUnknownExit(PolicySchema)({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [{ _tag: "Allow", actions: ["read"], resources: ["Bot"], when }],
			})
			assert.isTrue(Exit.isSuccess(exitWhen))
		})

		const decodeMessage = (rule: Policy.EncodedRule) => {
			const result = Schema.decodeExit(PolicySchema)({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [rule],
			})
			assert.isTrue(Exit.isFailure(result))
			return String(Exit.isFailure(result) ? result.cause : "")
		}

		it("checks names against the domain", () => {
			const message = decodeMessage({
				_tag: "Allow",
				actions: ["fly"],
				resources: ["Ghost", "Trigger"],
				fields: ["level"],
				when: {
					_tag: "Compare",
					op: "eq",
					field: "enabled",
					value: { _tag: "Principal", path: "tenant" },
				},
			})
			Arr.map(["Ghost", "fly", "level", "tenant"], (part) =>
				assert.include(message, part),
			)
		})

		it("checks the extra data of a rule with the Schema of the domain", () => {
			assert.include(
				decodeMessage({
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					meta: { scope: "forever" },
				}),
				`Expected "once" | "chat" | "lifetime"`,
			)
		})
	})

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

		type BotBuilder = Condition.Builder<Policy.DataFor<App, "Bot">, Bot, Caller>
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
				Condition.evaluateSync(within(Condition.builder()), {
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
		class User extends Schema.Class<User>("User")({
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

	it("gives the fields inside a suspended struct", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				settings: Schema.suspend(() =>
					Schema.Struct({ open: Schema.String, secret: Schema.String }),
				),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
		})
		assert.deepStrictEqual(
			Effect.runSync(
				Policy.permittedFields(policy, {
					principal: alice,
					action: "read",
					resource: Note.make({ settings: { open: "o", secret: "s" } }),
				}),
			),
			["settings.open", "settings.secret"],
		)
	})

	it("denies a request for a whole record when a deny rule names a part of it", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { data: Schema.Record(Schema.String, Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
			yield* _.deny("read", Note, { fields: ["data.secret" as never] })
		})
		const decide = (field: string) =>
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ data: { secret: "s" } }),
				field: field as never,
			})._tag
		assert.strictEqual(decide("data.secret"), "Deny")
		// The whole record shows the denied key too.
		assert.strictEqual(decide("data"), "Deny")
		assert.strictEqual(decide("data.public"), "Allow")
		assert.strictEqual(
			Policy.residual(policy, {
				principal: alice,
				action: "read",
				kind: "Note",
				field: "data" as never,
			})._tag,
			"False",
		)
	})

	it("leaves out a record field when a deny rule names a part of it", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				title: Schema.String,
				settings: Schema.Record(Schema.String, Schema.String),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = rulesOf(Notes, [
			Policy.builder(Notes).allow("read", Note),
			Policy.rule({
				_tag: "Deny",
				actions: ["read"],
				resources: ["Note"],
				fields: ["settings.*"],
			}),
		])
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ title: "a", settings: { secret: "b" } }),
			}),
		)
		assert.deepStrictEqual(fields, ["title"])
	})

	it("matches field patterns", () => {
		assert.isTrue(RuleData.matchesField("address.*", "address.city"))
		// A pattern matches the fields below a field that it matches.
		assert.isTrue(RuleData.matchesField("address.*", "address.city.code"))
		assert.isTrue(RuleData.matchesField("address", "address.city"))
		assert.isFalse(RuleData.matchesField("address", "addressCity"))
		assert.isTrue(RuleData.matchesField("address.**", "address.city.code"))
		assert.isTrue(RuleData.matchesField("**", "name"))
		assert.isTrue(RuleData.matchesField("*.city", "address.city"))
		assert.isFalse(RuleData.matchesField("*.city", "city"))
		assert.isTrue(RuleData.matchesField("a*c", "abbc"))
		assert.isFalse(RuleData.matchesField("a*c", "a.c"))
		assert.isTrue(RuleData.matchesInside("settings.*", "settings"))
		assert.isTrue(RuleData.matchesInside("**", "settings"))
		assert.isFalse(RuleData.matchesInside("settings", "settings"))
		assert.isFalse(RuleData.matchesInside("name.*", "settings"))
		assert.isTrue(RuleData.matchesInside("settings.", "settings"))
	})

	it("matches patterns by Unicode code points", () => {
		assert.isTrue(RuleData.matchesField("🔒*", "🔒secret"))
		assert.isTrue(RuleData.matchesField("a*", "a🔒"))
		assert.isFalse(RuleData.matchesField("🔒*", "🔓secret"))
	})

	it("takes a rule on a part of a record field", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { settings: Schema.Record(Schema.String, Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note, {
				when: ($) => $.eq("settings.mode", "open"),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ settings: { mode: "open" } }),
			})._tag,
			"Allow",
		)
		const PolicySchema = Policy.schema(Notes)
		const json = Schema.encodeSync(PolicySchema)(policy)
		assert.isTrue(Equal.equals(Schema.decodeSync(PolicySchema)(json), policy))
	})

	it("stops in a short time when a residual is too large", () => {
		const policy = Arr.reduce(
			Arr.range(0, 23),
			Policy.define(App)(function* (_) {
				yield* _.allow("read", Bot, { when: ($) => $.eq("level", 1) })
				yield* _.deny("read", Bot, { when: ($) => $.eq("name", "Team") })
			}) as Policy.Policy<App>,
			(inner, depth) =>
				depth % 2 === 0 ? Policy.any([inner]) : Policy.all([inner]),
		)
		const start = Date.now()
		assert.throws(() =>
			Policy.residual(policy, {
				principal: alice,
				action: "read",
				kind: "Bot",
			}),
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	describe("strings with one hash", () => {
		// Effect hashes a string from its end, with `h = (h * 33) ^ code`, and
		// with no random seed. From a state `h`, for two codes `a` and `b`, the
		// state after `b` gives the one `a` that makes the state `target`, when
		// the high bits agree. So `blocks` gives different strings of two codes
		// that take one state to one state.
		const blocks = (state: number) => {
			const after = (b: number) => Math.imul(Math.imul(state, 33) ^ b, 33)
			const high = after(0) >>> 16
			const target = (high << 16) | 0x1234
			return {
				target,
				strings: Arr.flatMap(Arr.range(0, 0xffff), (b) =>
					after(b) >>> 16 === high
						? [String.fromCharCode((after(b) ^ target) & 0xffff, b)]
						: [],
				),
			}
		}
		const first = blocks(5381)
		const strings = first.strings
		// A block from the state after `strings`, and then one of `strings`,
		// gives very many more strings with one hash. The names leave out the
		// codes that a field pattern reads.
		const longer = Arr.filter(
			Arr.flatMap(Arr.take(blocks(first.target).strings, 26), (head) =>
				Arr.map(strings, (tail) => head + tail),
			),
			(text) => !/[.*\\]/.test(text),
		)

		it("has very many strings with one hash", () => {
			assert.isAbove(strings.length, 1900)
			assert.strictEqual(new Set(Arr.map(strings, Hash.string)).size, 1)
			assert.isAbove(longer.length, 45_000)
			assert.strictEqual(new Set(Arr.map(longer, Hash.string)).size, 1)
		})

		it("binds a rule with very many kinds and patterns of them in a short time", () => {
			const begin = Date.now()
			const result = Schema.decodeResult(Policy.schema(App))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: longer,
					},
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Bot"],
						fields: Arr.map(longer, (text) => `*${text}`),
					},
				],
			})
			assert.isTrue(Result.isFailure(result))
			assert.isBelow(Date.now() - begin, 3000)
		})

		it("searches the tests of them in a short time", () => {
			const names = ["a", "b", "c", "d", "e", "f", "g", "h"] as const
			const $ = Condition.builder<
				Readonly<Record<(typeof names)[number], string>>,
				unknown,
				unknown
			>()
			const condition = $.and(
				...Arr.flatMap(names, (name, index) => [
					$.in(name, strings),
					$.not($.in(name, strings.slice(index, index + 1000))),
				]),
			)
			const begin = Date.now()
			assert.strictEqual(Condition.satisfiable(condition)._tag, "Satisfiable")
			assert.isBelow(Date.now() - begin, 1000)
		})

		it("decides and checks a policy with tests of them in a short time", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("read", Bot, {
					when: ($) =>
						$.or(...Arr.map(strings, (value) => $.eq("name", value))),
				})
				yield* _.deny("read", Bot, {
					when: ($) => $.in("name", strings),
				})
			})
			const begin = Date.now()
			assert.strictEqual(
				Policy.decideSync(policy, {
					principal: alice,
					action: "read",
					resource: aliceBot,
				})._tag,
				"NotApplicable",
			)
			// The search may stop at its budget, with `Unknown`.
			assert.include(
				["None", "Unknown"],
				Policy.coverage(policy, {
					principal: alice,
					action: "read",
					kind: "Bot",
				})._tag,
			)
			assert.isBelow(Date.now() - begin, 2000)
		})
	})

	it("decides a shared tree in a short time", () => {
		const base: Policy.Policy<App> = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		})
		const any = Arr.reduce(Arr.range(0, 14), base, (inner) =>
			Policy.any([inner, inner]),
		)
		const all = Arr.reduce(Arr.range(0, 14), base, (inner) =>
			Policy.all([inner, inner]),
		)
		const request = { principal: alice, action: "read", kind: "Bot" } as const
		const start = Date.now()
		assert.deepStrictEqual(Policy.residual(any, request), Condition.always)
		assert.deepStrictEqual(Policy.residual(all, request), Condition.always)
		assert.strictEqual(
			Policy.decideSync(all, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
		// The tree has 2 ** 15 places, and a walk of it takes about 300 ms. A
		// walk that went into each place again for each path would not end in
		// this time, but a busy machine may need more than one second.
		assert.isBelow(Date.now() - start, 3000)
		// A shared child counts for each place. With 3 * 2 ** 19 - 1 nodes, four
		// more levels are too many.
		assert.throws(
			() =>
				Arr.reduce(Arr.range(1, 4), all, (inner) => Policy.all([inner, inner])),
			/1572863 nodes. The most is 1000000/,
		)
	})

	it("makes a residual of a shared condition in a short time", () => {
		// A shared child counts for each place, so 15 levels are near the most.
		const condition = Arr.reduce(
			Arr.range(0, 14),
			Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>().eq(
				"level",
				2,
			) as Condition.Test<Bot>,
			(inner) => Condition.and(inner, inner),
		)
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: () => condition })
		})
		const start = Date.now()
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("finds the fields of a class in a JSON string codec", () => {
		class User extends Schema.Class<User>("User")({ id: Schema.String }) {}
		const Json = Domain.make({
			principal: Schema.fromJsonString(User),
			resources: [Bot],
		})
		const policy = Policy.define(Json)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("id")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: User.make({ id: "alice" }),
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
	})

	it("decides again each time the Effect runs", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { owner: Schema.mutableKey(Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.all([
			Policy.define(Notes)(function* (_) {
				yield* _.allow("read", Note, {
					when: ($) => $.eq("owner", $.principal("userId")),
				})
			}),
		])
		const note = Note.make({ owner: "alice" })
		const decide = Policy.decide(policy, {
			principal: alice,
			action: "read",
			resource: note,
		})
		assert.strictEqual(Effect.runSync(decide)._tag, "Allow")
		note.owner = "bob"
		assert.strictEqual(Effect.runSync(decide)._tag, "NotApplicable")
	})

	it("leaves out a field that holds a struct in one branch of a union", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				data: Schema.Union([
					Schema.Struct({ value: Schema.Null }),
					Schema.Struct({ value: Schema.Struct({ secret: Schema.String }) }),
				]),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
			yield* _.deny("read", Note, { fields: ["data.value.secret"] })
		})
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ data: { value: { secret: "s" } } }),
			}),
		)
		assert.notInclude(fields, "data.value")
		assert.notInclude(fields, "data.value.secret")
	})

	it("does not find fields inside an Option codec", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				owner: Schema.OptionFromNullOr(Schema.Struct({ id: Schema.String })),
			},
		})
		assert.isTrue(hasField(Note, "owner"))
		assert.isFalse(hasField(Note, "owner.id"))
	})

	it("keeps a field that holds a scalar or a struct", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				data: Schema.Union([
					Schema.String,
					Schema.Struct({ secret: Schema.String }),
				]),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
		})
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ data: "text" }),
			}),
		)
		assert.include(fields, "data")
	})

	it("simplifies a condition with many shared parts in a short time", () => {
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		const build = (seed: number) =>
			Arr.reduce(
				Arr.range(0, 11),
				$.eq("level", 0) as Condition.Test<Bot, Caller>,
				(c, level) => {
					const a = $.eq("name", `${String(seed)}-${String(level)}-a`)
					const b = $.eq("name", `${String(seed)}-${String(level)}-b`)
					return level % 2 === 0
						? $.and($.or(c, a), $.or(c, b))
						: $.or($.and(c, a), $.and(c, b))
				},
			)
		const condition = $.or(build(1), build(2))
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: () => condition })
		})
		const start = Date.now()
		try {
			Policy.residual(policy, { principal: alice, action: "read", kind: "Bot" })
		} catch {
			// A residual that is too large is an error. This test is about time.
		}
		assert.isBelow(Date.now() - start, 2000)
	})

	it("does not load JSON of a policy with a number that JSON can not hold", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
			yield* _.deny("read", Bot, { when: ($) => $.lt("level", Infinity) })
		})
		const json: unknown = JSON.parse(JSON.stringify(policy))
		assert.throws(() => Schema.decodeUnknownSync(Policy.schema(App))(json))
	})

	it("does not call a field of Schema.declare a field of objects", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				label: Schema.declare((u): u is string => typeof u === "string"),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = rulesOf(Notes, [
			Policy.builder(Notes).allow("read", Note),
			Policy.rule({
				_tag: "Deny",
				actions: ["read"],
				resources: ["Note"],
				when: Condition.builder<
					{ readonly label: string },
					unknown,
					unknown
				>().eq("label", "secret"),
			}),
		])
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "Note",
		})
		assert.notStrictEqual(covered._tag, "All")
	})

	it("lets a JSON field hold a scalar in the search", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { label: Schema.Json },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = rulesOf(Notes, [
			Policy.builder(Notes).allow("read", Note),
			Policy.rule({
				_tag: "Deny",
				actions: ["read"],
				resources: ["Note"],
				when: Condition.builder<
					{ readonly label: string },
					unknown,
					unknown
				>().eq("label", "secret"),
			}),
		])
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "Note",
		})
		assert.notStrictEqual(covered._tag, "All")
	})

	it("reads only the own data fields of a value", () => {
		class Info {
			get owner() {
				return "alice"
			}
		}
		const value = { info: new Info() }
		const $ = Condition.builder<
			{ readonly info: { readonly owner: string } },
			unknown,
			unknown
		>()
		// A getter is not data that a Schema describes, so a read is a defect.
		assert.throws(
			() => Condition.evaluateSync($.exists("info.owner"), { value }),
			/not plain data/,
		)
		// A name of `Object.prototype` is not a field.
		assert.isFalse(
			Condition.evaluateSync(
				Condition.builder<
					{ readonly constructor: string | null },
					unknown,
					unknown
				>().exists("constructor"),
				{ value: {} },
			),
		)
	})

	it("tests the fields below a union one by one", () => {
		const Pair = Resource.make("Pair", {
			actions: ["read"],
			fields: {
				pair: Schema.Union([
					Schema.Struct({ a: Schema.Literal("a"), b: Schema.Literal("a") }),
					Schema.Struct({ a: Schema.Literal("b"), b: Schema.Literal("b") }),
				]),
			},
		})
		const condition = Condition.builder<
			{ readonly pair: { readonly a: "a" | "b"; readonly b: "a" | "b" } },
			unknown,
			unknown
		>().and(
			Condition.builder<
				{ readonly pair: { readonly a: "a" | "b" } },
				unknown,
				unknown
			>().eq("pair.a", "a"),
			Condition.builder<
				{ readonly pair: { readonly b: "a" | "b" } },
				unknown,
				unknown
			>().eq("pair.b", "b"),
		)
		const schema = ResourceData.descriptor(Pair).schema
		// The shape of the union lets each field hold "a" or "b". The search
		// does not tie the two fields together.
		assert.strictEqual(
			Condition.satisfiable(condition, { schema })._tag,
			"Satisfiable",
		)
		assert.strictEqual(
			Condition.satisfiable(
				Condition.builder<
					{ readonly pair: { readonly a: string } },
					unknown,
					unknown
				>().eq("pair.a", "c"),
				{ schema },
			)._tag,
			"Unsatisfiable",
		)
	})

	it("stops a search with many constants at once when the budget is small", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { name: Schema.String },
		})
		const names = Array.from({ length: 12_000 }, (_, index) => String(index))
		const condition = Condition.builder<
			{ readonly name: string },
			unknown,
			unknown
		>().in("name", names)
		const start = Date.now()
		assert.strictEqual(
			Condition.satisfiable(condition, {
				schema: ResourceData.descriptor(Note).schema,
				budget: 0,
			})._tag,
			"Unknown",
		)
		assert.isBelow(Date.now() - start, 300)
	})

	it("lets an empty struct field hold a scalar in the search", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { data: Schema.Struct({}) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = rulesOf(Notes, [
			Policy.builder(Notes).allow("read", Note),
			Policy.rule({
				_tag: "Deny",
				actions: ["read"],
				resources: ["Note"],
				when: Condition.builder<
					{ readonly data: string },
					unknown,
					unknown
				>().eq("data", "secret"),
			}),
		])
		assert.notStrictEqual(
			Policy.coverage(policy, {
				principal: alice,
				action: "read",
				kind: "Note",
			})._tag,
			"All",
		)
	})

	it("tests the fields of a parent that may be missing one by one", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				info: Schema.optionalKey(
					Schema.Struct({ a: Schema.String, b: Schema.String }),
				),
			},
		})
		const $ = Condition.builder<
			{ readonly info?: { readonly a: string; readonly b: string } },
			unknown,
			unknown
		>()
		const schema = ResourceData.descriptor(Note).schema
		assert.strictEqual(
			Condition.satisfiable($.and($.eq("info.a", null), $.eq("info.b", "x")), {
				schema,
			})._tag,
			"Satisfiable",
		)
		assert.strictEqual(
			Condition.satisfiable($.eq("info.a", 1 as never), { schema })._tag,
			"Unsatisfiable",
		)
	})

	it("folds a condition with shared parts in a short time", () => {
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		const shared = Arr.reduce(
			Arr.range(0, 11),
			$.eq("level", 0) as Condition.Test<Bot>,
			(c, level) =>
				$.and(
					$.or(c, $.eq("name", `${String(level)}-a`)),
					$.or(c, $.eq("name", `${String(level)}-b`)),
				),
		)
		const count = Condition.fold<number>({
			true: () => 1,
			false: () => 1,
			compare: () => 1,
			in: () => 1,
			exists: () => 1,
			and: (parts) => parts.length,
			or: (parts) => parts.length,
			not: () => 1,
		})
		const start = Date.now()
		Effect.runSync(count(shared))
		assert.isBelow(Date.now() - start, 1000)
	})

	it("counts the values of a shared In test in the limit of a policy", () => {
		const Small = Domain.make({
			principal: Caller,
			resources: [Bot],
			limits: { policyNodes: 100_000 },
		})
		const values = Arr.makeBy(1000, (index) => `b${String(index)}`)
		const wide = Policy.define(Small)(function* (_) {
			yield* _.allow("read", Bot, { when: ($) => $.in("id", values) })
		})
		// Each copy counts its 1,000 values, so 200 copies are past the limit.
		assert.doesNotThrow(() => Policy.all(Arr.makeBy(50, () => wide) as never))
		assert.throws(
			() => Policy.all(Arr.makeBy(200, () => wide) as never),
			/The most is 100000/,
		)
	})

	it("tests many values of one In test in a short time", () => {
		const Counter = Resource.make("Counter", {
			actions: ["read"],
			fields: { x: Schema.Int },
		})
		const Counters = Domain.make({ principal: Caller, resources: [Counter] })
		// Each value counts as a node, so the test has as many as the limit
		// takes.
		const values = Array.from({ length: 90_000 }, (_, index) => index)
		const policy = Policy.define(Counters)(function* (_) {
			yield* _.allow("read", Counter, {
				when: ($) => $.or($.lt("x", 0), $.gte("x", 90_000), $.in("x", values)),
			})
		})
		const start = Date.now()
		Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "Counter",
		})
		assert.isBelow(Date.now() - start, 5000)
	})

	it("does not read a name below a union branch of any value", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				info: Schema.Union([
					Schema.Struct({ owner: Schema.Literal("public") }),
					Schema.Unknown,
				]),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		// A value of `Schema.Unknown` may be any object, so `info.owner` may be
		// a getter. A residual could leave the read out where a decision fails.
		assert.throws(
			() =>
				rulesOf(Notes, [
					Policy.rule({
						_tag: "Allow",
						actions: ["read"],
						resources: ["Note"],
						when: Condition.builder<
							{ readonly info: { readonly owner: string | null } },
							unknown,
							unknown
						>().in("info.owner", ["public", null]),
					}),
				]),
			/A condition may not read the field "info.owner"/,
		)
	})

	it("checks a deep tree with deep conditions without filling the stack", () => {
		const condition = Arr.reduce(
			Arr.range(1, 499),
			{ _tag: "Exists", field: "id" } as unknown,
			(inner) => ({ _tag: "And", conditions: [inner] }),
		)
		const json = Arr.reduce(
			Arr.range(1, 255),
			{
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Bot"],
						when: condition,
					},
				],
			} as unknown,
			(inner) => ({ _tag: "All", policies: [inner] }),
		)
		const policy = Schema.decodeUnknownSync(PolicySchemaOfApp)(json)
		const request = { principal: alice, action: "read", kind: "Bot" } as const
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
		assert.strictEqual(Policy.coverage(policy, request)._tag, "All")
		assert.strictEqual(Policy.residual(policy, request)._tag, "Exists")
		// The JSON texts are compared, not the objects: a deep compare of the
		// assert library would itself fill the stack on 1500 levels of objects.
		const text = JSON.stringify(json)
		assert.strictEqual(
			JSON.stringify(Schema.encodeSync(PolicySchemaOfApp)(policy)),
			text,
		)
		assert.strictEqual(JSON.stringify(policy), text)
		assert.strictEqual(
			JSON.stringify(Policy.provideContext(policy, Context.empty())),
			text,
		)
	})

	it("keeps one copy of each action and kind of a rule", () => {
		const kinds = Arr.makeBy(1000, (index) =>
			Resource.make(`Edited${String(index)}`, {
				actions: index === 0 ? ["read", "edit"] : ["read"],
				fields: { name: Schema.String },
			}),
		)
		const Edits = Domain.make({
			principal: Caller,
			resources: kinds,
			limits: { searchSteps: 1 },
		})
		const codec = Policy.schema(Edits)
		const start = Date.now()
		const policy = Schema.decodeSync(codec)({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: Arr.makeBy(1_000_000, () => "edit"),
					resources: [
						...Arr.map(kinds, (kind) => kind.kind),
						...Arr.map(kinds, (kind) => kind.kind),
					],
				},
			],
		})
		const decision = Policy.decideSync(policy, {
			principal: alice,
			action: "edit",
			resource: kinds[0]!.make({ name: "n" }),
		})
		assert.strictEqual(decision._tag, "Allow")
		// Each check read the million copies, which took about eleven seconds.
		assert.isBelow(Date.now() - start, 2000)
		const json = Schema.encodeSync(codec)(policy) as {
			readonly rules: ReadonlyArray<{
				readonly actions: ReadonlyArray<string>
				readonly resources: ReadonlyArray<string>
			}>
		}
		assert.deepStrictEqual(json.rules[0]!.actions, ["edit"])
		assert.strictEqual(json.rules[0]!.resources.length, 1000)
	})

	it("binds a rule with very many wrong kinds and actions in a short time", () => {
		const Small = Domain.make({
			principal: Caller,
			resources: [Bot],
			limits: { searchSteps: 1 },
		})
		const start = Date.now()
		const exit = Schema.decodeExit(Policy.schema(Small))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: Arr.makeBy(5000, (index) => `act${String(index)}`),
					resources: Arr.makeBy(5000, (index) => `Kind${String(index)}`),
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		// The key of the place of the suggestion for each action held every
		// kind, which took more than twenty seconds.
		assert.isBelow(Date.now() - start, 2000)
	})

	it("counts the work of the suggestions for wrong names", () => {
		const names = Arr.makeBy(
			1000,
			(index) => `${"x".repeat(58)}${String(index).padStart(6, "0")}`,
		)
		const Long = Resource.make("Long", {
			actions: ["read"],
			fields: Object.fromEntries(
				Arr.map(names, (name) => [name, Schema.String]),
			) as Record<string, typeof Schema.String>,
		})
		const Longs = Domain.make({
			principal: Caller,
			resources: [Long],
			limits: { searchSteps: 100 },
		})
		const start = Date.now()
		const exit = Schema.decodeUnknownExit(Policy.schema(Longs))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Long"],
					when: {
						_tag: "And",
						conditions: Arr.makeBy(32, (index) => ({
							_tag: "Exists",
							field: `${"x".repeat(57)}z${String(index).padStart(6, "0")}`,
						})),
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		// Each suggestion compared the name with 1000 long names, which took
		// about 17 seconds. Past the limit, an issue has no suggestion.
		assert.isBelow(Date.now() - start, 1000)
	})

	it("binds a policy with very many wrong names in a short time", () => {
		const Wide = Resource.make("Wide", {
			actions: ["read"],
			fields: Object.fromEntries(
				Array.from({ length: 1000 }, (_, index) => [
					`field${String(index)}`,
					Schema.String,
				]),
			),
		})
		const Wides = Domain.make({ principal: Caller, resources: [Wide] })
		const start = Date.now()
		const exit = Schema.decodeUnknownExit(Policy.schema(Wides))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Wide"],
					when: {
						_tag: "And",
						conditions: Array.from({ length: 10_000 }, (_, index) => ({
							_tag: "Exists",
							field: `notfound${String(index % 100)}`,
						})),
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.isBelow(Date.now() - start, 2000)
	})

	it("does not take a rule with a method when from its class", () => {
		class Shaped {
			when() {
				return { _tag: "False" }
			}
		}
		const rule = Object.assign(new Shaped(), {
			_tag: "Allow",
			actions: ["read"],
			resources: ["Bot"],
		})
		const exit = Schema.decodeUnknownExit(PolicySchemaOfApp)({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [rule],
		})
		// A rule with no condition would allow every read.
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"not plain data",
		)
	})

	it("does not take a rule that is a list of a subclass of Array", () => {
		class Shaped extends Array<unknown> {
			get when() {
				return { _tag: "False" }
			}
		}
		const rule = Object.assign(new Shaped(), {
			_tag: "Allow",
			actions: ["read"],
			resources: ["Bot"],
		})
		const exit = Schema.decodeUnknownExit(PolicySchemaOfApp)({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [rule],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"not plain data",
		)
	})

	it("does not take a condition or fields that a rule has from a class", () => {
		class Shaped {
			get when() {
				return { _tag: "False" }
			}
		}
		const rule = Object.assign(new Shaped(), {
			_tag: "Allow",
			actions: ["read"],
			resources: ["Bot"],
		})
		const exit = Schema.decodeUnknownExit(PolicySchemaOfApp)({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [rule],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"not plain data",
		)
	})

	it("does not take a fixed value that is missing", () => {
		const exit = Schema.decodeUnknownExit(PolicySchemaOfApp)({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					when: {
						_tag: "Compare",
						op: "eq",
						field: "ownerUserId",
						value: { _tag: "Literal" },
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"A fixed value is missing",
		)
	})

	it("does not take a predicate in a rule that Policy.rule makes", () => {
		const rule = Policy.builder(App).allow("read", Bot, {
			when: ($) => $.predicate("named", (bot) => bot.name !== ""),
		})
		assert.throws(
			() => Policy.rule({ ...rule, resources: ["Trigger"] } as never),
			/no condition with a predicate/,
		)
	})

	it("keeps at most 100 problems of a deep and wide condition", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { id: Schema.String },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const wide = {
			_tag: "And",
			conditions: Array.from({ length: 99_000 }, () => ({
				_tag: "Exists",
				field: "bad",
			})),
		}
		const when = Arr.reduce(Arr.range(1, 480), wide as unknown, (inner) => ({
			_tag: "And",
			conditions: [inner],
		}))
		const result = Schema.decodeUnknownResult(Policy.schema(Notes))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [{ _tag: "Allow", actions: ["read"], resources: ["Note"], when }],
		})
		assert.isTrue(Result.isFailure(result))
		const text = String(Result.isFailure(result) ? result.failure : "")
		assert.include(text, "The first 100 are here")
	})

	it("stops the check of very many field patterns", () => {
		const Wide = Resource.make("Wide", {
			actions: ["read"],
			fields: Object.fromEntries(
				Array.from({ length: 1000 }, (_, index) => [
					`field${String(index)}`,
					Schema.String,
				]),
			),
		})
		const Wides = Domain.make({ principal: Caller, resources: [Wide] })
		const start = Date.now()
		const result = Schema.decodeResult(Policy.schema(Wides))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Wide"],
					fields: Array.from(
						{ length: 250_000 },
						(_, index) => `missing${String(index)}*`,
					),
				},
			],
		})
		assert.isTrue(Result.isFailure(result))
		assert.include(
			String(Result.isFailure(result) ? result.failure : ""),
			"steps to check",
		)
		assert.isBelow(Date.now() - start, 3000)
	})

	describe("the work of field patterns on a whole value", () => {
		const fieldsNamed = (prefix: string, length: number) =>
			Object.fromEntries(
				Array.from({ length }, (_, index) => [
					`${prefix}${String(index)}`,
					Schema.String,
				]),
			)
		const Narrow = Resource.make("Narrow", {
			actions: ["read"],
			fields: fieldsNamed("match", 600),
		})
		const Wide = Resource.make("Wide", {
			actions: ["read"],
			fields: fieldsNamed("other", 2000),
		})
		const Kinds = Domain.make({
			principal: Caller,
			resources: [Narrow, Wide],
		})
		const load = (fields: ReadonlyArray<string>) =>
			Schema.decodeResult(Policy.schema(Kinds))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Narrow", "Wide"],
						fields,
					},
				],
			})

		it("checks one pattern one time in a decision", () => {
			const result = load(Array.from({ length: 20_000 }, () => "match*"))
			assert.isTrue(Result.isSuccess(result))
			if (Result.isFailure(result)) {
				return
			}
			const resource = Wide.make(
				Object.fromEntries(
					Array.from({ length: 2000 }, (_, index) => [
						`other${String(index)}`,
						"a",
					]),
				) as never,
			)
			const start = Date.now()
			assert.strictEqual(
				Policy.decideSync(result.success, {
					principal: alice,
					action: "read",
					resource,
				})._tag,
				"NotApplicable",
			)
			assert.isBelow(Date.now() - start, 1000)
		})

		it("counts the work of a pattern on every kind of the rule", () => {
			// Each pattern fits the first kind. The check on the second kind,
			// which a decision does too, takes the work past the limit.
			const result = load(
				Array.from({ length: 600 }, (_, index) => `match${String(index)}*`),
			)
			assert.isTrue(Result.isFailure(result))
			assert.include(
				String(Result.isFailure(result) ? result.failure : ""),
				"steps to check",
			)
		})
	})

	it("binds a rule that names very many kinds in a short time", () => {
		const start = Date.now()
		const result = Schema.decodeResult(Policy.schema(App))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: Arr.makeBy(50_000, (index) => `Kind${String(index)}`),
				},
			],
		})
		assert.isTrue(Result.isFailure(result))
		assert.include(
			String(Result.isFailure(result) ? result.failure : ""),
			'There is no resource with the kind "Kind0"',
		)
		assert.isBelow(Date.now() - start, 3000)
	})

	it("counts the work of Under tests on very many kinds", () => {
		const kinds = Arr.makeBy(1000, (index) =>
			Resource.make(`PathKind${String(index)}`, {
				actions: ["read"],
				fields: { key: Schema.String },
				path: (f) => [f.key],
			}),
		)
		const Keyed = Schema.Struct({ key: Schema.String })
		const Kinds = Domain.make({
			principal: Keyed,
			resources: kinds,
			limits: { searchSteps: 100_000 },
		})
		const start = Date.now()
		const result = Schema.decodeUnknownResult(Policy.schema(Kinds))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["*"],
					when: {
						_tag: "And",
						conditions: Arr.makeBy(10_000, () => ({
							_tag: "Under",
							prefix: [{ _tag: "Principal", path: "key" }],
						})),
					},
				},
			],
		})
		assert.isTrue(Result.isFailure(result))
		assert.include(
			String(Result.isFailure(result) ? result.failure : ""),
			"steps to check",
		)
		assert.isBelow(Date.now() - start, 2000)
	})

	it("takes a key of a record in a union as any value when another record has other keys", () => {
		const Flags = Resource.make("Flags", {
			actions: ["read"],
			fields: {
				data: Schema.Union([
					Schema.Record(
						Schema.TemplateLiteral(["x", Schema.String]),
						Schema.Boolean,
					),
					Schema.Record(
						Schema.TemplateLiteral(["y", Schema.String]),
						Schema.Boolean,
					),
				]),
			},
		})
		const FlagDomain = Domain.make({ principal: Caller, resources: [Flags] })
		// A value as `{ data: { y1: false, x1: "secret" } }` fits the second
		// record, and `x1` is an extra key of it.
		const exit = Schema.decodeExit(Policy.schema(FlagDomain))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{ _tag: "Allow", actions: ["read"], resources: ["Flags"] },
				{
					_tag: "Deny",
					actions: ["read"],
					resources: ["Flags"],
					when: {
						_tag: "Not",
						condition: {
							_tag: "In",
							field: "data.x1",
							values: [
								{ _tag: "Literal", value: true },
								{ _tag: "Literal", value: false },
								{ _tag: "Literal", value: null },
							],
						},
					},
				},
			],
		})
		// A key that may hold any value may hold a value that is not plain
		// data, so a test of it does not bind, as for an extra field of a
		// struct. It must never bind with the kinds of only one record.
		assert.isTrue(Exit.isFailure(exit))
		assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "data.x1")
	})

	it("checks each pair of a kind and a field pattern on its own", () => {
		const Marked = Resource.make("A\u0000x", {
			actions: ["read"],
			fields: { ok: Schema.String },
		})
		const Plain = Resource.make("A", {
			actions: ["read"],
			fields: { ok: Schema.String },
		})
		const Both = Domain.make({ principal: Caller, resources: [Marked, Plain] })
		const decode = Schema.decodeUnknownExit(Policy.schema(Both))
		const rule = (kind: string, pattern: string) => ({
			_tag: "Allow",
			actions: ["read"],
			resources: [kind],
			fields: [pattern],
		})
		const wrong = rule("A", "x\u0000*")
		const rules = (list: ReadonlyArray<unknown>) =>
			decode({ _tag: "Rules", algorithm: "denyOverrides", rules: list })
		// The pattern of the second rule matches no field of "A". A key of the
		// kind and the pattern joined with a mark was the key of the first rule.
		assert.isTrue(Exit.isFailure(rules([wrong])))
		assert.isTrue(Exit.isFailure(rules([rule("A\u0000x", "*"), wrong])))
	})

	it("puts the limit of the work of the checks on a tree of policies", () => {
		const Small = Domain.make({
			principal: Caller,
			resources: [Bot],
			limits: { searchSteps: 2 },
		})
		const one = Policy.define(Small)(function* (_) {
			yield* _.allow("read", Bot, { when: ($) => $.eq("id", "one") })
		})
		const codec = Policy.schema(Small)
		// A part that the Schema takes alone.
		assert.isTrue(Exit.isSuccess(Schema.encodeExit(codec)(one)))
		// The tree has the work of both parts, so it is past the limit.
		assert.throws(() => Policy.all([one, one]), /steps to check/)
		assert.throws(() => Policy.ceiling(one, one), /steps to check/)
		const alone = Schema.encodeSync(codec)(one)
		assert.isTrue(
			Exit.isFailure(
				Schema.decodeExit(codec)({
					_tag: "All",
					policies: [alone, alone],
				}),
			),
		)
		// A tree that is made is a tree that the Schema takes.
		const Wide = Domain.make({
			principal: Caller,
			resources: [Bot],
			limits: { searchSteps: 4 },
		})
		const part = Policy.define(Wide)(function* (_) {
			yield* _.allow("read", Bot, { when: ($) => $.eq("id", "one") })
		})
		const tree = Policy.all([part, part])
		const json = Schema.encodeSync(Policy.schema(Wide))(tree)
		assert.isTrue(Exit.isSuccess(Schema.decodeExit(Policy.schema(Wide))(json)))
	})

	it("checks the values of a test one time for kinds with one field type", () => {
		const kinds = Arr.makeBy(1000, (index) =>
			Resource.make(`Kind${String(index)}`, {
				actions: ["read"],
				fields: { name: Schema.String },
			}),
		)
		const Kinds = Domain.make({ principal: Caller, resources: kinds })
		const start = Date.now()
		const result = Schema.decodeUnknownResult(Policy.schema(Kinds))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: Arr.map(kinds, (kind) => kind.kind),
					when: {
						_tag: "In",
						field: "name",
						values: Arr.makeBy(90_000, (index) => ({
							_tag: "Literal",
							value: `n${String(index)}`,
						})),
					},
				},
			],
		})
		assert.isTrue(Result.isSuccess(result))
		assert.isBelow(Date.now() - start, 3000)
	})

	it("checks a pattern with many stars on a recursive Schema in a short time", () => {
		interface Tree {
			readonly a: Tree | null
			readonly b: Tree | null
		}
		const Tree: Schema.Codec<Tree> = Schema.Struct({
			a: Schema.NullOr(Schema.suspend((): Schema.Codec<Tree> => Tree)),
			b: Schema.NullOr(Schema.suspend((): Schema.Codec<Tree> => Tree)),
		})
		const Forest = Resource.make("Forest", {
			actions: ["read"],
			fields: { root: Tree },
		})
		const Forests = Domain.make({ principal: Caller, resources: [Forest] })
		const start = Date.now()
		const result = Schema.decodeResult(Policy.schema(Forests))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Forest"],
					// A set of the places of the match for each place of the
					// catalog has very many forms here. One place of the match
					// at a time has few.
					fields: [
						["**", "a", ...Arr.makeBy(18, () => "*"), "missing"].join("."),
					],
				},
			],
		})
		assert.isTrue(Result.isFailure(result))
		assert.include(
			String(Result.isFailure(result) ? result.failure : ""),
			"matches no field",
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("binds a very long wrong name in a short time", () => {
		const Wide = Resource.make("Wide", {
			actions: ["read"],
			fields: Object.fromEntries(
				Array.from({ length: 1000 }, (_, index) => [
					`field${String(index)}`,
					Schema.String,
				]),
			),
		})
		const Wides = Domain.make({ principal: Caller, resources: [Wide] })
		const start = Date.now()
		const exit = Schema.decodeExit(Policy.schema(Wides))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Wide"],
					when: { _tag: "Exists", field: "x".repeat(100_000) },
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.isBelow(Date.now() - start, 1000)
	})

	it("keeps a Date in meta through the JSON text of a policy", () => {
		const Dated = Domain.make({
			principal: Caller,
			resources: [Bot],
			meta: Schema.Struct({ expiresAt: Schema.Date }),
		})
		const policy = Policy.define(Dated)(function* (_) {
			yield* _.allow("read", Bot, {
				meta: { expiresAt: new Date("2030-01-01T00:00:00.000Z") },
			})
		})
		const DatedSchema = Policy.schema(Dated)
		const fromJson = (text: string) =>
			Schema.decodeUnknownSync(DatedSchema)(JSON.parse(text))
		assert.isTrue(
			Equal.equals(
				fromJson(JSON.stringify(Schema.encodeSync(DatedSchema)(policy))),
				policy,
			),
		)
		assert.isTrue(Equal.equals(fromJson(JSON.stringify(policy)), policy))
	})

	it.effect("decodes and encodes a meta Schema with an async step", () =>
		Effect.gen(function* () {
			const Later = Schema.String.pipe(
				Schema.decodeTo(
					Schema.String,
					SchemaTransformation.transformEffect({
						decode: (value: string) =>
							Effect.promise(() => Promise.resolve(value)),
						encode: (value: string) =>
							Effect.promise(() => Promise.resolve(value)),
					}),
				),
			)
			const Metas = Domain.make({
				principal: Caller,
				resources: [Bot],
				meta: Later,
			})
			const json = {
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Bot"],
						meta: "once",
					},
				],
			}
			const policy = yield* Schema.decodeUnknownEffect(Policy.schema(Metas))(
				json,
			)
			const again: unknown = yield* Schema.encodeEffect(Policy.schema(Metas))(
				policy,
			)
			assert.deepStrictEqual(again, json)
		}),
	)

	it("does not take a meta with a field that a loop does not see", () => {
		const Listed = Domain.make({
			principal: Caller,
			resources: [Bot],
			meta: Schema.Struct({ entries: Schema.Array(Schema.String) }),
			limits: { jsonNodes: 10 },
		})
		const decode = Schema.decodeUnknownExit(Policy.schema(Listed))
		const rule = (meta: object) => ({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [{ _tag: "Allow", actions: ["read"], resources: ["Bot"], meta }],
		})
		const entries = Arr.makeBy(1000, (index) => String(index))
		// The walk that counts the input does not see a hidden field, but the
		// Schema of the meta reads it.
		const hidden = decode(
			rule(Object.defineProperty({}, "entries", { value: entries })),
		)
		assert.isTrue(Exit.isFailure(hidden))
		assert.include(
			String(Exit.isFailure(hidden) ? hidden.cause : ""),
			"not plain data",
		)
		assert.isTrue(Exit.isFailure(decode(rule({ entries }))))
	})

	it("stops a sparse array in meta at once", () => {
		const Metas = Domain.make({
			principal: Caller,
			resources: [Bot],
			meta: Schema.Unknown,
		})
		const start = Date.now()
		const exit = Schema.decodeExit(Policy.schema(Metas))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					meta: new Array(0xffffffff),
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.isBelow(Date.now() - start, 100)
	})

	it("fails, and does not die, on a meta too deep for its Schema", () => {
		interface Meta {
			readonly next: Meta | null
		}
		const Meta: Schema.Codec<Meta | null> = Schema.suspend(
			(): Schema.Codec<Meta | null> =>
				Schema.NullOr(Schema.Struct({ next: Meta })),
		)
		const Metas = Domain.make({
			principal: Caller,
			resources: [Bot],
			meta: Meta,
		})
		const meta = Arr.reduce(
			Arr.range(1, 5000),
			null as Meta | null,
			(next): Meta => ({ next }),
		)
		const exit = Schema.decodeExit(Policy.schema(Metas))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [{ _tag: "Allow", actions: ["read"], resources: ["Bot"], meta }],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.isFalse(Exit.hasDies(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"too many levels for the Schema of meta",
		)
	})

	it("counts the meta of a rule in the budget of a decode", () => {
		const Metas = Domain.make({
			principal: Caller,
			resources: [Bot],
			meta: Schema.Array(Schema.Finite),
			limits: { jsonNodes: 1_000_000 },
		})
		const exit = Schema.decodeExit(Policy.schema(Metas))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					meta: Array.from({ length: 1_000_001 }, () => 1),
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"The most is 1000000",
		)
	})

	it("does not read a name that a struct of a union does not have", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				info: Schema.Union([
					Schema.Struct({ owner: Schema.Literal("public") }),
					Schema.Struct({ other: Schema.String }),
				]),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		// A value made by hand, as `{ info: { other: "x", owner: [] } }`, fits
		// the second struct, and its `owner` may be any value.
		assert.throws(
			() =>
				rulesOf(Notes, [
					Policy.builder(Notes).allow("read", Note),
					Policy.rule({
						_tag: "Deny",
						actions: ["read"],
						resources: ["Note"],
						when: Condition.builder<
							{ readonly info: { readonly owner: string } },
							unknown,
							unknown
						>().eq("info.owner", "secret"),
					}),
				]),
			/A condition may not read the field "info.owner"/,
		)
	})

	it("does not read a name of Object.prototype that a class gives another value", () => {
		class Info {
			get toString() {
				return "x"
			}
		}
		const $ = Condition.builder<
			{ readonly info: { readonly toString: string } },
			unknown,
			unknown
		>()
		assert.throws(
			() =>
				Condition.evaluateSync($.exists("info.toString"), {
					value: { info: new Info() },
				}),
			/not plain data/,
		)
		assert.isFalse(
			Condition.evaluateSync($.exists("info.toString"), {
				value: { info: {} },
			}),
		)
		assert.isFalse(
			Condition.evaluateSync(
				Condition.builder<
					{ readonly info: { readonly __proto__: string | null } },
					unknown,
					unknown
				>().exists("info.__proto__"),
				{ value: { info: {} } },
			),
		)
	})

	it("knows the values of a key of a record", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { info: Schema.Record(Schema.String, Schema.Boolean) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const $ = Condition.builder<
			{ readonly info: { readonly [key: string]: boolean } },
			unknown,
			unknown
		>()
		const policy = rulesOf(Notes, [
			Policy.builder(Notes).allow("read", Note),
			Policy.rule({
				_tag: "Deny",
				actions: ["read"],
				resources: ["Note"],
				when: $.and(
					$.exists("info.key"),
					$.ne("info.key", true),
					$.ne("info.key", false),
				),
			}),
		])
		// A key holds a boolean, or it is missing. So the deny rule never
		// applies.
		assert.strictEqual(
			Policy.coverage(policy, {
				principal: alice,
				action: "read",
				kind: "Note",
			})._tag,
			"All",
		)
	})

	it("does not take a principal field that comes from a getter of its class", () => {
		class Member extends Schema.Class<Member>("Member")({
			id: Schema.String,
		}) {
			get ownerId() {
				return this.id
			}
		}
		const Members = Domain.make({ principal: Member, resources: [Bot] })
		assert.throws(
			() =>
				Policy.define(Members)(function* (_) {
					yield* _.allow("read", Bot, {
						when: ($) => $.eq("ownerUserId", $.principal("ownerId")),
					})
				}),
			/The principal has no field "ownerId"/,
		)
	})

	it("does not take a getter of a class in the values of a record", () => {
		class Owner extends Schema.Class<Owner>("Owner")({
			id: Schema.String,
		}) {
			get name() {
				return this.id
			}
		}
		const Team = Resource.make("Team", {
			actions: ["read"],
			fields: { users: Schema.Record(Schema.String, Owner) },
		})
		const Teams = Domain.make({ principal: Caller, resources: [Team] })
		assert.throws(
			() =>
				Policy.define(Teams)(function* (_) {
					yield* _.allow("read", Team, {
						when: ($) => $.eq("users.owner.name", "admin"),
					})
				}),
			/is not a field of every resource of the rule/,
		)
	})

	it("does not grant fields that the kind does not have", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", "*", { fields: ["settings.*"] })
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceTrigger,
			})._tag,
			"NotApplicable",
		)
		assert.strictEqual(
			Policy.coverage(policy, {
				principal: alice,
				action: "read",
				kind: "Trigger",
			})._tag,
			"None",
		)
	})

	it("does not take a test with a value of another type than its field", () => {
		assert.throws(
			() =>
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot)
					yield* _.deny("read", Bot, {
						when: ($) => $.eq("level", "3" as never),
					})
				}),
			/can not hold the value "3"/,
		)
		// A spread of a node is a plain object, not a node.
		assert.throws(
			() =>
				Policy.define(App)(function* (_) {
					yield* _.deny("read", Bot, {
						when: ($) =>
							({
								...$.eq("level", 3),
								value: { _tag: "Literal", value: "3" } as const,
							}) as never,
					})
				}),
			/not a whole condition tree/,
		)
	})

	it("does not take a test with a fixed value of undefined", () => {
		const ids: Record<string, string> = {}
		assert.throws(
			() =>
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot, {
						when: ($) =>
							$.not($.eq("ownerUserId", ids["owner"] as unknown as string)),
					})
				}),
			/An operand must be a fixed scalar value/,
		)
	})

	it("does not take a test with a principal field of another type", () => {
		assert.throws(
			() =>
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot)
					yield* _.deny("read", Bot, {
						when: ($) => $.eq("level", $.principal("userId") as never),
					})
				}),
			/can not hold a value of the principal field "userId"/,
		)
	})

	it("does not take a test that can never match by its types", () => {
		class Person extends Schema.Class<Person>("Person")({
			score: Schema.NullOr(Schema.Finite),
		}) {}
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { label: Schema.NullOr(Schema.String), when: Schema.Date },
		})
		const Notes = Domain.make({ principal: Person, resources: [Note] })
		const decode = (when: unknown) =>
			Schema.decodeUnknownExit(Policy.schema(Notes))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [{ _tag: "Deny", actions: ["read"], resources: ["Note"], when }],
			})
		assert.isTrue(
			Exit.isFailure(
				decode({
					_tag: "Compare",
					op: "eq",
					field: "label",
					value: { _tag: "Principal", path: "score" },
				}),
			),
		)
		assert.isTrue(
			Exit.isFailure(
				decode({
					_tag: "Compare",
					op: "eq",
					field: "when",
					value: { _tag: "Literal", value: "2020-01-01T00:00:00.000Z" },
				}),
			),
		)
		assert.isTrue(
			Exit.isSuccess(
				decode({
					_tag: "Compare",
					op: "eq",
					field: "label",
					value: { _tag: "Literal", value: null },
				}),
			),
		)
	})

	it("needs one ordered type for an ordered test with a principal field", () => {
		class Scored extends Schema.Class<Scored>("Scored")({
			score: Schema.Union([Schema.Finite, Schema.Boolean]),
		}) {}
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { label: Schema.Union([Schema.String, Schema.Boolean]) },
		})
		const Notes = Domain.make({ principal: Scored, resources: [Note] })
		const exit = Schema.decodeExit(Policy.schema(Notes))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Deny",
					actions: ["read"],
					resources: ["Note"],
					when: {
						_tag: "Compare",
						op: "gt",
						field: "label",
						value: { _tag: "Principal", path: "score" },
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
	})

	it("keeps the fields of a resource as they were when it was made", () => {
		const fields: Record<string, Schema.Top> = { blocked: Schema.Boolean }
		const Note = Resource.make("Note", { actions: ["read"], fields })
		fields["blocked"] = Schema.Literal(false)
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = rulesOf(Notes, [
			Policy.rule({
				_tag: "Allow",
				actions: ["read"],
				resources: ["Note"],
				when: Condition.builder<
					{ readonly blocked: boolean },
					unknown,
					unknown
				>().eq("blocked", false) as Condition.Condition,
			}),
		])
		assert.notStrictEqual(
			Policy.coverage(policy, {
				principal: alice,
				action: "read",
				kind: "Note",
			})._tag,
			"All",
		)
	})

	it("does not take an ordered test on a value with no order", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { locked: Schema.Boolean, name: Schema.String },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const decode = (field: string, value: unknown) =>
			Schema.decodeUnknownExit(Policy.schema(Notes))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Deny",
						actions: ["read"],
						resources: ["Note"],
						when: {
							_tag: "Compare",
							op: "gt",
							field,
							value: { _tag: "Literal", value },
						},
					},
				],
			})
		assert.isTrue(Exit.isFailure(decode("locked", false)))
		assert.isTrue(Exit.isFailure(decode("name", null)))
		assert.isTrue(Exit.isSuccess(decode("name", "a")))
	})

	it("does not take a path with a hole", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { id: Schema.String },
			path: () => new Array<string>(1),
		})
		assert.throws(
			() => Domain.make({ principal: Caller, resources: [Note] }),
			/not a string or a field/,
		)
	})

	it("compares a principal field that is not a finite number", () => {
		class Limited extends Schema.Class<Limited>("Limited")({
			// The test needs Infinity in this field.
			// @effect-diagnostics-next-line schemaNumber:off
			limit: Schema.Number,
		}) {}
		const Limits = Domain.make({ principal: Limited, resources: [Bot] })
		const policy = Policy.define(Limits)(function* (_) {
			yield* _.allow("read", Bot)
			yield* _.deny("read", Bot, {
				when: ($) => $.lt("level", $.principal("limit")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: Limited.make({ limit: Infinity }),
				action: "read",
				resource: aliceBot,
			})._tag,
			"Deny",
		)
	})

	it("does not take a path test with a principal field that is an object", () => {
		class Member extends Schema.Class<Member>("Member")({
			group: Schema.Struct({ name: Schema.String }),
		}) {}
		const Members = Domain.make({ principal: Member, resources: [Bot] })
		const decode = (path: string) =>
			Schema.decodeExit(Policy.schema(Members))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Deny",
						actions: ["read"],
						resources: ["Bot"],
						when: {
							_tag: "Under",
							prefix: [
								{ _tag: "Literal", value: "org" },
								{ _tag: "Principal", path },
							],
						},
					},
				],
			})
		assert.isTrue(Exit.isFailure(decode("group")))
		assert.isTrue(Exit.isSuccess(decode("group.name")))
		const wildcard = Schema.decodeExit(Policy.schema(Members))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Deny",
					actions: ["read"],
					resources: ["*"],
					when: {
						_tag: "Under",
						prefix: [
							{ _tag: "Literal", value: "org" },
							{ _tag: "Principal", path: "group" },
						],
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(wildcard))
	})

	it("checks a path test of a rule for every resource only on kinds of its actions", () => {
		const Doc = Resource.make("Doc", {
			actions: ["read"],
			fields: { owner: Schema.String },
			path: (f) => ["user", f.owner],
		})
		const Counter = Resource.make("Counter", {
			actions: ["write"],
			fields: { count: Schema.Finite },
			path: (f) => ["seq", f.count],
		})
		class User extends Schema.Class<User>("PathUser")({
			id: Schema.String,
		}) {}
		const Docs = Domain.make({ principal: User, resources: [Doc, Counter] })
		const policy = Policy.define(Docs)(function* (_) {
			yield* _.allow("read", "*", {
				when: ($) => $.under("user", $.principal("id")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: User.make({ id: "a" }),
				action: "read",
				resource: Doc.make({ owner: "a" }),
			})._tag,
			"Allow",
		)
	})

	it("checks a path test of a rule for named kinds only on kinds of its actions", () => {
		const Reader = Resource.make("Reader", {
			actions: ["read"],
			fields: { id: Schema.String },
			path: () => ["org"],
		})
		const Writer = Resource.make("Writer", {
			actions: ["write"],
			fields: { id: Schema.String },
			path: () => ["team"],
		})
		class Scoped extends Schema.Class<Scoped>("ScopedUser")({
			scope: Schema.Literal("org"),
		}) {}
		const Both = Domain.make({ principal: Scoped, resources: [Reader, Writer] })
		const policy = Policy.define(Both)(function* (_) {
			yield* _.allow("read", [Reader, Writer], {
				when: ($) => $.under($.principal("scope")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: Scoped.make({ scope: "org" }),
				action: "read",
				resource: Reader.make({ id: "r" }),
			})._tag,
			"Allow",
		)
	})

	it("checks a path test only on kinds whose path may start with its strings", () => {
		const Doc = Resource.make("Doc", {
			actions: ["read"],
			fields: { owner: Schema.String },
			path: (f) => ["user", f.owner],
		})
		const Invoice = Resource.make("Invoice", {
			actions: ["read"],
			fields: { number: Schema.Int },
			path: (f) => ["invoice", f.number],
		})
		class User extends Schema.Class<User>("InvoiceUser")({
			id: Schema.String,
		}) {}
		const Docs = Domain.make({ principal: User, resources: [Doc, Invoice] })
		const policy = Policy.define(Docs)(function* (_) {
			yield* _.allow("read", "*", {
				when: ($) => $.under("user", $.principal("id")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: User.make({ id: "a" }),
				action: "read",
				resource: Doc.make({ owner: "a" }),
			})._tag,
			"Allow",
		)
	})

	it("explains a shared tree in a short time", () =>
		Effect.gen(function* () {
			const shared = Arr.reduce(
				Arr.range(1, 12),
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot)
				}) as Policy.Policy<typeof App>,
				(policy) => Policy.all([policy, policy]),
			)
			const start = Date.now()
			const explained = yield* Policy.explain(shared, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})
			assert.strictEqual(explained.decision._tag, "Allow")
			// A shared node is in the steps each time that the decision comes
			// to it.
			assert.strictEqual(explained.steps.length, 2 ** 12)
			assert.isBelow(Date.now() - start, 1000)
		}).pipe(Effect.runSync))

	it("does not make a shared condition that would be too large", () => {
		const start = Date.now()
		assert.throws(
			() =>
				Arr.reduce(
					Arr.range(1, 30),
					Condition.always as Condition.Condition,
					(condition) => Condition.and(condition, condition),
				),
			/The most is 100000/,
		)
		assert.isBelow(Date.now() - start, 100)
	})

	it("matches a key of a record by its Schema, and any key by a star", () => {
		const Store = Resource.make("KeyStore", {
			actions: ["read"],
			fields: {
				entries: Schema.Record(
					Schema.TemplateLiteral(["x", Schema.String]),
					Schema.String,
				),
			},
		})
		const Stores = Domain.make({ principal: Caller, resources: [Store] })
		const decide = (pattern: string) =>
			Policy.decideSync(
				Policy.define(Stores)(function* (_) {
					// The pattern comes from a test case, as from JSON.
					yield* _.allow("read", Store, { fields: [pattern as never] })
				}),
				{
					principal: alice,
					action: "read",
					resource: Store.make({ entries: {} }),
				},
			)._tag
		assert.strictEqual(decide("entries.*"), "Allow")
		// A part with a star matches any key. It is not tested against the
		// Schema of the keys.
		assert.strictEqual(decide("entries.y*"), "Allow")
		assert.strictEqual(decide("entries.x1"), "Allow")
		assert.throws(
			() => decide("entries.y1"),
			/is not a field of every resource/,
		)
	})

	it("checks a path test only on kinds whose path may have its whole prefix", () => {
		const Post = Resource.make("Post", {
			actions: ["read"],
			fields: { id: Schema.String },
			path: (f) => ["item", f.id, "post"],
		})
		const Other = Resource.make("Other", {
			actions: ["read"],
			fields: { id: Schema.Finite },
			path: (f) => ["item", f.id, "other"],
		})
		class User extends Schema.Class<User>("PrefixUser")({
			id: Schema.String,
		}) {}
		const Items = Domain.make({ principal: User, resources: [Post, Other] })
		const policy = Policy.define(Items)(function* (_) {
			yield* _.allow("read", "*", {
				when: ($) => $.under("item", $.principal("id"), "post"),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: User.make({ id: "a" }),
				action: "read",
				resource: Post.make({ id: "a" }),
			})._tag,
			"Allow",
		)
	})

	it("takes a ** only as a whole part, and never a getter", () => {
		class Owner extends Schema.Class<Owner>("PatternOwner")({
			id: Schema.String,
		}) {
			get label() {
				return this.id
			}
		}
		const Box = Resource.make("PatternBox", {
			actions: ["read"],
			fields: {
				data: Schema.Record(
					Schema.String,
					Schema.Struct({ value: Schema.String }),
				),
				values: Schema.Record(Schema.Finite, Schema.String),
				owner: Owner,
			},
		})
		const Boxes = Domain.make({ principal: Caller, resources: [Box] })
		const decide = (pattern: string) =>
			Policy.decideSync(
				Policy.define(Boxes)(function* (_) {
					yield* _.allow("read", Box, { fields: [pattern as never] })
				}),
				{
					principal: alice,
					action: "read",
					resource: Box.make({
						data: {},
						values: {},
						owner: Owner.make({ id: "o" }),
					}),
				},
			)._tag
		assert.throws(() => decide("data.**value"), /"\*\*" inside a part/)
		assert.strictEqual(decide("data.**.value"), "Allow")
		// A key of the record may have the name "missing".
		assert.strictEqual(decide("data.**.missing"), "Allow")
		assert.throws(() => decide("data.*.missing"), /matches no field/)
		assert.strictEqual(decide("values.*"), "Allow")
		assert.throws(() => decide("owner.label*"), /matches no field/)
		assert.throws(() => decide("owner.name*"), /matches no field/)
		assert.isTrue(hasField(Box, "values.1"))
	})

	it("does not take a fixed value in a path test that the path can not hold", () => {
		const Tenant = Resource.make("Tenant", {
			actions: ["read"],
			fields: { tenantId: Schema.String },
			path: (f) => ["tenant", f.tenantId],
		})
		const Tenants = Domain.make({ principal: Caller, resources: [Tenant] })
		const decode = (value: unknown) =>
			Schema.decodeUnknownExit(Policy.schema(Tenants))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Deny",
						actions: ["read"],
						resources: ["Tenant"],
						when: {
							_tag: "Under",
							prefix: [
								{ _tag: "Literal", value: "tenant" },
								{ _tag: "Literal", value },
							],
						},
					},
				],
			})
		assert.isTrue(Exit.isFailure(decode(123)))
		assert.isTrue(Exit.isSuccess(decode("123")))
	})

	it("does not take a pattern with very many parts", () => {
		const start = Date.now()
		assert.throws(
			() =>
				rulesOf(App, [
					Policy.rule({
						_tag: "Allow",
						actions: ["read"],
						resources: ["Bot"],
						fields: [`${"a*b.".repeat(8000)}*`],
					}),
				]),
			/more than 1000 parts/,
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("does not take a getter of a class with an annotation, a check or a suspend", () => {
		class Owner extends Schema.Class<Owner>("WrappedOwner")({
			id: Schema.String,
		}) {
			get label() {
				return this.id
			}
		}
		const Note = Resource.make("WrappedNote", {
			actions: ["read"],
			fields: {
				annotated: Owner.annotate({ description: "Owner" }),
				checked: Owner.check(Schema.makeFilter(() => true)),
				suspended: Schema.suspend(() => Owner),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const owner = Owner.make({ id: "a" })
		// The data fields of the class are fields through each wrapper.
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note, {
				when: ($) =>
					$.and(
						$.eq("annotated.id", "a"),
						$.eq("checked.id", "a"),
						$.eq("suspended.id", "a"),
					),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({
					annotated: owner,
					checked: owner,
					suspended: owner,
				}),
			})._tag,
			"Allow",
		)
		assert.throws(
			() =>
				Policy.define(Notes)(function* (_) {
					yield* _.allow("read", Note, {
						when: ($) => $.eq("annotated.label", "a"),
					})
				}),
			/is not a field of every resource of the rule/,
		)
	})

	it("does not read a field that a class in a union does not have", () => {
		class Owner extends Schema.Class<Owner>("UnionOwner")({
			id: Schema.String,
		}) {
			get flag(): string {
				throw new globalThis.Error("no")
			}
		}
		const Box = Resource.make("UnionBox", {
			actions: ["read"],
			fields: {
				box: Schema.Union([Owner, Schema.Struct({ flag: Schema.String })]),
			},
		})
		const Boxes = Domain.make({ principal: Caller, resources: [Box] })
		// The types see the getter as a field, but the Schema of the class has
		// no field `flag`.
		assert.throws(
			() =>
				Policy.define(Boxes)(function* (_) {
					yield* _.allow("read", Box, {
						when: ($) => $.eq("box.flag", "yes"),
					})
				}),
			/A condition may not read the field "box.flag"/,
		)
		// A deny rule in another policy may not read it either, also where the
		// residual would not need it.
		assert.throws(() =>
			Policy.any([
				Policy.define(Boxes)(function* (_) {
					yield* _.deny("read", Box, {
						when: ($) => $.eq("box.flag", "closed"),
					})
				}),
				Policy.define(Boxes)(function* (_) {
					yield* _.allow("read", Box)
				}),
			]),
		)
		// A rule that does not read the field still works on a class value.
		const policy = Policy.define(Boxes)(function* (_) {
			yield* _.allow("read", Box)
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Box.make({ box: Owner.make({ id: "o" }) }),
			})._tag,
			"Allow",
		)
	})

	it("does not read below a field that may hold a list or a date", () => {
		const Item = Resource.make("MixedItem", {
			actions: ["read"],
			fields: {
				dated: Schema.Union([
					Schema.Date,
					Schema.Struct({ flag: Schema.String }),
				]),
			},
		})
		const Items = Domain.make({ principal: Caller, resources: [Item] })
		const load = (rule: unknown) =>
			Schema.decodeUnknownResult(Policy.schema(Items))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [rule],
			})
		const read = load({
			_tag: "Allow",
			actions: ["read"],
			resources: ["MixedItem"],
			when: { _tag: "Exists", field: "dated.flag" },
		})
		assert.isTrue(Result.isFailure(read))
		assert.include(
			String(Result.isFailure(read) ? read.failure : ""),
			'A condition may not read the field "dated.flag"',
		)
		// A rule may still name the field, since it does not read it.
		assert.isTrue(
			Result.isSuccess(
				load({
					_tag: "Deny",
					actions: ["read"],
					resources: ["MixedItem"],
					fields: ["dated.flag"],
				}),
			),
		)
	})

	it("does not read a field of the principal that a class in a union does not have", () => {
		class Guest extends Schema.Class<Guest>("GetterGuest")({
			id: Schema.String,
		}) {
			get role(): string {
				throw new globalThis.Error("no")
			}
		}
		class Visitor extends Schema.Class<Visitor>("GetterVisitor")({
			box: Schema.Union([Guest, Schema.Struct({ role: Schema.String })]),
		}) {}
		const Visits = Domain.make({ principal: Visitor, resources: [Bot] })
		assert.throws(
			() =>
				Policy.define(Visits, { algorithm: "firstApplicable" })(function* (_) {
					yield* _.allow("read", Bot)
					yield* _.deny("read", Bot, {
						when: ($) => $.eq("name", $.principal("box.role")),
					})
				}),
			/may not read the field "box.role" of the principal/,
		)
	})

	it("reads a field that every struct of a union has", () => {
		class Owner extends Schema.Class<Owner>("NamedOwner")({
			flag: Schema.String,
			open: Schema.Boolean,
		}) {}
		const Box = Resource.make("PlainBox", {
			actions: ["read"],
			fields: {
				box: Schema.Union([
					Owner,
					Schema.Struct({ flag: Schema.String, kind: Schema.String }),
					Schema.String,
				]),
			},
		})
		const Boxes = Domain.make({ principal: Caller, resources: [Box] })
		// A string has no fields, so `box.flag` reads `null` for one.
		const policy = Policy.define(Boxes)(function* (_) {
			yield* _.allow("read", Box, {
				when: ($) => $.eq("box.flag", "yes"),
			})
		})
		const decide = (box: Resource.Data<typeof Box>["box"]) =>
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Box.make({ box }),
			})._tag
		assert.strictEqual(
			decide(Owner.make({ flag: "yes", open: false })),
			"Allow",
		)
		assert.strictEqual(decide({ flag: "yes", kind: "a" }), "Allow")
		assert.strictEqual(decide({ flag: "no", kind: "a" }), "NotApplicable")
		assert.strictEqual(decide("text"), "NotApplicable")
		// The class does not have `kind`, so a read of it is not plain.
		assert.throws(
			() =>
				rulesOf(Boxes, [
					Policy.rule({
						_tag: "Allow",
						actions: ["read"],
						resources: ["PlainBox"],
						when: Condition.builder<
							{ readonly box: { readonly kind: string | null } },
							unknown,
							unknown
						>().eq("box.kind", "a"),
					}),
				]),
			/A condition may not read the field "box.kind"/,
		)
	})

	it("takes a field with a number key", () => {
		const Sheet = Resource.make("NumberSheet", {
			actions: ["read"],
			fields: { data: Schema.Record(Schema.Literal(1), Schema.String) },
		})
		const Sheets = Domain.make({ principal: Caller, resources: [Sheet] })
		const request = {
			principal: alice,
			action: "read",
			resource: Sheet.make({ data: { 1: "a" } }),
			field: "data.1",
		} as const
		const open = Policy.define(Sheets)(function* (_) {
			yield* _.allow("read", Sheet)
		})
		assert.strictEqual(Policy.decideSync(open, request)._tag, "Allow")
		const granted = Policy.define(Sheets)(function* (_) {
			yield* _.allow("read", Sheet, { fields: ["data.1"] })
		})
		assert.strictEqual(Policy.decideSync(granted, request)._tag, "Allow")
		assert.deepStrictEqual(
			Policy.permittedFields(granted, {
				principal: alice,
				action: "read",
				resource: request.resource,
			}).pipe(Effect.runSync),
			["data.1"],
		)
	})

	it("does not read a field that the simple form of a condition leaves out", () => {
		const value = {
			box: {
				get flag(): string {
					throw new globalThis.Error("no")
				},
			},
		}
		const $ = Condition.builder<
			{ readonly box: { readonly flag: string } },
			unknown,
			Caller
		>()
		assert.isFalse(
			Condition.evaluateSync(
				$.and($.eq("box.flag", "blocked"), Condition.never),
				{
					value,
				},
			),
		)
		// The guest has no user id, so the test of the user id is false.
		assert.isFalse(
			Condition.evaluateSync(
				$.and(
					$.eq("box.flag", "blocked"),
					$.eq("box.flag", $.principal("userId")),
				),
				{ value, principal: guest },
			),
		)
		assert.throws(
			() => Condition.evaluateSync($.eq("box.flag", "blocked"), { value }),
			/not plain data/,
		)
	})

	it("does not take a scope that reads a getter", () => {
		class Info extends Schema.Class<Info>("ScopeInfo")({
			id: Schema.String,
		}) {
			get allowed(): boolean {
				throw new globalThis.Error("no")
			}
		}
		const Box = Resource.make("ScopeBox", {
			actions: ["read"],
			fields: { info: Info },
		})
		const Boxes = Domain.make({ principal: Caller, resources: [Box] })
		const open = Policy.define(Boxes)(function* (_) {
			yield* _.allow("read", Box)
		})
		const scoped = {
			principal: alice,
			action: "read",
			kind: "ScopeBox",
			within: ($) => $.or($.eq("info.allowed", true), Condition.always),
		} satisfies Policy.KindRequest<typeof Boxes>
		assert.throws(
			() => Policy.residual(open, scoped),
			/A scope does not fit the domain/,
		)
		assert.throws(
			() => Policy.coverage(open, scoped),
			/A scope does not fit the domain/,
		)
	})

	it("keeps a residual with a predicate in an unknown coverage", () => {
		const Note = Resource.make("PredicateNote", {
			actions: ["read"],
			fields: { allowed: Schema.Boolean },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note, {
				when: ($) =>
					$.and(
						$.eq("allowed", true),
						$.predicate("extra", () => true),
					),
			})
		})
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "PredicateNote",
		})
		assert.strictEqual(covered._tag, "Unknown")
		assert.notStrictEqual(covered.condition._tag, "False")
	})

	it("gives a coverage by the shape for a field with a check", () => {
		const Note = Resource.make("CheckedId", {
			actions: ["read"],
			fields: { id: Schema.String.check(Schema.isMinLength(1)) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note, { when: ($) => $.eq("id", "p1") })
		})
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "CheckedId",
		})
		assert.strictEqual(covered._tag, "Some")
		assert.strictEqual(covered.condition._tag, "Compare")
	})

	it("does not find a getter for a pattern with **", () => {
		class Owner extends Schema.Class<Owner>("StarOwner")({
			id: Schema.String,
		}) {
			get label() {
				return this.id
			}
		}
		const Box = Resource.make("StarBox", {
			actions: ["read"],
			fields: { owner: Owner },
		})
		const Boxes = Domain.make({ principal: Caller, resources: [Box] })
		assert.throws(
			() =>
				Policy.define(Boxes)(function* (_) {
					yield* _.allow("read", Box, { fields: ["**.label" as never] })
				}),
			/matches no field/,
		)
	})

	it("finds a key of a template whose parts split a pair of code units", () => {
		const Emoji = Resource.make("Emoji", {
			actions: ["read"],
			fields: {
				data: Schema.Record(
					Schema.TemplateLiteral(["\ud83d", Schema.String]),
					Schema.String,
				),
			},
		})
		const Emojis = Domain.make({ principal: Caller, resources: [Emoji] })
		const decide = (pattern: string) =>
			Policy.decideSync(
				Policy.define(Emojis)(function* (_) {
					yield* _.allow("read", Emoji, { fields: [pattern as never] })
				}),
				{
					principal: alice,
					action: "read",
					resource: Emoji.make({ data: {} }),
				},
			)._tag
		assert.strictEqual(decide("data.\u{1F600}"), "Allow")
	})

	it("does not take a condition with a node that is not known", () => {
		assert.isFalse(Schema.is(Condition.schema)({ _tag: "Broken" }))
		assert.isFalse(
			Schema.is(Condition.schema)(
				Condition.builder<object, object, object>().predicate("p", () => true),
			),
		)
		assert.throws(
			() =>
				rulesOf(App, [
					Policy.rule({
						_tag: "Deny",
						actions: ["read"],
						resources: ["Bot"],
						when: { _tag: "Broken" } as never,
					}),
				]),
			/not a whole condition tree/,
		)
	})

	it("checks a path in a recursive union in a short time", () => {
		interface Link {
			readonly kind: "a" | "b"
			readonly next: Link | null
		}
		const Link: Schema.Codec<Link> = Schema.Union([
			Schema.Struct({
				kind: Schema.Literal("a"),
				next: Schema.NullOr(Schema.suspend((): Schema.Codec<Link> => Link)),
			}),
			Schema.Struct({
				kind: Schema.Literal("b"),
				next: Schema.NullOr(Schema.suspend((): Schema.Codec<Link> => Link)),
			}),
		])
		const Chain = Resource.make("Chain", {
			actions: ["read"],
			fields: { root: Link },
		})
		const Chains = Domain.make({ principal: Caller, resources: [Chain] })
		const start = Date.now()
		const exit = Schema.decodeExit(Policy.schema(Chains))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Chain"],
					when: {
						_tag: "Exists",
						field: `root.${"next.".repeat(26)}missing`,
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.isBelow(Date.now() - start, 1000)
	})

	it("grants the whole value for ** into a record of structs", () => {
		const Store = Resource.make("Store", {
			actions: ["read"],
			fields: {
				items: Schema.Record(
					Schema.String,
					Schema.Struct({ info: Schema.Struct({ secret: Schema.String }) }),
				),
			},
		})
		const Stores = Domain.make({ principal: Caller, resources: [Store] })
		const decide = (pattern: string) =>
			Policy.decideSync(
				Policy.define(Stores)(function* (_) {
					// The pattern comes from a test case, as from JSON.
					yield* _.allow("read", Store, { fields: [pattern as never] })
				}),
				{
					principal: alice,
					action: "read",
					resource: Store.make({ items: {} }),
				},
			)._tag
		assert.strictEqual(decide("items.**.secret"), "Allow")
		assert.throws(() => decide("items.*.**.missing"), /matches no field/)
		// A struct name covers the fields below it.
		assert.strictEqual(decide("items.*.info"), "Allow")
	})

	it("does not take a test with a principal field that is an object", () => {
		class Timed extends Schema.Class<Timed>("Timed")({
			until: Schema.Date,
		}) {}
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { until: Schema.Date },
		})
		const Notes = Domain.make({ principal: Timed, resources: [Note] })
		const exit = Schema.decodeExit(Policy.schema(Notes))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Deny",
					actions: ["read"],
					resources: ["Note"],
					when: {
						_tag: "Compare",
						op: "eq",
						field: "until",
						value: { _tag: "Principal", path: "until" },
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
	})

	it("reads a union in the mode oneOf by its shape", () => {
		const Note = Resource.make("OneOfNote", {
			actions: ["read"],
			fields: {
				x: Schema.Union([Schema.String, Schema.Literal("blocked")], {
					mode: "oneOf",
				}),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
		})
		const request = {
			principal: alice,
			action: "read",
			kind: "OneOfNote",
			within: ($) => $.eq("x", "blocked"),
		} satisfies Policy.KindRequest<typeof Notes>
		// The mode oneOf stops "blocked", but the shape lets the field hold it.
		// Each value in the scope is allowed, so `All` is right.
		assert.strictEqual(Policy.coverage(policy, request)._tag, "All")
	})

	it("covers a kind by its shape when a check may stop each value", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(0)),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
		})
		const request = { principal: alice, action: "read", kind: "Note" } as const
		assert.strictEqual(Policy.coverage(policy, request)._tag, "All")
	})

	it("does not make a shared tree that would be too large", () => {
		const start = Date.now()
		assert.throws(
			() =>
				Arr.reduce(
					Arr.range(1, 24),
					emptyOf(App) as Policy.Policy<typeof App>,
					(policy) => Policy.all([policy, policy]),
				),
			/A policy tree has \d+ nodes. The most is 100000/,
		)
		assert.isBelow(Date.now() - start, 100)
	})

	it("does not take a condition from JSON with more nodes than the domain takes", () => {
		const Small = Domain.make({
			principal: Caller,
			resources: [Bot],
			limits: { conditionNodes: 100_000 },
		})
		const exit = Schema.decodeUnknownExit(Policy.schema(Small))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					when: {
						_tag: "And",
						conditions: Array.from({ length: 150_000 }, () => ({
							_tag: "True",
						})),
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			// The decoder stops at the first node past the limit.
			"A condition has more than 100000 nodes and values. The most is 100000.",
		)
	})

	it("makes the residual of a very wide condition", () => {
		const policy = Schema.decodeUnknownSync(PolicySchemaOfApp)({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					when: {
						_tag: "And",
						conditions: Array.from({ length: 90_000 }, () => ({
							_tag: "True",
						})),
					},
				},
			],
		})
		const request = { principal: alice, action: "read", kind: "Bot" } as const
		assert.strictEqual(Policy.residual(policy, request)._tag, "True")
		assert.strictEqual(Policy.coverage(policy, request)._tag, "All")
	})

	it("lets ** match no parts of a field path", () => {
		assert.isTrue(RuleData.matchesField("**.secret", "secret"))
		assert.isTrue(
			RuleData.matchesField("settings.**.secret", "settings.secret"),
		)
		assert.isTrue(RuleData.matchesField("settings.**", "settings"))
		assert.isTrue(
			RuleData.matchesField("settings.**.secret", "settings.a.b.secret"),
		)
		assert.isFalse(RuleData.matchesField("**.secret", "notsecret"))
		assert.isFalse(RuleData.matchesField("settings.**", "settingsx"))
		assert.isTrue(RuleData.matchesField("secret.**.**", "secret"))
		assert.isTrue(RuleData.matchesField("**.**.secret", "secret"))
		assert.isTrue(RuleData.matchesField(`${"**.".repeat(14)}secret`, "secret"))
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
			yield* _.deny("read", Bot, { fields: ["**.model"] })
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
				field: "settings.model",
			})._tag,
			"Deny",
		)
	})

	it("does not grant parts inside a scalar field", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { settings: Schema.String },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Bot, Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", "*", { fields: ["settings.*"] })
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ settings: "x" }),
			})._tag,
			"NotApplicable",
		)
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
	})

	describe("grants the whole value only for a field that can be there", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				entries: Schema.Record(
					Schema.String,
					Schema.Struct({ public: Schema.String }),
				),
				data: Schema.StructWithRest(Schema.Struct({ label: Schema.String }), [
					Schema.Record(Schema.String, Schema.String),
				]),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const decide = (pattern: string) =>
			Policy.decideSync(
				Policy.define(Notes)(function* (_) {
					// The pattern comes from a test case, as from JSON.
					yield* _.allow("read", Note, { fields: [pattern as never] })
				}),
				{
					principal: alice,
					action: "read",
					resource: Note.make({ entries: {}, data: { label: "a" } }),
				},
			)._tag

		it("in the values of a record", () => {
			assert.strictEqual(decide("entries.*.public"), "Allow")
			assert.throws(() => decide("entries.*.secret"), /matches no field/)
		})

		it("in the keys of a struct with a record part", () => {
			assert.strictEqual(decide("data.public*"), "Allow")
			assert.strictEqual(decide("data.label"), "Allow")
		})
	})

	it("does not fill the stack with a long field path", () => {
		interface Link {
			readonly value: string
			readonly next: Link | null
		}
		const Link: Schema.Codec<Link> = Schema.Struct({
			value: Schema.String,
			next: Schema.NullOr(Schema.suspend((): Schema.Codec<Link> => Link)),
		})
		const Chain = Resource.make("Chain", {
			actions: ["read"],
			fields: { root: Link },
		})
		const Chains = Domain.make({ principal: Caller, resources: [Chain] })
		const exit = Schema.decodeExit(Policy.schema(Chains))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Chain"],
					when: {
						_tag: "Exists",
						field: `root.${"next.".repeat(5000)}value`,
					},
				},
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.notInclude(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"RangeError",
		)
	})

	it("checks a rule that names one kind many times in a short time", () => {
		const start = Date.now()
		const exit = Schema.decodeUnknownExit(PolicySchemaOfApp)({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: Array.from({ length: 6000 }, () => "Bot"),
					when: {
						_tag: "In",
						field: "level",
						values: Array.from({ length: 6000 }, (_, index) => ({
							_tag: "Literal",
							value: index,
						})),
					},
				},
			],
		})
		assert.isTrue(Exit.isSuccess(exit))
		assert.isBelow(Date.now() - start, 2000)
	})

	it("decides shared nodes with a predicate for another action in a short time", () => {
		const leaf = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
			yield* _.allow("update", Bot, {
				when: ($) => $.predicate("never", () => false),
			})
		})
		const shared = Arr.reduce(
			Arr.range(1, 14),
			leaf as typeof leaf,
			(policy) => Policy.all([policy, policy]) as typeof leaf,
		)
		const start = Date.now()
		assert.strictEqual(
			Effect.runSync(
				Policy.decide(shared, {
					principal: alice,
					action: "read",
					resource: aliceBot,
				}),
			)._tag,
			"Allow",
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("decodes a condition with many fields in a short time", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { data: Schema.Record(Schema.String, Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const start = Date.now()
		const exit = Schema.decodeUnknownExit(Policy.schema(Notes))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Note"],
					when: {
						_tag: "And",
						conditions: Array.from({ length: 12_000 }, (_, index) => ({
							_tag: "Exists",
							field: `data.k${String(index)}`,
						})),
					},
				},
			],
		})
		assert.isTrue(Exit.isSuccess(exit))
		assert.isBelow(Date.now() - start, 2000)
	})

	it("does not take a path part that is not a field of the resource", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { ownerId: Schema.String },
			path: () => ["owner", { _tag: "Field", field: "ownerID" } as never],
		})
		assert.throws(
			() => Domain.make({ principal: Caller, resources: [Note] }),
			/not a string or a field/,
		)
	})

	it("does not take a path to a getter or past it", () => {
		class Owner extends Schema.Class<Owner>("Owner")({
			id: Schema.String,
		}) {
			get label() {
				return this.id
			}
		}
		const Team = Resource.make("Team", {
			actions: ["read"],
			fields: { owner: Owner },
		})
		const Teams = Domain.make({ principal: Caller, resources: [Team] })
		const PolicySchema = Policy.schema(Teams)
		const policy = (field: string) => ({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Team"],
					when: {
						_tag: "Compare",
						op: "eq",
						field,
						value: { _tag: "Literal", value: null },
					},
				},
			],
		})
		assert.isTrue(
			Exit.isSuccess(
				Schema.decodeUnknownExit(PolicySchema)(policy("owner.id")),
			),
		)
		assert.isTrue(
			Exit.isFailure(
				Schema.decodeUnknownExit(PolicySchema)(policy("owner.label")),
			),
		)
		assert.isTrue(
			Exit.isFailure(
				Schema.decodeUnknownExit(PolicySchema)(policy("owner.label.nothing")),
			),
		)
	})

	it("makes a deep residual without filling the stack", () => {
		const Rules = Arr.map(Arr.range(0, 1999), (index) =>
			Policy.rule({
				_tag: index % 2 === 0 ? "Allow" : "Deny",
				actions: ["read"],
				resources: ["Bot"],
				when: Condition.builder<{ readonly id: string }, unknown, unknown>().eq(
					"id",
					String(index),
				) as Condition.Condition,
			}),
		)
		const policy = rulesOf(App, Rules, { algorithm: "firstApplicable" })
		const request = { principal: alice, action: "read", kind: "Bot" } as const
		const residual = Policy.residual(policy, request)
		// The residual agrees with the decision.
		Arr.forEach(["0", "1", "1998", "1999", "x"], (id) => {
			const resource = Bot.make({ ...aliceBot, id })
			assert.strictEqual(
				Condition.evaluateSync(residual, { value: resource }),
				Policy.decideSync(policy, {
					principal: alice,
					action: "read",
					resource,
				})._tag === "Allow",
			)
		})
		assert.strictEqual(Policy.coverage(policy, request)._tag, "Some")
	})

	it("lists the fields of a domain with its own limit of parts", () => {
		const Note = Resource.make("ShortNote", {
			actions: ["read"],
			fields: { settings: Schema.Struct({ secret: Schema.String }) },
		})
		const Short = Domain.make({
			principal: Caller,
			resources: [Note],
			limits: { fieldPathParts: 1 },
		})
		const policy = Policy.define(Short)(function* (_) {
			yield* _.allow("read", Note)
		})
		const request = {
			principal: alice,
			action: "read",
			resource: Note.make({ settings: { secret: "s" } }),
		} as const
		// With one part, `settings` is the last part, so it is one field.
		assert.deepStrictEqual(
			Effect.runSync(Policy.permittedFields(policy, request)),
			["settings"],
		)
		// The types follow the default limit of 1000 parts, where `settings`
		// holds fields, so this domain needs a cast.
		assert.strictEqual(
			Policy.decideSync(policy, { ...request, field: "settings" as never })
				._tag,
			"Allow",
		)
	})

	it("decides on a field path of 1000 parts", () => {
		interface Link {
			readonly value: string
			readonly next: Link | null
		}
		const Link: Schema.Codec<Link> = Schema.Struct({
			value: Schema.String,
			next: Schema.NullOr(Schema.suspend((): Schema.Codec<Link> => Link)),
		})
		const Chain = Resource.make("Chain", {
			actions: ["read"],
			fields: { link: Link },
		})
		const Chains = Domain.make({ principal: Caller, resources: [Chain] })
		const path = ["link", ...Arr.makeBy(998, () => "next"), "value"].join(".")
		const chain = (value: string): Link =>
			Arr.reduce(
				Arr.range(1, 998),
				{ value, next: null } as Link,
				(next): Link => ({ value: "", next }),
			)
		const policy = rulesOf(Chains, [
			Policy.rule({
				_tag: "Allow",
				actions: ["read"],
				resources: ["Chain"],
				when: Condition.builder<any, unknown, unknown>().eq(path, "yes"),
			}),
		])
		const decide = (value: string) =>
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Chain.make({ link: chain(value) }),
			})._tag
		assert.strictEqual(decide("yes"), "Allow")
		assert.strictEqual(decide("no"), "NotApplicable")
		// One more part is past the limit of the domain.
		assert.throws(
			() =>
				rulesOf(Chains, [
					Policy.rule({
						_tag: "Allow",
						actions: ["read"],
						resources: ["Chain"],
						when: Condition.builder<any, unknown, unknown>().exists(
							`link.next.${path.slice("link.".length)}`,
						),
					}),
				]),
			/has more than 1000 parts. The most is 1000./,
		)
	})

	it("reads the message of a Schema error in a decision, as the residual does", () => {
		class Problem extends Schema.TaggedError<Problem>(
			"@nmnmcc/ability/tests/Policy.test/Problem",
		)("Problem", { message: Schema.String }) {}
		const Report = Resource.make("Report", {
			actions: ["read"],
			fields: { problem: Problem },
		})
		const Reports = Domain.make({ principal: Caller, resources: [Report] })
		const policy = Policy.define(Reports)(function* (_) {
			yield* _.deny("read", Report, {
				when: ($) => $.eq("problem.message", "secret"),
			})
			yield* _.allow("read", Report, {
				when: ($) => $.exists("problem.message"),
			})
		})
		const kind = { principal: alice, action: "read", kind: "Report" } as const
		const residual = Policy.residual(policy, kind)
		Arr.forEach(["secret", "open"], (message) => {
			// An `Error` keeps its message in a field that a loop does not see.
			const value = Report.make({ problem: Problem.make({ message }) })
			const decision = Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: value,
			})._tag
			assert.strictEqual(decision, message === "secret" ? "Deny" : "Allow")
			assert.strictEqual(
				Condition.evaluateSync(residual, { value }),
				decision === "Allow",
			)
		})
	})

	it("binds many tests on a field path of 1000 parts in a short time", () => {
		interface Link {
			readonly n: Link | null
			readonly v: string
		}
		const Link: Schema.Codec<Link> = Schema.Struct({
			n: Schema.NullOr(Schema.suspend((): Schema.Codec<Link> => Link)),
			v: Schema.String,
		})
		const Chain = Resource.make("Chain", {
			actions: ["read"],
			fields: { l: Link },
		})
		const Chains = Domain.make({
			principal: Caller,
			resources: [Chain],
			limits: { searchSteps: 2000 },
		})
		const field = `l.${"n.".repeat(998)}v`
		const start = Date.now()
		const exit = Schema.decodeUnknownExit(Policy.schema(Chains))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Chain"],
					when: {
						_tag: "Or",
						conditions: Arr.makeBy(1000, (index) => ({
							_tag: "Compare",
							op: "eq",
							field,
							value: { _tag: "Literal", value: String(index) },
						})),
					},
				},
			],
		})
		assert.isTrue(Exit.isSuccess(exit))
		// A lookup that copied the path at each part took about six seconds.
		assert.isBelow(Date.now() - start, 1000)
	})

	it("reads a missing optional field that a class has as a method as null", () => {
		class Part extends Schema.Class<Part>("PipedPart")({
			pipe: Schema.optionalKey(Schema.String),
		}) {}
		const Box = Resource.make("Box", {
			actions: ["read"],
			fields: { part: Part },
		})
		const Boxes = Domain.make({ principal: Caller, resources: [Box] })
		const policy = Policy.define(Boxes)(function* (_) {
			yield* _.deny("read", Box, { when: ($) => $.exists("part.pipe") })
			yield* _.allow("read", Box)
		})
		const kind = { principal: alice, action: "read", kind: "Box" } as const
		const residual = Policy.residual(policy, kind)
		// With no `pipe`, the value has `pipe` only as a method of Effect.
		Arr.forEach([Part.make({}), Part.make({ pipe: "p" })], (part) => {
			const value = Box.make({ part })
			const decision = Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: value,
			})._tag
			assert.strictEqual(
				decision,
				Object.hasOwn(part, "pipe") ? "Deny" : "Allow",
			)
			assert.strictEqual(
				Condition.evaluateSync(residual, { value }),
				decision === "Allow",
			)
		})
	})

	it("tests a path with a number part with a number field of the principal", () => {
		class Member extends Schema.Class<Member>("NumberMember")({
			id: Schema.Int,
		}) {}
		const Item = Resource.make("NumberItem", {
			actions: ["read"],
			fields: { id: Schema.Int },
			path: (fields) => ["item", fields.id],
		})
		const Items = Domain.make({ principal: Member, resources: [Item] })
		const policy = Policy.define(Items)(function* (_) {
			yield* _.allow("read", Item, {
				when: ($) => $.under("item", $.principal("id")),
			})
		})
		const decide = (id: number) =>
			Policy.decideSync(policy, {
				principal: Member.make({ id: 7 }),
				action: "read",
				resource: Item.make({ id }),
			})._tag
		assert.strictEqual(decide(7), "Allow")
		assert.strictEqual(decide(8), "NotApplicable")
	})

	it("takes the error fields of a struct as fields that may be missing, as an Error fits the struct", () => {
		const Row = Resource.make("ErrorRow", {
			actions: ["read"],
			fields: {
				error: Schema.Struct({ name: Schema.String, message: Schema.String }),
			},
		})
		const Rows = Domain.make({ principal: Caller, resources: [Row] })
		const policy = Policy.define(Rows)(function* (_) {
			yield* _.deny("read", Row, {
				when: ($) => $.not($.exists("error.name")),
			})
			yield* _.allow("read", Row)
		})
		// An `Error` has `name` only from its prototype, and it fits the
		// struct, as the Schema reads the name from the prototype.
		const value = { _tag: "ErrorRow", error: new Error("secret") } as const
		assert.isTrue(Schema.is(Row.schema)(value))
		const kind = { principal: alice, action: "read", kind: "ErrorRow" } as const
		const decision = Policy.decideSync(policy, {
			principal: alice,
			action: "read",
			resource: value as never,
		})._tag
		assert.strictEqual(decision, "Deny")
		assert.notStrictEqual(Policy.coverage(policy, kind)._tag, "All")
		assert.isFalse(
			Condition.evaluateSync(Policy.residual(policy, kind), { value }),
		)
	})

	it("reads the fields that every error may have only as own data, as the residual does", () => {
		class Fault extends Schema.TaggedError<Fault>(
			"@nmnmcc/ability/tests/Policy.test/Fault",
		)("Fault", {
			stack: Schema.optionalKey(Schema.Literal("ok")),
			name: Schema.optionalKey(Schema.String),
			message: Schema.optionalKey(Schema.String),
		}) {}
		const Report = Resource.make("FaultReport", {
			actions: ["read"],
			fields: { fault: Fault },
		})
		const Reports = Domain.make({ principal: Caller, resources: [Report] })
		const policy = Policy.define(Reports)(function* (_) {
			yield* _.deny("read", Report, {
				when: ($) =>
					$.or(
						$.and($.exists("fault.stack"), $.ne("fault.stack", "ok")),
						$.eq("fault.name", "ok"),
						$.eq("fault.message", "secret"),
					),
			})
			yield* _.allow("read", Report)
		})
		const kind = {
			principal: alice,
			action: "read",
			kind: "FaultReport",
		} as const
		const residual = Policy.residual(policy, kind)
		// The engine makes a stack, Effect has a getter of the name, and the
		// message is an own field when it is given. A stack or a name that is
		// not an own data field reads as missing.
		const faults = [
			Fault.make({}),
			Fault.make({ stack: "ok" }),
			Fault.make({ name: "ok" }),
			Fault.make({ message: "secret" }),
			Fault.make({ message: "open" }),
		]
		const decisions = Arr.map(faults, (fault) => {
			const value = Report.make({ fault })
			const decision = Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: value,
			})._tag
			assert.strictEqual(
				Condition.evaluateSync(residual, { value }),
				decision === "Allow",
			)
			return decision
		})
		assert.strictEqual(decisions[0], "Allow")
		assert.strictEqual(decisions[3], "Deny")
		assert.strictEqual(decisions[4], "Allow")
		// The coverage does not take a stack or a name as known.
		assert.notStrictEqual(Policy.coverage(policy, kind)._tag, "None")
		// Another getter is still not data.
		const made = Object.defineProperty({}, "stack", {
			get: () => "secret",
			enumerable: true,
		})
		assert.throws(() => readPart(made, "stack"), /not plain data/)
	})

	it("reads a missing optional message of a Schema error as null", () => {
		class Problem extends Schema.TaggedError<Problem>(
			"@nmnmcc/ability/tests/Policy.test/OptionalProblem",
		)("Problem", { message: Schema.optionalKey(Schema.String) }) {}
		const Report = Resource.make("Report", {
			actions: ["read"],
			fields: { problem: Problem },
		})
		const Reports = Domain.make({ principal: Caller, resources: [Report] })
		const policy = Policy.define(Reports)(function* (_) {
			yield* _.deny("read", Report, {
				when: ($) => $.exists("problem.message"),
			})
			yield* _.allow("read", Report)
		})
		const kind = { principal: alice, action: "read", kind: "Report" } as const
		const residual = Policy.residual(policy, kind)
		// With no message, the value has `message` only from `Error.prototype`.
		Arr.forEach(
			[Problem.make({}), Problem.make({ message: "m" })],
			(problem) => {
				const value = Report.make({ problem })
				const decision = Policy.decideSync(policy, {
					principal: alice,
					action: "read",
					resource: value,
				})._tag
				assert.strictEqual(
					decision,
					Object.hasOwn(problem, "message") ? "Deny" : "Allow",
				)
				assert.strictEqual(
					Condition.evaluateSync(residual, { value }),
					decision === "Allow",
				)
			},
		)
	})

	it("checks a field name that a rule names many times one time, and counts the work", () => {
		const kinds = Arr.makeBy(1000, (index) =>
			Resource.make(`Named${String(index)}`, {
				actions: ["read"],
				fields: { name: Schema.String },
			}),
		)
		const input = {
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: Arr.map(kinds, (kind) => kind.kind),
					fields: Arr.makeBy(50_000, () => "name"),
				},
			],
		}
		const decodeWith = (searchSteps: number) =>
			Schema.decodeUnknownExit(
				Policy.schema(
					Domain.make({
						principal: Caller,
						resources: kinds,
						limits: { searchSteps },
					}),
				),
			)(input)
		const start = Date.now()
		// One name, looked up in 1000 kinds.
		assert.isTrue(Exit.isSuccess(decodeWith(1000)))
		const small = decodeWith(999)
		assert.isTrue(Exit.isFailure(small))
		assert.include(
			String(Exit.isFailure(small) ? small.cause : ""),
			"steps to check",
		)
		// A lookup of each copy in each kind took about ten seconds.
		assert.isBelow(Date.now() - start, 2000)
	})

	it("finds the fields that many rules name in a short time, for a request with no field", () => {
		const names = Arr.makeBy(5000, (index) => `f${String(index)}`)
		const Wide = Resource.make("Wide", {
			actions: ["read"],
			fields: Object.fromEntries(
				Arr.map(names, (name) => [name, Schema.String]),
			) as Record<string, typeof Schema.String>,
		})
		const Wides = Domain.make({
			principal: Caller,
			resources: [Wide],
			// Each name of a rule counts one step for each of its kinds.
			limits: { searchSteps: 10_000 },
		})
		const policy = Schema.decodeUnknownSync(Policy.schema(Wides))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: Arr.map(names, (name) => ({
				_tag: "Allow",
				actions: ["read"],
				resources: ["Wide"],
				fields: [name],
				when: { _tag: "False" },
			})),
		})
		const start = Date.now()
		const decision = Policy.decideSync(policy, {
			principal: alice,
			action: "read",
			resource: Wide.make(
				Object.fromEntries(Arr.map(names, (name) => [name, ""])) as never,
			),
		})
		assert.strictEqual(decision._tag, "NotApplicable")
		// A search of the catalog for each name took about two seconds.
		assert.isBelow(Date.now() - start, 500)
	})

	it("puts a limit on the parts of the paths of the steps of explain", () => {
		const Small = Domain.make({
			principal: Caller,
			resources: [Bot],
			limits: { policyNodes: 1000 },
		})
		// A chain of 100 levels with a rule that does not apply at each one. A
		// step has the full path of its rule, so the paths of the steps have
		// about 100 * 100 parts. A chain of 7000 levels filled a 128 MB heap.
		const chain = Arr.reduce(
			Arr.range(1, 100),
			{
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [{ _tag: "Allow", actions: ["read"], resources: ["Bot"] }],
			} as unknown,
			(inner) => ({
				_tag: "FirstOf",
				policies: [
					{
						_tag: "Rules",
						algorithm: "denyOverrides",
						rules: [
							{
								_tag: "Allow",
								actions: ["read"],
								resources: ["Bot"],
								when: { _tag: "False" },
							},
						],
					},
					inner,
				],
			}),
		)
		const policy = Schema.decodeUnknownSync(Policy.schema(Small))(chain)
		const request = {
			principal: alice,
			action: "read",
			resource: aliceBot,
		} as const
		assert.strictEqual(Policy.decideSync(policy, request)._tag, "Allow")
		const exit = Effect.runSyncExit(Policy.explain(policy, request))
		assert.isTrue(Exit.hasDies(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"The most is 1000",
		)
	})

	it("counts each star inside a part of a field pattern as a part", () => {
		const Wide = Resource.make("StarWide", {
			actions: ["read"],
			fields: Object.fromEntries(
				Arr.makeBy(1000, (index) => [`f${String(index)}`, Schema.String]),
			) as Record<string, typeof Schema.String>,
		})
		const Wides = Domain.make({
			principal: Caller,
			resources: [Wide],
			limits: { searchSteps: 5000 },
		})
		const decode = (pattern: string) =>
			Schema.decodeExit(Policy.schema(Wides))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["StarWide"],
						fields: [pattern],
					},
				],
			})
		const start = Date.now()
		// One part with a million stars. A match of it on each field took
		// about twelve seconds.
		const many = decode(`${"*a".repeat(1_000_000)}*`)
		assert.isTrue(Exit.isFailure(many))
		assert.include(
			String(Exit.isFailure(many) ? many.cause : ""),
			"parts and stars inside parts",
		)
		assert.isBelow(Date.now() - start, 1000)
		// Within the parts, the stars still count in the work.
		const work = decode(`${"*a".repeat(900)}*`)
		assert.include(
			String(Exit.isFailure(work) ? work.cause : ""),
			"steps to check",
		)
	})

	it("counts the work of each field pattern on the longest field of a request", () => {
		interface Node {
			readonly a: Node | null
			readonly x: string
			readonly y: string
		}
		const Node: Schema.Codec<Node> = Schema.Struct({
			a: Schema.NullOr(Schema.suspend((): Schema.Codec<Node> => Node)),
			x: Schema.String,
			y: Schema.String,
		})
		const Tree = Resource.make("Tree", {
			actions: ["read"],
			fields: { a: Node },
		})
		const Trees = Domain.make({ principal: Caller, resources: [Tree] })
		// 400 other patterns of 202 parts. A decision on a field of 1000 parts
		// tests each one on each part, which took about six seconds.
		const patterns = Arr.makeBy(
			400,
			(index) =>
				`a.${Arr.makeBy(9, (bit) => (((index >> bit) & 1) === 1 ? "a*" : "a")).join(".")}.${"**.a.".repeat(100)}x`,
		)
		const start = Date.now()
		const exit = Schema.decodeExit(Policy.schema(Trees))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Deny",
					actions: ["read"],
					resources: ["Tree"],
					fields: patterns,
				},
				{ _tag: "Allow", actions: ["read"], resources: ["Tree"] },
			],
		})
		assert.isTrue(Exit.isFailure(exit))
		assert.include(
			String(Exit.isFailure(exit) ? exit.cause : ""),
			"steps to check",
		)
		assert.isBelow(Date.now() - start, 2000)
	})

	it("tests a field pattern that a rule names many times one time on a long field", () => {
		interface Node {
			readonly a: Node | null
			readonly allowed: string
			readonly blocked: string
		}
		const Node: Schema.Codec<Node> = Schema.Struct({
			a: Schema.NullOr(Schema.suspend((): Schema.Codec<Node> => Node)),
			allowed: Schema.String,
			blocked: Schema.String,
		})
		const Tree = Resource.make("Tree", {
			actions: ["read"],
			fields: { root: Node },
		})
		const Trees = Domain.make({
			principal: Caller,
			resources: [Tree],
			// One pattern of 201 parts on a field of up to 1000 parts.
			limits: { searchSteps: 300_000 },
		})
		const pattern = `root.${"**.a.".repeat(100)}allowed`
		const policy = Schema.decodeSync(Policy.schema(Trees))({
			_tag: "Rules",
			algorithm: "denyOverrides",
			rules: [
				{
					_tag: "Allow",
					actions: ["read"],
					resources: ["Tree"],
					fields: Arr.makeBy(1000, () => pattern),
				},
			],
		})
		const leaf: Node = { a: null, allowed: "", blocked: "" }
		const start = Date.now()
		const decision = Policy.decideSync(policy, {
			principal: alice,
			action: "read",
			resource: Tree.make({ root: leaf }),
			field: `root.${"a.".repeat(600)}blocked` as never,
		})
		assert.strictEqual(decision._tag, "NotApplicable")
		// A test of each copy of the pattern took about nine seconds.
		assert.isBelow(Date.now() - start, 1000)
	})

	it("collects the rules of a deep tree with a rule at each level in a short time", () => {
		const leaf = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		})
		const deep = Arr.reduce(
			Arr.range(1, 32_000),
			leaf as Policy.Policy<typeof App>,
			(previous) => Policy.all([leaf, previous]),
		)
		const start = Date.now()
		assert.deepStrictEqual(
			Policy.residual(deep, { principal: alice, action: "read", kind: "Bot" }),
			Condition.always,
		)
		// A walk that joined the lists of the rules of the children at each
		// node would copy 32,000 rules about 32,000 times.
		assert.isBelow(Date.now() - start, 3000)
	})

	it("makes and walks a deep policy tree without filling the stack", () => {
		const one = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		})
		const deep = Arr.reduce(
			Arr.range(1, 20_000),
			one as Policy.Policy<typeof App>,
			(inner) => Policy.all([inner]),
		)
		const request = {
			principal: alice,
			action: "read",
			resource: aliceBot,
		} as const
		assert.strictEqual(Policy.decideSync(deep, request)._tag, "Allow")
		const steps = Effect.runSync(Policy.explain(deep, request)).steps
		assert.strictEqual(steps.length, 1)
		assert.strictEqual(steps[0]!.path.length, 20_001)
		assert.deepStrictEqual(
			Policy.residual(deep, { principal: alice, action: "read", kind: "Bot" }),
			Condition.always,
		)
		const json = Schema.encodeSync(Policy.schema(App))(deep)
		assert.isTrue(Exit.isSuccess(Schema.decodeExit(Policy.schema(App))(json)))
	})

	it("does not take a getter of a class inside a codec", () => {
		class Member extends Schema.Class<Member>("Member")({
			id: Schema.String,
		}) {
			get ownerId() {
				return this.id
			}
		}
		const Members = Domain.make({
			principal: Schema.fromJsonString(Member),
			resources: [Bot],
		})
		const policy = Policy.define(Members)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("id")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: Member.make({ id: "alice" }),
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
		assert.throws(
			() =>
				Policy.define(Members)(function* (_) {
					yield* _.allow("read", Bot, {
						when: ($) => $.eq("ownerUserId", $.principal("ownerId")),
					})
				}),
			/The principal has no field "ownerId"/,
		)
	})

	describe("keeps the search safe for unusual fields", () => {
		const denyCoverage = (
			fields: Schema.Struct.Fields,
			deny: Condition.Ast,
		) => {
			const Note = Resource.make("Note", { actions: ["read"], fields })
			const Notes = Domain.make({ principal: Caller, resources: [Note] })
			const policy = rulesOf(Notes, [
				Policy.builder(Notes).allow("read", Note),
				Policy.rule({
					_tag: "Deny",
					actions: ["read"],
					resources: ["Note"],
					when: deny as Condition.Condition,
				}),
			])
			return Policy.coverage(policy, {
				principal: alice,
				action: "read",
				kind: "Note",
			})._tag
		}
		// The builder only makes the conditions, so its field types are simple.
		const $ = Condition.builder<
			{ readonly value: string | null; readonly constructor: string | null },
			unknown,
			unknown
		>()

		it("lets a Void field hold any value", () => {
			assert.notStrictEqual(
				denyCoverage({ value: Schema.Void }, $.exists("value")),
				"All",
			)
		})

		it("reads a field named constructor as data", () => {
			// The field is required, so a value always has it.
			assert.strictEqual(
				denyCoverage(
					{ constructor: Schema.ObjectKeyword },
					$.not($.exists("constructor")),
				),
				"All",
			)
		})
	})

	it("declares a recursive resource class", () => {
		assert.doesNotThrow(() => {
			class Folder extends Resource.Class<Folder>()("Folder", {
				actions: ["read"],
				fields: {
					name: Schema.String,
					parent: Schema.NullOr(
						Schema.suspend((): Schema.Codec<Folder> => Folder),
					),
				},
			}) {}
			return Folder
		})
	})

	it("does not take a copy of a rule or a policy made with a spread", () => {
		const rule = Policy.builder(App).allow("read", Bot)
		assert.throws(() =>
			rulesOf(App, [{ ...rule } as unknown as Policy.AnyRule]),
		)
		const policy = emptyOf(App)
		assert.throws(() => Policy.any([{ ...policy } as Policy.Policy<App>]))
	})

	it("does not take a field that is a getter of a nested class", () => {
		class Info extends Schema.Class<Info>("Info")({ id: Schema.String }) {
			get owner() {
				return this.id
			}
		}
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { info: Info },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		assert.throws(
			() =>
				Policy.define(Notes)(function* (_) {
					yield* _.allow("read", Note, {
						when: ($) => $.eq("info.owner", "alice"),
					})
				}),
			/is not a field of every resource of the rule/,
		)
	})

	it("says which name a name with a mistake may mean", () => {
		const bind = (rule: Partial<Policy.RuleShape>) => () =>
			rulesOf(App, [
				Policy.rule({
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					...rule,
				} as Policy.RuleShape),
			])
		const $ = Condition.builder<{ readonly nmae: string }, unknown, unknown>()
		assert.throws(
			bind({ when: $.eq("nmae", "a") as Condition.Condition }),
			/The field "nmae" is not a field of every resource of the rule. Did you mean "name"\?/,
		)
		assert.throws(
			bind({ resources: ["Bto"] }),
			/There is no resource with the kind "Bto". Did you mean "Bot"\?/,
		)
		assert.throws(
			bind({ actions: ["raed"] }),
			/The action "raed" is not an action of these resources. Did you mean "read"\?/,
		)
		const ref = Condition.builder<
			{ readonly ownerUserId: string },
			unknown,
			{ readonly userid: string }
		>()
		assert.throws(
			bind({
				when: ref.eq(
					"ownerUserId",
					ref.principal("userid"),
				) as Condition.Condition,
			}),
			/The principal has no field "userid". Did you mean "userId"\?/,
		)
	})

	it("counts the fields of a long condition in a short time", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { info: Schema.Record(Schema.String, Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const $ = Condition.builder<
			{ readonly info: { readonly [key: string]: string } },
			unknown,
			unknown
		>()
		const keys = Array.from(
			{ length: 3000 },
			(_, index) => `info.k${String(index)}`,
		)
		const policy = rulesOf(Notes, [
			Policy.rule({
				_tag: "Allow",
				actions: ["read"],
				resources: ["Note"],
				when: $.and(...Arr.map(keys, (key) => $.exists(key as "info.x"))),
			}),
		])
		const start = Date.now()
		Policy.coverage(policy, { principal: alice, action: "read", kind: "Note" })
		assert.isBelow(Date.now() - start, 3000)
	})

	it("gives exact coverage for fields of any shape", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				name: Schema.String,
				level: Schema.optionalKey(Schema.Finite),
				tags: Schema.Record(Schema.String, Schema.String),
				when: Schema.Date,
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const coverage = (when: Condition.Ast) =>
			Policy.coverage(
				rulesOf(Notes, [
					Policy.rule({
						_tag: "Allow",
						actions: ["read"],
						resources: ["Note"],
						when: when as Condition.Condition,
					}),
				]),
				{ principal: alice, action: "read", kind: "Note" },
			)
		const $ = Condition.builder<
			{
				readonly name: string
				readonly level: number | null
				readonly tags: { readonly [key: string]: string }
				readonly when: string | null
			},
			unknown,
			unknown
		>()
		assert.strictEqual(
			coverage($.or($.eq("name", "a"), $.ne("name", "a")))._tag,
			"All",
		)
		assert.strictEqual(coverage($.gte("level", 0))._tag, "Some")
		assert.strictEqual(coverage($.exists("tags.a"))._tag, "Some")
		assert.strictEqual(coverage($.exists("when"))._tag, "All")
		assert.throws(() => coverage($.eq("when", "x")), /can not hold the value/)
	})

	it("reads a field with a check by its shape", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				ownerId: Schema.Int.check(Schema.isGreaterThan(0)),
				level: Schema.Int,
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note, { when: ($) => $.gte("level", 0) })
		})
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "Note",
			within: ($) => $.eq("ownerId", 0),
		})
		// The check stops `0`, but the shape of an integer holds it.
		assert.strictEqual(covered._tag, "Some")
	})

	it("searches many fields without a deep stack", () => {
		const fields = Object.fromEntries(
			Array.from({ length: 1300 }, (_, index) => [
				`f${String(index)}`,
				Schema.Null,
			]),
		)
		const Wide = Resource.make("Wide", { actions: ["read"], fields })
		const Wides = Domain.make({ principal: Caller, resources: [Wide] })
		const $ = Condition.builder<Record<string, null>, unknown, unknown>()
		const policy = rulesOf(Wides, [
			Policy.rule({
				_tag: "Allow",
				actions: ["read"],
				resources: ["Wide"],
				when: $.and(
					...Object.keys(fields).map((field) => $.eq(field, null)),
				) as Condition.Condition,
			}),
		])
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "Wide",
		})
		assert.strictEqual(covered._tag, "Unknown")
	})

	describe("deep chains and long lists", () => {
		const load = (when: unknown) =>
			Schema.decodeUnknownResult(PolicySchemaOfApp)({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [{ _tag: "Allow", actions: ["read"], resources: ["Bot"], when }],
			})
		const leaves = Arr.makeBy(20_000, (index) => ({
			_tag: "Compare",
			op: "ne",
			field: "id",
			value: { _tag: "Literal", value: `i${String(index)}` },
		}))

		it("decides a deep chain of junctions over many leaves in a short time", () => {
			const chain = Arr.reduce(
				Arr.range(1, 300),
				{ _tag: "And", conditions: leaves } as unknown,
				(inner, level) =>
					level % 2 === 0
						? { _tag: "And", conditions: [inner] }
						: {
								_tag: "And",
								conditions: [
									{ _tag: "Or", conditions: [inner] },
									{ _tag: "Exists", field: "name" },
								],
							},
			)
			const result = load(chain)
			assert.isTrue(Result.isSuccess(result))
			if (Result.isFailure(result)) {
				return
			}
			const begin = Date.now()
			assert.strictEqual(
				Policy.decideSync(result.success, {
					principal: alice,
					action: "read",
					resource: aliceBot,
				})._tag,
				"Allow",
			)
			// It takes about 0.25 seconds. A walk that copied the leaves at each
			// level took more than six.
			assert.isBelow(Date.now() - begin, 3000)
		})

		it("searches an In test with very many values in a short time", () => {
			const names = Arr.makeBy(500, (index) => String(index))
			const result = load({
				_tag: "And",
				conditions: [
					{
						_tag: "In",
						field: "id",
						values: Arr.map(names, (value) => ({ _tag: "Literal", value })),
					},
					{
						_tag: "In",
						field: "level",
						values: Arr.makeBy(90_000, () => ({
							_tag: "Literal",
							value: 0,
						})),
					},
					...Arr.map(names, (value) => ({
						_tag: "Or",
						conditions: [
							{
								_tag: "Compare",
								op: "ne",
								field: "id",
								value: { _tag: "Literal", value },
							},
							{
								_tag: "Compare",
								op: "eq",
								field: "level",
								value: { _tag: "Literal", value: 1 },
							},
						],
					})),
				],
			})
			assert.isTrue(Result.isSuccess(result))
			if (Result.isFailure(result)) {
				return
			}
			const begin = Date.now()
			Policy.coverage(result.success, {
				principal: alice,
				action: "read",
				kind: "Bot",
			})
			assert.isBelow(Date.now() - begin, 3000)
		})
	})

	it("searches many values of one field without a deep stack", () => {
		const ids = Array.from({ length: 4000 }, (_, index) => `b${String(index)}`)
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: ($) => $.in("id", ids) })
			yield* _.deny("read", Bot, { when: ($) => $.in("id", ids) })
		})
		const covered = Policy.coverage(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.strictEqual(covered._tag, "None")
	})

	it("searches a condition with shared branches in a short time", () => {
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		const shared = Arr.reduce(
			Arr.range(0, 14),
			$.eq("id", "a") as Condition.Test<Bot>,
			(inner) => $.or(inner, inner),
		)
		const start = Date.now()
		assert.strictEqual(
			Condition.satisfiable(shared, { budget: 0 })._tag,
			"Unknown",
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("gives an example with an own field named __proto__", () => {
		const $ = Condition.builder<
			{ readonly __proto__: string | null },
			unknown,
			unknown
		>()
		const condition = $.exists("__proto__")
		const answer = Condition.satisfiable(condition)
		assert.strictEqual(answer._tag, "Satisfiable")
		const value = answer._tag === "Satisfiable" ? answer.example : {}
		assert.isTrue(Condition.evaluateSync(condition, { value }))
	})

	it("simplifies shared predicate branches in a short time", () => {
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		const shared = Arr.reduce(
			Arr.range(0, 14),
			$.predicate("never", () => false) as Condition.Condition<
				Condition.Reads<Bot, Caller>,
				Condition.Opaque
			>,
			(inner) => $.and(inner, inner),
		)
		const start = Date.now()
		assert.doesNotThrow(() => Condition.simplify(shared))
		assert.doesNotThrow(() => Condition.partial(shared, { principal: alice }))
		assert.isBelow(Date.now() - start, 1000)
	})

	it("keeps tests with numbers that JSON can not hold apart", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
			yield* _.deny("read", Bot, {
				when: ($) =>
					$.or(
						$.lt("level", Number.NEGATIVE_INFINITY),
						$.lt("level", Infinity),
					),
			})
		})
		const request = { principal: alice, action: "read", kind: "Bot" } as const
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Deny",
		)
		assert.isFalse(
			Condition.evaluateSync(Policy.residual(policy, request), {
				value: aliceBot,
			}),
		)
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

	it("lists the fields of a deep shared policy in a short time", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				title: Schema.String,
				settings: Schema.Record(Schema.String, Schema.String),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Arr.reduce(
			Arr.range(0, 14),
			Policy.define(Notes)(function* (_) {
				yield* _.allow("read", Note)
			}) as Policy.Policy<typeof Notes>,
			(inner) => Policy.all([inner, inner]),
		)
		const start = Date.now()
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ title: "a", settings: {} }),
			}),
		)
		assert.deepStrictEqual(fields, ["title", "settings"])
		assert.isBelow(Date.now() - start, 1000)
	})

	it("gives the residual of many ordered rules in a short time", () => {
		const ids = Array.from({ length: 4000 }, (_, index) => `b${String(index)}`)
		const policy = Policy.define(App, { algorithm: "firstApplicable" })(
			function* (_) {
				yield* Arr.map(ids, (id) =>
					_.allow("read", Bot, { when: ($) => $.eq("id", id) }),
				)
			},
		)
		const start = Date.now()
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.isBelow(Date.now() - start, 1000)
		assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
	})

	it("simplifies a long list of tests in a short time", () => {
		const ids = Array.from({ length: 4000 }, (_, index) => `b${String(index)}`)
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.or(...ids.map((id) => $.eq("id", id))),
			})
		})
		const start = Date.now()
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.isBelow(Date.now() - start, 2000)
		assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
	})

	it("takes a principal field inside a record", () => {
		class User extends Schema.Class<User>("User")({
			claims: Schema.Record(Schema.String, Schema.String),
		}) {}
		const Claims = Domain.make({ principal: User, resources: [Bot] })
		const policy = Policy.define(Claims)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("claims.userId")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: User.make({ claims: { userId: "alice" } }),
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
	})

	it("does not take a path inside a suspended string", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { id: Schema.suspend(() => Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		assert.throws(() =>
			Schema.decodeSync(Policy.schema(Notes))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Note"],
						when: {
							_tag: "Compare",
							op: "eq",
							field: "id.missing",
							value: { _tag: "Literal", value: null },
						},
					},
				],
			}),
		)
	})

	it("checks a path past a key of a record against the record values", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { settings: Schema.Record(Schema.String, Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		assert.isTrue(hasField(Note, "settings.mode"))
		assert.isFalse(hasField(Note, "settings.mode.x"))
		assert.throws(() =>
			rulesOf(Notes, [
				Policy.rule({
					_tag: "Allow",
					actions: ["read"],
					resources: ["Note"],
					fields: ["settings.mode.x"],
				}),
			]),
		)
	})

	it("checks a key of a record against the Schema of the keys", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				settings: Schema.Record(
					Schema.TemplateLiteral(["public-", Schema.String]),
					Schema.String,
				),
			},
		})
		assert.isTrue(hasField(Note, "settings.public-mode"))
		assert.isFalse(hasField(Note, "settings.private-mode"))
	})

	it("takes a deep path in a recursive Schema", () => {
		interface Tree {
			readonly name: string
			readonly child?: Tree
		}
		const Tree: Schema.Codec<Tree> = Schema.Struct({
			name: Schema.String,
			child: Schema.optionalKey(Schema.suspend(() => Tree)),
		})
		const Forest = Resource.make("Forest", {
			actions: ["read"],
			fields: { tree: Tree },
		})
		const Woods = Domain.make({ principal: Caller, resources: [Forest] })
		const policy = Policy.define(Woods)(function* (_) {
			yield* _.allow("read", Forest, {
				when: ($) => $.eq("tree.child.child.name", "a"),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Forest.make({
					tree: { name: "x", child: { name: "y", child: { name: "a" } } },
				}),
			})._tag,
			"Allow",
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

	it("matches long patterns in a short time", () => {
		const start = Date.now()
		// Only a whole part may be "**".
		assert.throws(() => RuleData.matchesField("*".repeat(10_000), "name"))
		assert.isFalse(RuleData.matchesField(`${"x".repeat(40_000)}*`, "name"))
		assert.isBelow(Date.now() - start, 1000)
	})

	it("keeps the getters of a resource class after a check of its paths", () => {
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
			yield* _.allow("read", Doc, { when: ($) => $.eq("flags.active", true) })
		})
		const doc = Doc.make({ flags: { blocked: true } })
		assert.isTrue(doc instanceof Doc)
		assert.isTrue(doc.blocked)
	})

	it("matches a pattern with many stars in a short time", () => {
		const start = Date.now()
		assert.isFalse(
			RuleData.matchesField(`${"*a".repeat(80)}Z`, "organizationIdentifier"),
		)
		assert.isBelow(Date.now() - start, 1000)
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
