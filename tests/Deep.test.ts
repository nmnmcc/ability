// A test gives its own layer, so it uses Effect.provide.
// @effect-diagnostics strictEffectProvide:off
import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Context, Effect, Exit, Schema } from "effect"
import {
	Authorizer,
	Condition,
	Domain,
	Policy,
	Resource,
} from "../src/index.ts"
import { alice, aliceBot, App, Bot } from "./fixtures.ts"

// Each test sends a very deep input through the public functions. A walk that
// called itself for each level would fill the stack here. A walk of more than
// 200 levels runs in the run loop of an Effect, which is slower, so each test
// has more time.
const levels = 5000

/** A condition of `levels` levels of `And` and `Or`, each with a test. */
const deepCondition = (): unknown =>
	Arr.reduce(
		Arr.range(1, levels),
		{
			_tag: "Compare",
			op: "eq",
			field: "name",
			value: { _tag: "Literal", value: "n" },
		} as unknown,
		(inner, level) => ({
			_tag: level % 2 === 0 ? "And" : "Or",
			conditions: [
				inner,
				{
					_tag: "Compare",
					op: "ne",
					field: "id",
					value: { _tag: "Literal", value: `i${String(level)}` },
				},
			],
		}),
	)

describe("Deep inputs", () => {
	it(
		"walks a very deep condition with every function of Condition",
		{ timeout: 60_000 },
		() => {
			const condition = Schema.decodeUnknownSync(Condition.schema)(
				deepCondition(),
			)
			const value = { name: "n", id: "x" }
			const test = Condition.evaluateSync(condition, { value })
			assert.strictEqual(
				Effect.runSync(Condition.evaluate(condition, { value })),
				test,
			)
			const simple = Condition.simplify(condition)
			assert.strictEqual(Condition.evaluateSync(simple, { value }), test)
			const partial = Condition.partial(condition, {})
			assert.strictEqual(Condition.evaluateSync(partial, { value }), test)
			assert.deepStrictEqual(Condition.fields(condition), ["name", "id"])
			assert.include(
				["Satisfiable", "Unsatisfiable", "Unknown"],
				Condition.satisfiable(condition)._tag,
			)
			const count = Effect.runSync(
				Condition.fold(condition, {
					true: () => 0,
					false: () => 0,
					compare: () => 1,
					in: () => 1,
					exists: () => 1,
					and: (parts) => Arr.reduce(parts, 0, (total, part) => total + part),
					or: (parts) => Arr.reduce(parts, 0, (total, part) => total + part),
					not: (part) => part,
				}),
			)
			// One test at the bottom, and one at each level.
			assert.strictEqual(count, levels + 1)
			const again = condition.pipe(
				Schema.encodeSync(Condition.schema),
				Schema.decodeSync(Condition.schema),
			)
			assert.strictEqual(Condition.evaluateSync(again, { value }), test)
		},
	)

	it(
		"decides, explains and analyses a policy with a very deep condition",
		{ timeout: 60_000 },
		() => {
			const policy = Schema.decodeUnknownSync(Policy.schema(App))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Bot"],
						when: deepCondition(),
					},
				],
			})
			const request = {
				principal: alice,
				action: "read",
				resource: aliceBot,
			} as const
			const decision = Policy.decideSync(policy, request)._tag
			assert.strictEqual(
				Effect.runSync(Policy.explain(policy, request)).decision._tag,
				decision,
			)
			const kind = { principal: alice, action: "read", kind: "Bot" } as const
			const residual = Policy.residual(policy, kind)
			assert.strictEqual(
				Condition.evaluateSync(residual, { value: aliceBot }),
				decision === "Allow",
			)
			assert.include(
				["All", "None", "Some", "Unknown"],
				Policy.coverage(policy, kind)._tag,
			)
			assert.isArray(
				Effect.runSync(
					Policy.permittedFields(policy, {
						principal: alice,
						action: "read",
						resource: aliceBot,
					}),
				),
			)
			const json = Schema.encodeSync(Policy.schema(App))(policy)
			assert.isTrue(Exit.isSuccess(Schema.decodeExit(Policy.schema(App))(json)))
		},
	)

	it("runs a very deep tree with a predicate, and gives it services", () => {
		class Gate extends Context.Service<Gate, boolean>()(
			"@nmnmcc/ability/tests/Deep.test/Gate",
		) {}
		const gated = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) =>
					$.predicate("gate", () => Effect.map(Gate, (open) => open)),
			})
		})
		const deep = Arr.reduce(
			Arr.range(1, levels),
			gated as Policy.Policy<typeof App, Condition.Opaque<never, Gate>>,
			(inner, level) =>
				level % 2 === 0 ? Policy.all([inner]) : Policy.firstOf([inner]),
		)
		const provided = Policy.provideContext(deep, Context.make(Gate, true))
		assert.strictEqual(
			Effect.runSync(
				Policy.decide(provided, {
					principal: alice,
					action: "read",
					resource: aliceBot,
				}),
			)._tag,
			"Allow",
		)
	})

	it("checks a request with a deep principal in an Authorizer", () => {
		interface Chain {
			readonly id: string
			readonly next: Chain | null
		}
		const Chain: Schema.Codec<Chain> = Schema.Struct({
			id: Schema.String,
			next: Schema.NullOr(Schema.suspend((): Schema.Codec<Chain> => Chain)),
		})
		const Item = Resource.make("Item", {
			actions: ["read"],
			fields: { name: Schema.String },
		})
		const Items = Domain.make({ principal: Chain, resources: [Item] })
		class CurrentChain extends Context.Service<CurrentChain, Chain>()(
			"@nmnmcc/ability/tests/Deep.test/CurrentChain",
		) {}
		class ItemAuth extends Authorizer.Service<ItemAuth>()("test/ItemAuth", {
			domain: Items,
			principal: CurrentChain,
		}) {}
		const layer = Authorizer.layer(ItemAuth, {
			policy: () =>
				Effect.succeed(
					Policy.define(Items)(function* (_) {
						yield* _.allow("read", Item)
					}),
				),
		})
		const principal = Arr.reduce(
			Arr.range(1, 2000),
			{ id: "0", next: null } as Chain,
			(next, index): Chain => ({ id: String(index), next }),
		)
		const exit = Effect.runSyncExit(
			ItemAuth.check({
				action: "read",
				resource: Item.make({ name: "a" }),
			}).pipe(
				Effect.provideService(CurrentChain, principal),
				Effect.provide(layer),
			),
		)
		assert.isTrue(Exit.isSuccess(exit))
	})
})
