import { Context, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import * as HttpApi from "../src/HttpApi.ts"
import {
	Authorizer,
	Condition,
	Domain,
	Policy,
	Resource,
	type Decision,
} from "../src/index.ts"
import {
	alice,
	aliceBot,
	aliceTrigger,
	App,
	Bot,
	Caller,
	emptyOf,
	Trigger,
} from "./fixtures.ts"

type App = typeof App

describe("Resource", () => {
	it("makes a class that is a Schema and a resource", () => {
		expect(aliceBot._tag).type.toBe<"Bot">()
		expect(aliceBot.shared).type.toBe<boolean>()
		expect(Bot.kind).type.toBe<"Bot">()
		expect(Bot.actions).type.toBe<
			readonly ["read", "update", "delete", "delegate"]
		>()
		expect(Schema.decodeUnknownSync(Bot)({})).type.toBe<Bot>()
	})

	it("takes only fields of the resource in a path", () => {
		expect(Resource.make).type.not.toBeCallableWith("Note", {
			actions: ["read"],
			fields: { ownerId: Schema.String },
			path: () => [{ _tag: "Field" as const, field: "ownerID" as const }],
		})
		expect(Resource.make).type.toBeCallableWith("Note", {
			actions: ["read"],
			fields: { ownerId: Schema.String },
			path: () => [{ _tag: "Field" as const, field: "ownerId" as const }],
		})
	})

	it("makes plain values with a tag", () => {
		expect(aliceTrigger._tag).type.toBe<"Trigger">()
		expect(Trigger.make).type.not.toBeCallableWith({ id: "t" })
	})
})

describe("Rule", () => {
	const _ = Policy.builder(App)

	it("takes only the actions of the resource", () => {
		expect(_.allow).type.toBeCallableWith("delegate", Bot)
		expect(_.allow).type.toBeCallableWith(["read", "write"], "Trigger")
		expect(_.allow).type.toBeCallableWith("*", "*")
		expect(_.allow).type.not.toBeCallableWith("write", Bot)
		expect(_.allow).type.not.toBeCallableWith("read", "Ghost")
	})

	it("takes only the fields of the resource, with their types", () => {
		expect(_.allow).type.toBeCallableWith("read", Bot, {
			when: ($: Condition.Builder<Policy.DataFor<App, "Bot">, Bot, Caller>) =>
				$.and(
					$.eq("ownerUserId", $.principal("userId")),
					$.eq("ownerUserId", null),
					$.gt("level", 3),
					$.eq("settings.model", "large"),
				),
			fields: ["name", "settings.*"],
		})
		expect(_.allow).type.not.toBeCallableWith("read", Bot, {
			fields: ["color"],
		})
	})

	it("checks the type of each value", () => {
		_.allow("read", Bot, {
			// There is no field with this name.
			// @ts-expect-error Argument of type '"color"'
			when: ($) => $.eq("color", "red"),
		})
		_.allow("read", Bot, {
			// The level is a number.
			// @ts-expect-error 'OperandOf<number, any>'
			when: ($) => $.eq("level", "high"),
		})
		_.allow("read", Bot, {
			// The principal has no field with this name.
			// @ts-expect-error Argument of type '"tenantId"'
			when: ($) => $.eq("ownerUserId", $.principal("tenantId")),
		})
		_.allow("read", Bot, {
			// The role is not a number.
			// @ts-expect-error 'OperandOf<number, any>'
			when: ($) => $.eq("level", $.principal("role")),
		})
		_.allow("read", Bot, {
			// A string field is not a number field.
			// @ts-expect-error 'OperandOf<number, any>'
			when: ($) => $.gt("level", "x"),
		})
	})

	it("keeps the types of a predicate", () => {
		const rule = _.allow("read", Bot, {
			when: ($) => $.predicate("quota", () => Effect.fail("no quota" as const)),
		})
		expect(rule).type.toBe<
			Policy.Rule<
				App,
				Condition.Reads<Bot, Caller>,
				Condition.Opaque<"no quota">
			>
		>()
		expect(_.allow("read", Bot)).type.toBe<Policy.Rule<App>>()
	})

	it("takes the name of a struct in the fields of a rule", () => {
		expect(_.allow).type.toBeCallableWith("read", Bot, {
			fields: ["settings"],
		})
		expect(_.allow).type.toBeCallableWith("read", Bot, {
			fields: ["settings.model"],
		})
		expect(_.allow).type.not.toBeCallableWith("read", Bot, {
			fields: ["settings.color"],
		})
	})

	it("takes a field of any value and a record with number keys", () => {
		const Loose = Resource.make("Loose", {
			actions: ["read"],
			fields: {
				data: Schema.Unknown,
				counts: Schema.Record(Schema.Finite, Schema.String),
			},
		})
		const Looses = Domain.make({ principal: Caller, resources: [Loose] })
		const policy = Policy.define(Looses)(function* (_) {
			yield* _.allow("read", Loose)
		})
		const request = (field: "data" | "counts") =>
			({
				principal: alice,
				action: "read",
				resource: Loose.make({ data: 1, counts: {} }),
				field,
			}) as const
		expect(Policy.decideSync).type.toBeCallableWith(policy, request("data"))
		expect(Policy.decideSync).type.toBeCallableWith(policy, request("counts"))
		const $ = Condition.builder<
			Policy.DataFor<typeof Looses, "Loose">,
			unknown,
			Caller
		>()
		expect($.exists).type.toBeCallableWith("data")
		expect($.exists).type.toBeCallableWith("counts.1")
		expect($.eq).type.toBeCallableWith("counts.1", "a")
		expect($.eq).type.not.toBeCallableWith("counts.1", 1)
	})

	it("gives the value type of a number key of the principal", () => {
		class Counter extends Schema.Class<Counter>("Counter")({
			counts: Schema.Record(Schema.Finite, Schema.String),
		}) {}
		const Sheet = Resource.make("Sheet", {
			actions: ["read"],
			fields: { level: Schema.Finite, name: Schema.String },
		})
		const $ = Condition.builder<Resource.Data<typeof Sheet>, unknown, Counter>()
		expect($.principal("counts.1")).type.toBe<Condition.Ref<string, Counter>>()
		expect($.eq).type.toBeCallableWith("name", $.principal("counts.1"))
		expect($.eq).type.not.toBeCallableWith("level", $.principal("counts.1"))
	})

	it("does not read below a field that may hold a list or a date", () => {
		const Item = Resource.make("MixedItem", {
			actions: ["read"],
			fields: {
				listed: Schema.Union([
					Schema.Array(Schema.String),
					Schema.Struct({ flag: Schema.String }),
				]),
				dated: Schema.Union([
					Schema.Date,
					Schema.Struct({ flag: Schema.String }),
				]),
			},
		})
		const $ = Condition.builder<Resource.Data<typeof Item>, unknown, Caller>()
		expect($.eq).type.not.toBeCallableWith("listed.flag", "a")
		expect($.eq).type.not.toBeCallableWith("dated.flag", "a")
		expect($.exists).type.toBeCallableWith("dated")
		const _ = Policy.builder(
			Domain.make({ principal: Caller, resources: [Item] }),
		)
		expect(_.deny).type.toBeCallableWith("read", Item, {
			fields: ["dated.flag"],
		})
	})

	it("gives the value type of a field in each branch of a union", () => {
		const Item = Resource.make("FlagItem", {
			actions: ["read"],
			fields: {
				data: Schema.Union([
					Schema.String,
					Schema.Struct({ flag: Schema.String }),
				]),
			},
		})
		const $ = Condition.builder<Resource.Data<typeof Item>, unknown, Caller>()
		expect<
			Condition.PathValue<Resource.Data<typeof Item>, "data.flag">
		>().type.toBe<string | null>()
		expect($.eq).type.toBeCallableWith("data.flag", "a")
		expect($.eq).type.toBeCallableWith("data.flag", null)
		expect($.eq).type.not.toBeCallableWith("data.flag", 1)
	})

	it("takes a field that holds a string or a struct", () => {
		const Item = Resource.make("Item", {
			actions: ["read"],
			fields: {
				settings: Schema.Union([
					Schema.String,
					Schema.Struct({ secret: Schema.String }),
				]),
			},
		})
		const Items = Domain.make({ principal: Caller, resources: [Item] })
		const _ = Policy.builder(Items)
		expect(_.deny).type.toBeCallableWith("read", Item, { fields: ["settings"] })
		expect(_.deny).type.toBeCallableWith("read", Item, {
			fields: ["settings.secret"],
		})
		const policy = Policy.define(Items)(function* (_) {
			yield* _.allow("read", Item)
		})
		expect(Policy.decideSync).type.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: Item.make({ settings: "open" }),
			field: "settings",
		})
	})

	it("takes a struct at the last part of a path as one field of a request", () => {
		const Deep = Resource.make("DeepNote", {
			actions: ["read"],
			fields: {
				a: Schema.Struct({
					b: Schema.Struct({
						c: Schema.Struct({
							d: Schema.Struct({
								e: Schema.Struct({ secret: Schema.String }),
							}),
						}),
					}),
				}),
			},
		})
		const Deeps = Domain.make({ principal: Caller, resources: [Deep] })
		const policy = Policy.define(Deeps)(function* (_) {
			yield* _.allow("read", Deep, { fields: ["a.b.c.d.e"] })
		})
		expect(Policy.decideSync).type.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: Deep.make({
				a: { b: { c: { d: { e: { secret: "s" } } } } },
			}),
			field: "a.b.c.d.e",
		})
		expect(Policy.decideSync).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: Deep.make({
				a: { b: { c: { d: { e: { secret: "s" } } } } },
			}),
			field: "a.b.c.d",
		})
	})

	it("takes a record as one field of a request", () => {
		const Tagged = Resource.make("Tagged", {
			actions: ["read"],
			fields: { tags: Schema.Record(Schema.String, Schema.String) },
		})
		const Tags = Domain.make({ principal: Caller, resources: [Tagged] })
		const policy = Policy.define(Tags)(function* (_) {
			yield* _.allow("read", Tagged, { fields: ["tags"] })
		})
		expect(Policy.decideSync).type.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: Tagged.make({ tags: {} }),
			field: "tags",
		})
	})

	it("takes no predicate in Policy.rule", () => {
		const rule = Policy.builder(App).allow("read", Bot, {
			when: ($) => $.predicate("named", (bot) => bot.name !== ""),
		})
		expect(Policy.rule).type.not.toBeCallableWith({
			...rule,
			resources: ["Trigger"],
		})
		expect(Policy.rule).type.toBeCallableWith({
			_tag: "Allow",
			actions: ["read"],
			resources: ["Trigger"],
		})
	})

	it("keeps the predicates of a policy with a mark of the type unknown", () => {
		const widened: Policy.Policy<App, unknown> = Policy.define(App)(
			function* (_) {
				yield* _.allow("read", Bot)
			},
		)
		expect(Policy.decideSync).type.not.toBeCallableWith(widened, {
			principal: alice,
			action: "read",
			resource: aliceBot,
		})
		// Its services may be anything, so no context can give them all.
		expect(Policy.provideContext).type.not.toBeCallableWith(
			widened,
			Context.empty(),
		)
		expect<Condition.ErrorOf<unknown>>().type.toBe<unknown>()
		const asObject: Policy.Policy<App, object> = Policy.define(App)(
			function* (_) {
				yield* _.allow("read", Bot, {
					when: ($) => $.predicate("named", (bot) => bot.name !== ""),
				})
			},
		)
		expect(Policy.decideSync).type.not.toBeCallableWith(asObject, {
			principal: alice,
			action: "read",
			resource: aliceBot,
		})
		expect<Condition.ServicesOf<object>>().type.toBe<unknown>()
		expect<Condition.Provided<object>>().type.toBe<Condition.Opaque<unknown>>()
		// A plain mark and a mark of predicates keep their types.
		expect<Condition.ErrorOf<never>>().type.toBe<never>()
		expect<Condition.ErrorOf<Condition.Opaque<"e", "r">>>().type.toBe<"e">()
	})

	it("keeps an Exit as one field, as the catalog does", () => {
		const Job = Resource.make("Job", {
			actions: ["read"],
			fields: {
				result: Schema.Exit(Schema.String, Schema.String, Schema.Defect()),
			},
		})
		const Jobs = Domain.make({ principal: Caller, resources: [Job] })
		const $ = Condition.builder<
			Policy.DataFor<typeof Jobs, "Job">,
			unknown,
			Caller
		>()
		expect($.exists).type.toBeCallableWith("result")
		expect($.exists).type.not.toBeCallableWith("result._tag")
	})

	it("checks the extra data", () => {
		expect(_.allow).type.toBeCallableWith("read", Bot, {
			meta: { scope: "once" },
		})
		expect(_.allow).type.not.toBeCallableWith("read", Bot, {
			meta: { scope: "forever" },
		})
	})
})

describe("Policy", () => {
	const policy = Policy.define(App)(function* (_) {
		yield* _.allow("read", Bot)
	})
	class Quota extends Context.Service<Quota, number>()(
		"@nmnmcc/ability/tests/Ability.tst/Quota",
	) {}
	const effectful = Policy.define(App)(function* (_) {
		yield* _.allow("read", Bot, {
			when: ($) =>
				$.predicate("quota", () =>
					Effect.flatMap(Quota, (left) =>
						left > 0 ? Effect.succeed(true) : Effect.fail("empty" as const),
					),
				),
		})
	})

	it("does not take a node made by hand", () => {
		expect(Policy.builder(App).allow).type.not.toBeCallableWith("read", Bot, {
			when: (
				$: Condition.Builder<Policy.DataFor<App, "Bot">, Bot, Caller>,
			) => ({
				_tag: "Not" as const,
				condition: $.predicate("quota", () => Effect.fail("empty" as const)),
			}),
		})
	})

	it("does not take a copy of a rule made with a spread", () => {
		const rule = Policy.builder(App).allow("read", Bot)
		const copy = { ...rule }
		expect(Policy.define(App)).type.not.toBeCallableWith(function* () {
			yield copy
		})
		expect(Policy.define(App)).type.toBeCallableWith(function* () {
			yield rule
		})
		expect<Policy.AnyRule>().type.not.toBeAssignableFrom(copy)
	})

	it("takes only rules of its own domain", () => {
		const Other = Domain.make({ principal: Caller, resources: [Trigger] })
		const rule = Policy.builder(App).allow("read", Bot)
		expect(Policy.define(App)).type.toBeCallableWith(function* () {
			yield* rule
		})
		expect(Policy.define(Other)).type.not.toBeCallableWith(function* () {
			yield* rule
		})
	})

	it("does not take a policy or a rule with no type fields", () => {
		const named = Condition.builder<
			Policy.DataFor<App, "Bot">,
			Bot,
			Caller
		>().predicate("named", (bot) => bot.name.length > 0)
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: () => named })
		})
		const bare: Omit<typeof policy, "~Opaque"> = policy
		expect(Policy.all).type.not.toBeCallableWith([bare])
		expect(Policy.all).type.toBeCallableWith([policy])
		const rule = Policy.builder(App).allow("read", Bot, { when: () => named })
		const bareRule: Omit<typeof rule, "~Opaque"> = rule
		// A rule gives itself with all its types, so `yield*` keeps them.
		expect(
			Policy.define(App)(function* () {
				yield* bareRule
			}),
		).type.toBe<Policy.Policy<App, Condition.Opaque>>()
		expect(Policy.define(App)).type.toBeCallableWith(function* () {
			yield* rule
		})
	})

	it("keeps the domain of a policy", () => {
		const Other = Domain.make({ principal: Caller, resources: [Bot] })
		const other = emptyOf(Other)
		expect<Policy.Policy<App>>().type.not.toBeAssignableFrom(other)
	})

	it("takes only common actions for one target of a union type", () => {
		const _ = Policy.builder(App)
		const target = Bot as typeof Bot | typeof Trigger
		expect(_.allow).type.toBeCallableWith("read", target)
		expect(_.allow).type.not.toBeCallableWith("write", target)
		expect(_.allow).type.toBeCallableWith("write", [Bot, Trigger])
	})

	it("takes the shapes of a target that may be one value or a list", () => {
		const _ = Policy.builder(App)
		const target = Bot as typeof Bot | ReadonlyArray<typeof Trigger>
		expect(_.allow).type.toBeCallableWith("read", target)
		expect(_.allow).type.not.toBeCallableWith("update", target)
		expect(_.allow).type.not.toBeCallableWith("write", target)
		const named = Condition.builder<
			Policy.DataFor<App, "Bot">,
			Bot,
			Caller
		>().predicate("named", (bot) => bot.name.length > 0)
		expect(_.allow).type.toBeCallableWith("read", Bot, { when: () => named })
		expect(_.allow).type.not.toBeCallableWith("read", target, {
			when: () => named,
		})
	})

	it("does not let the test of a predicate node be called with any value", () => {
		const named = Condition.builder<unknown, Bot, Caller>().predicate(
			"named",
			(bot) => bot.name.length > 0,
		)
		if (named._tag === "Predicate") {
			expect(named.run).type.not.toBeCallableWith(aliceTrigger, alice)
		}
	})

	it("keeps a predicate in rules of its own kind", () => {
		const _ = Policy.builder(App)
		const leveled = Condition.builder<
			Policy.DataFor<App, "Bot">,
			Bot,
			Caller
		>().predicate("leveled", (bot) => bot.level >= 1)
		expect(_.deny).type.toBeCallableWith("read", Bot, { when: () => leveled })
		expect(_.deny).type.not.toBeCallableWith("read", Trigger, {
			when: () => leveled,
		})
	})

	it("ties the types of a node to its children", () => {
		const failing = Condition.builder<unknown, Bot, Caller>().predicate(
			"failing",
			() => Effect.fail("no" as const),
		)
		expect<Condition.Condition>().type.not.toBeAssignableFrom({
			...Condition.always,
			_tag: "Not" as const,
			condition: failing,
		})
		expect<Condition.Condition>().type.not.toBeAssignableFrom({
			...Condition.always,
			_tag: "Predicate" as const,
			name: "hidden",
			run: () => Effect.fail("no" as const),
		})
	})

	it("encodes a plain condition from a builder and a residual", () => {
		const $ = Condition.builder<
			{ readonly id: string },
			{ readonly id: string },
			{}
		>()
		expect(Schema.encodeSync(Condition.schema)).type.toBeCallableWith(
			$.eq("id", "i"),
		)
		const residual = Policy.residual(emptyOf(App), {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		expect(Schema.encodeSync(Condition.schema)).type.toBeCallableWith(residual)
		expect(Schema.encodeSync(Condition.schema)).type.not.toBeCallableWith(
			$.predicate("p", () => true),
		)
	})

	it("does not take the test of a predicate that reads other values", () => {
		const _ = Policy.builder(App)
		const named = Condition.builder<
			Policy.DataFor<App, "Bot">,
			Bot,
			Caller
		>().predicate("named", (bot) => bot.name.length > 0)
		const enabled = Condition.builder<
			Policy.DataFor<App, "Trigger">,
			typeof aliceTrigger,
			Caller
		>().predicate("enabled", (trigger) => trigger.enabled)
		if (named._tag === "Predicate" && enabled._tag === "Predicate") {
			const swapped = { ...named, run: enabled.run }
			expect(_.allow).type.not.toBeCallableWith("read", Bot, {
				when: () => swapped,
			})
			expect(_.allow).type.toBeCallableWith("read", Bot, {
				when: () => named,
			})
			const plain = {
				...named,
				run: (trigger: typeof aliceTrigger) => Effect.succeed(trigger.enabled),
			}
			expect(_.allow).type.not.toBeCallableWith("read", Bot, {
				when: () => plain,
			})
		}
	})

	it("keeps what the condition of a rule reads", () => {
		const _ = Policy.builder(App)
		const rule = _.allow("read", Bot, {
			when: ($) => $.predicate("level", (bot) => bot.level !== 0),
		})
		expect(_.allow).type.not.toBeCallableWith("read", Trigger, {
			when: () => rule.when ?? Condition.never,
		})
	})

	it("needs the principal that a predicate reads in partial", () => {
		const named = Condition.builder<unknown, Bot, Caller>().predicate(
			"named",
			(_, user) => user.userId.length > 0,
		)
		expect(Condition.partial).type.toBeCallableWith(named, {
			principal: alice,
		})
		expect(Condition.partial).type.not.toBeCallableWith(named, {
			principal: {},
		})
	})

	it("does not take a residual of an action that the kind has not", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("named", (bot) => bot.name !== ""),
			})
		})
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		expect(Condition.evaluate).type.not.toBeCallableWith(residual, {
			value: aliceTrigger,
		})
		expect(Policy.residual).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "fly",
			kind: "Bot",
		})
	})
	it("takes a scope only with the policy first", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		})
		expect(
			Policy.coverage(policy, {
				principal: alice,
				action: "read",
				kind: "Bot",
				within: ($) => $.eq("ownerUserId", $.principal("userId")),
			}),
		).type.toBe<Policy.Coverage<Policy.ResidualReads<App, "Bot">, never>>()
		expect(Policy.residual).type.not.toBeCallableWith({
			principal: alice,
			action: "read",
			kind: "Bot",
			within: (_: any) => Condition.always,
		})
	})

	it("keeps the resource of a plain test", () => {
		const _ = Policy.builder(App)
		const enabled = Condition.builder<
			Policy.DataFor<App, "Trigger">,
			Policy.ValueFor<App, "Trigger">,
			Caller
		>().eq("enabled", true)
		expect(_.allow).type.toBeCallableWith("read", "Trigger", {
			when: () => enabled,
		})
		expect(_.allow).type.not.toBeCallableWith("read", Bot, {
			when: () => enabled,
		})
	})

	it("does not let a condition from a node go into another rule", () => {
		const _ = Policy.builder(App)
		const node = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("level", (bot) => bot.level !== 0),
			})
		}).node
		if (node._tag === "Rules") {
			const when = node.rules[0]!.when!
			expect(_.allow).type.not.toBeCallableWith("read", "Trigger", {
				when: () => when,
			})
		}
	})

	it("keeps the principal of a test with a principal field", () => {
		class Numbered extends Schema.Class<Numbered>("Numbered")({
			userId: Schema.Finite,
		}) {}
		const Other = Domain.make({ principal: Numbered, resources: [Bot] })
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		const owned = $.eq("ownerUserId", $.principal("userId"))
		expect(Policy.builder(Other).deny).type.not.toBeCallableWith("read", Bot, {
			when: () => owned,
		})
	})

	it("keeps the principal of a reference from another builder", () => {
		class Numbered extends Schema.Class<Numbered>("Numbered")({
			userId: Schema.Finite,
			name: Schema.String,
		}) {}
		const Other = Domain.make({ principal: Numbered, resources: [Bot] })
		const foreign = Condition.builder<unknown, unknown, Caller>().principal(
			"userId",
		)
		expect(Policy.builder(Other).deny).type.not.toBeCallableWith("read", Bot, {
			when: (
				$: Condition.Builder<
					Policy.DataFor<typeof Other, "Bot">,
					Bot,
					Numbered
				>,
			) => $.eq("ownerUserId", foreign),
		})
	})

	it("does not let a reference with no principal type go into a rule", () => {
		const id: Condition.Ref<string> = Condition.builder<
			unknown,
			unknown,
			Caller
		>().principal("userId")
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		expect($.eq).type.not.toBeCallableWith("ownerUserId", id)
	})

	it("takes a value that fits every field of a union of fields", () => {
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		const either = "level" as "level" | "name"
		expect($.ne).type.not.toBeCallableWith(either, "blocked")
		expect($.ne).type.toBeCallableWith("name", "blocked")
	})

	it("lets a rule name an array field", () => {
		const Doc = Resource.make("Doc", {
			actions: ["read"],
			fields: { secrets: Schema.Array(Schema.String) },
		})
		const Docs = Domain.make({ principal: Caller, resources: [Doc] })
		expect(Policy.builder(Docs).deny).type.toBeCallableWith("read", Doc, {
			fields: ["secrets"],
		})
	})

	it("does not take a node with children of other types", () => {
		const base = Condition.and()
		const named = Condition.builder<unknown, Bot, Caller>().predicate(
			"named",
			(bot) => bot.name.length > 0,
		)
		if (base._tag === "And") {
			const spread = { ...base, conditions: [named] }
			expect(Condition.and).type.not.toBeCallableWith(spread)
			expect(Condition.and).type.not.toBeCallableWith(
				spread as typeof spread | typeof Condition.always,
			)
		}
	})

	it("takes an Effect value type as one field", () => {
		const Price = Resource.make("Price", {
			actions: ["read"],
			fields: { cost: Schema.BigDecimal },
		})
		const Prices = Domain.make({ principal: Caller, resources: [Price] })
		const _ = Policy.builder(Prices)
		expect(_.deny).type.toBeCallableWith("read", Price, { fields: ["cost"] })
		expect(_.deny).type.not.toBeCallableWith("read", Price, {
			fields: ["cost.scale"],
		})
	})

	it("takes a result, a file and form data as one field", () => {
		const Item = Resource.make("Item", {
			actions: ["read"],
			fields: {
				result: Schema.Result(Schema.String, Schema.String),
				file: Schema.File,
				form: Schema.FormData,
			},
		})
		const Items = Domain.make({ principal: Caller, resources: [Item] })
		const _ = Policy.builder(Items)
		expect(_.deny).type.toBeCallableWith("read", Item, {
			fields: ["result", "file", "form"],
		})
		expect(_.deny).type.not.toBeCallableWith("read", Item, {
			fields: ["result._tag"],
		})
		expect(_.deny).type.not.toBeCallableWith("read", Item, {
			fields: ["file.name"],
		})
	})

	it("takes only a value that a field of each kind can hold", () => {
		const $ = Condition.builder<
			{ readonly owner: string } | { readonly owner: number },
			unknown,
			Caller
		>()
		expect($.eq).type.not.toBeCallableWith("owner", "alice")
		expect($.eq).type.not.toBeCallableWith("owner", 1)
	})

	it("does not go into a map in a field path", () => {
		const $ = Condition.builder<
			{ readonly roles: ReadonlyMap<string, string> },
			unknown,
			Caller
		>()
		expect($.exists).type.toBeCallableWith("roles")
		expect($.gt).type.not.toBeCallableWith("roles.size", 0)
	})

	it("checks each member of a union of inputs", () => {
		const named = Condition.builder<unknown, Bot, Caller>().predicate(
			"named",
			(bot) => bot.name.length > 0,
		)
		const input = { value: aliceBot, principal: alice } as
			| { readonly value: Bot; readonly principal: Caller }
			| { readonly value: typeof aliceTrigger; readonly principal: Caller }
		expect(Condition.evaluate).type.not.toBeCallableWith(named, input)
		const request = { principal: alice, action: "read", kind: "Bot" } as
			| {
					readonly principal: Caller
					readonly action: "read"
					readonly kind: "Bot"
			  }
			| {
					readonly principal: Caller
					readonly action: "fly"
					readonly kind: "Bot"
			  }
		expect(Policy.residual).type.not.toBeCallableWith(emptyOf(App), request)
	})

	it("keeps the domain of the rules of a node", () => {
		const Other = Domain.make({ principal: Caller, resources: [Bot] })
		const node = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		}).node
		if (node._tag === "Rules") {
			// The rules of a node have no types, so they go into no policy.
			expect(Policy.define(Other)).type.not.toBeCallableWith(function* () {
				yield* node.rules
			})
		}
	})

	it("does not let a residual for a union of kinds read either value", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("level", (bot) => bot.level !== 0),
			})
		})
		const of = (kind: "Bot" | "Trigger") =>
			Policy.residual(policy, { principal: alice, action: "read", kind })
		expect(Condition.evaluate).type.not.toBeCallableWith(of("Bot"), {
			value: aliceTrigger,
		})
	})

	it("does not let evaluateSync test a value of another kind", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		})
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		expect(Condition.evaluateSync).type.toBeCallableWith(residual, {
			value: aliceBot,
		})
		expect(Condition.evaluateSync).type.not.toBeCallableWith(residual, {
			value: aliceTrigger,
		})
	})

	it("keeps the kind of a residual", () => {
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
		expect(Condition.evaluate).type.toBeCallableWith(residual, {
			value: aliceBot,
		})
		expect(Condition.evaluate).type.not.toBeCallableWith(residual, {
			value: aliceTrigger,
		})
	})

	it("does not take a node made by hand as the node of a policy", () => {
		const quota = Policy.builder(App).allow("read", Bot, {
			when: ($) => $.predicate("quota", () => Effect.map(Quota, (n) => n > 0)),
		})
		expect<Policy.Node>().type.not.toBeAssignableFrom({
			_tag: "Rules" as const,
			algorithm: "denyOverrides" as const,
			rules: [quota],
		})
	})
	it("does not let the node of a policy go into a policy of other types", () => {
		expect<Policy.Policy<App>>().type.not.toBeAssignableFrom({
			...emptyOf(App),
			node: effectful.node,
		})
	})

	it("does not let a reference with no type stand for any field", () => {
		const $ = Condition.builder<Policy.DataFor<App, "Bot">, Bot, Caller>()
		const ref: Condition.PrincipalRef = $.principal("role")
		expect($.ne).type.not.toBeCallableWith("level", ref)
	})

	it("gives a predicate what it reads", () => {
		const leveled = Condition.builder<unknown, Bot, Caller>().predicate(
			"leveled",
			(bot) => bot.level >= 1,
		)
		expect(Condition.evaluate).type.toBeCallableWith(leveled, {
			value: aliceBot,
			principal: alice,
		})
		expect(Condition.evaluate).type.not.toBeCallableWith(leveled, {
			value: aliceTrigger,
			principal: alice,
		})
	})

	it("takes only principal fields with a scalar type", () => {
		const $ = Condition.builder<
			{ readonly owner: string },
			unknown,
			{ readonly id: bigint; readonly name: string }
		>()
		expect($.principal).type.toBeCallableWith("name")
		expect($.principal).type.not.toBeCallableWith("id")
	})

	it("takes only a meta Schema with no services", () => {
		class Store extends Context.Service<Store, number>()(
			"@nmnmcc/ability/tests/Ability.tst/Store",
		) {}
		const meta = Schema.String as unknown as Schema.Codec<
			string,
			string,
			Store,
			never
		>
		expect(Domain.make).type.not.toBeCallableWith({
			principal: Caller,
			resources: [Bot],
			meta,
		})
	})

	it("keeps the types of predicates", () => {
		const rule = Policy.builder(App).allow("read", Bot, {
			when: ($) => $.predicate("quota", () => Effect.fail("empty" as const)),
		})
		expect(rule.when).type.toBe<
			| Condition.Condition<
					Condition.Reads<Bot & { readonly _tag: "Bot" }, Caller>,
					Condition.Opaque<"empty">
			  >
			| undefined
		>()
		expect(policy).type.toBe<Policy.Policy<App>>()
		expect(effectful).type.toBe<
			Policy.Policy<App, Condition.Opaque<"empty", Quota>>
		>()
		expect(
			Policy.decide(effectful, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			}),
		).type.toBe<Effect.Effect<Decision.Decision, "empty", Quota>>()
		expect(Policy.all([policy, effectful])).type.toBe<
			Policy.Policy<App, Condition.Opaque<"empty", Quota>>
		>()
	})

	it("takes only requests of the domain", () => {
		expect(Policy.decideSync).type.toBeCallableWith(policy, {
			principal: alice,
			action: "update",
			resource: aliceBot,
			field: "settings.secret",
		})
		expect(Policy.decideSync).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "write",
			resource: aliceBot,
		})
		expect(Policy.decideSync).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: aliceBot,
			field: "color",
		})
		expect(Policy.residual).type.toBeCallableWith(policy, {
			principal: alice,
			action: "write",
			kind: "Trigger",
		})
		expect(Policy.permittedFields).type.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: aliceBot,
		})
		expect(Policy.permittedFields).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "write",
			resource: aliceBot,
		})
	})

	it("lets decideSync and the schema take only plain policies", () => {
		expect(Policy.decideSync).type.not.toBeCallableWith(effectful, {
			principal: alice,
			action: "read",
			resource: aliceBot,
		})
		expect(Schema.encodeSync(Policy.schema(App))).type.toBeCallableWith(policy)
		expect(Schema.encodeSync(Policy.schema(App))).type.not.toBeCallableWith(
			effectful,
		)
	})
})

describe("Authorizer", () => {
	class Identity extends Context.Service<Identity, Caller>()(
		"@nmnmcc/ability/tests/Ability.tst/Identity",
	) {}
	// The principal gives the error type and the service type of the checks.
	const session: Effect.Effect<Caller, "no session", Identity> = Identity
	class Auth extends Authorizer.Service<Auth>()(
		"@nmnmcc/ability/tests/Ability.tst/Auth",
		{ domain: App, principal: session },
	) {}

	it("puts the errors and services into a check", () => {
		expect(Auth.check({ action: "update", resource: aliceBot })).type.toBe<
			Effect.Effect<
				void,
				| Authorizer.Forbidden
				| Authorizer.Pending
				| Authorizer.PolicyUnavailable
				| "no session",
				Identity | Auth
			>
		>()
		expect(Auth.check).type.toBeCallableWith({
			action: "write",
			kind: "Trigger",
		})
		expect(Auth.check).type.not.toBeCallableWith({
			action: "write",
			resource: aliceBot,
		})
		expect(Auth.permittedFields).type.not.toBeCallableWith({
			action: "write",
			resource: aliceBot,
		})
	})

	it("takes a value or a kind, not both", () => {
		// A variable, so the check of extra keys of a literal does not run.
		const target = {
			action: "write",
			kind: "Trigger",
			resource: aliceBot,
		} as const
		expect(Auth.check).type.not.toBeCallableWith(target)
	})

	it("takes only a read action of the kind of the target", () => {
		expect(Auth.guard).type.toBeCallableWith(
			{ action: "update", resource: aliceBot },
			{ hide: () => "hidden" },
		)
		expect(Auth.guard).type.not.toBeCallableWith(
			{ action: "update", resource: aliceBot },
			{ read: "write", hide: () => "hidden" },
		)
	})

	it("needs a read action of every kind of a union target", () => {
		const target = { action: "update", resource: aliceBot } as
			| Policy.Target<App>
			| { readonly action: "write"; readonly resource: typeof aliceTrigger }
		expect(Auth.guard).type.not.toBeCallableWith(target, {
			read: "update",
			hide: () => "hidden",
		})
	})

	it("takes only an action of every kind of a requirement", () => {
		const loose = (kind: "Bot" | "Trigger") =>
			expect(HttpApi.requires).type.not.toBeCallableWith(Auth, "delete", kind)
		loose("Bot")
		expect(HttpApi.requires).type.toBeCallableWith(Auth, "delete", "Bot")
	})

	it("keeps a loaded policy opaque", () => {
		const policy = Effect.gen(function* () {
			const auth = yield* Auth
			return yield* auth.policy
		})
		expect(policy).type.toBe<
			Effect.Effect<
				Policy.Policy<App, Condition.Opaque<"no session">>,
				Authorizer.PolicyUnavailable | "no session",
				Identity | Auth
			>
		>()
	})

	it("types the scope of a target", () => {
		type CheckOf = Effect.Effect<
			void,
			| Authorizer.Forbidden
			| Authorizer.Pending
			| Authorizer.PolicyUnavailable
			| "no session",
			Identity | Auth
		>
		expect(
			Auth.check({
				action: "update",
				kind: "Bot",
				within: ($) => $.under("org", $.principal("organizationId")),
			}),
		).type.toBe<CheckOf>()
		expect(
			Auth.check({
				action: "update",
				kind: "Bot",
				within: ($) => $.and($.eq("level", 2), $.exists("ownerUserId")),
			}),
		).type.toBe<CheckOf>()
		const otherField = Auth.check({
			action: "update",
			kind: "Bot",
			// @ts-expect-error Argument of type '"enabled"'
			within: ($) => $.eq("enabled", true),
		})
		const otherType = Auth.check({
			action: "update",
			kind: "Bot",
			// @ts-expect-error 'OperandOf<number, any>'
			within: ($) => $.eq("level", "high"),
		})
		expect(otherField).type.toBe<CheckOf>()
		expect(otherType).type.toBe<CheckOf>()
		const enabled = Condition.builder<
			Policy.DataFor<App, "Trigger">,
			Policy.ValueFor<App, "Trigger">,
			Caller
		>().eq("enabled", true)
		expect(Auth.check).type.not.toBeCallableWith({
			action: "update",
			kind: "Bot",
			within: () => enabled,
		})
		expect(Auth.check).type.not.toBeCallableWith({
			action: "update",
			kind: "Bot",
			within: ($: Condition.Builder<Policy.DataFor<App, "Bot">, Bot, Caller>) =>
				$.predicate("shared", (bot) => bot.shared),
		})
		const robot = Condition.builder<
			object,
			object,
			{ readonly robotId: string }
		>().principal("robotId")
		expect(Auth.check).type.not.toBeCallableWith({
			action: "update",
			kind: "Bot",
			within: ($: Condition.Builder<Policy.DataFor<App, "Bot">, Bot, Caller>) =>
				$.eq("name", robot),
		})
	})

	it("gives the coverage of a scope", () => {
		expect(
			Auth.coverage({
				action: "read",
				kind: "Bot",
				within: ($) => $.under("org", "acme"),
			}),
		).type.toBe<
			Effect.Effect<
				Policy.Coverage<
					Policy.ResidualReads<App, "Bot">,
					Condition.Opaque<"no session">
				>,
				Authorizer.PolicyUnavailable | "no session",
				Identity | Auth
			>
		>()
	})

	it("takes a scope in HttpApi with the fields of the kind", () => {
		expect(HttpApi.requires).type.toBeCallableWith(Auth, "update", "Bot", {
			within:
				(params: HttpApi.Params) =>
				($: Condition.Builder<Policy.DataFor<App, "Bot">, Bot, Caller>) =>
					$.under("org", params["org"] ?? null),
		})
		expect(HttpApi.lists).type.not.toBeCallableWith(Auth, "read", "Bot", {
			within:
				() =>
				(
					$: Condition.Builder<Policy.DataFor<App, "Trigger">, object, Caller>,
				) =>
					$.eq("enabled", true),
		})
	})

	it("checks the options of the layer", () => {
		expect(Authorizer.layer).type.toBeCallableWith(Auth, {
			policy: () => Effect.succeed(emptyOf(App)),
		})
		expect(Authorizer.layer).type.not.toBeCallableWith(Auth, {
			policy: () => Effect.succeed(emptyOf(App)),
			decider: () => Effect.fail("other error" as const),
		})
	})

	it("takes only a principal of the domain", () => {
		expect(Authorizer.Service<never>()).type.not.toBeCallableWith("x", {
			domain: App,
			principal: Effect.succeed("not a caller"),
		})
	})
})
