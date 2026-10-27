import { assert, describe, it } from "@effect/vitest"
import {
	Array as Arr,
	Context,
	Effect,
	Equal,
	Hash,
	HashSet,
	Schema,
} from "effect"
import { Condition, Domain, Policy, Resource } from "../src/index.ts"
import { alice, aliceBot, App, Bot } from "./fixtures.ts"

const conditionText = (value: string, depth = 128): string =>
	JSON.stringify(
		Arr.reduce(
			Arr.range(1, depth - 1),
			{
				_tag: "Compare",
				op: "eq",
				field: "name",
				value: { _tag: "Literal", value },
			} as unknown,
			(condition) => ({ _tag: "Not", condition }),
		),
	)

const conditionOf = (value: string) =>
	Schema.decodeSync(Condition.schema(App, "Bot"))(conditionText(value))

const metaOf = (value: string): Schema.Json =>
	Arr.reduce(Arr.range(1, 32), value as Schema.Json, (inner): Schema.Json => ({
		inner,
	}))

const policyOf = (value: string): Policy.Policy<typeof App> => {
	const when = conditionOf(value)
	const leaf = Policy.define(App)(function* (_) {
		yield* _.allow("read", Bot, { when: () => when, meta: metaOf(value) })
	})
	return Arr.reduce(Arr.range(1, 64 - 1), leaf, (inner) => Policy.all([inner]))
}

describe("Deep data", () => {
	it("runs every condition walk past the old depth bound", () => {
		const condition = conditionOf("n")
		assert.strictEqual(condition.depth, 128)
		const input = { value: aliceBot, principal: alice }
		const expected = Condition.evaluateSync(condition, input)
		assert.strictEqual(
			Effect.runSync(Condition.evaluate(condition, input)),
			expected,
		)
		assert.strictEqual(
			Condition.evaluateSync(Condition.simplify(condition), input),
			expected,
		)
		assert.strictEqual(
			Condition.evaluateSync(
				Condition.partial(condition, { principal: alice }),
				input,
			),
			expected,
		)
		assert.deepStrictEqual(Condition.fields(condition), ["name"])
		assert.strictEqual(
			Condition.satisfiable(condition, { schema: Bot })._tag,
			"Satisfiable",
		)
		const count = Effect.runSync(
			Condition.fold(condition, {
				true: () => 0,
				false: () => 0,
				compare: () => 1,
				in: () => 1,
				exists: () => 1,
				and: (parts) => Arr.reduce(parts, 0, (sum, part) => sum + part),
				or: (parts) => Arr.reduce(parts, 0, (sum, part) => sum + part),
				not: (part) => part + 1,
			}),
		)
		assert.strictEqual(count, 128)
		const codec = Condition.schema(App, "Bot")
		const again = condition.pipe(
			Schema.encodeSync(codec),
			Schema.decodeSync(codec),
		)
		assert.isTrue(Equal.equals(condition, again))
		assert.strictEqual(Hash.hash(condition), Hash.hash(again))
		assert.isFalse(Equal.equals(condition, conditionOf("other")))
	})

	it("hashes, loads, decides, and analyses deep trees and meta together", () => {
		const policy = policyOf("n")
		const same = policyOf("n")
		const other = policyOf("other")
		assert.isTrue(Equal.equals(policy, same))
		assert.isFalse(Equal.equals(policy, other))
		assert.strictEqual(Hash.hash(policy), Hash.hash(same))
		assert.strictEqual(HashSet.size(HashSet.make(policy, same, other)), 2)
		const request = {
			principal: alice,
			action: "read",
			resource: aliceBot,
		} as const
		const expected = Policy.decideSync(policy, request)
		assert.strictEqual(
			Effect.runSync(Policy.explain(policy, request)).decision._tag,
			expected._tag,
		)
		const target = { principal: alice, action: "read", kind: "Bot" } as const
		assert.strictEqual(
			Condition.evaluateSync(Policy.residual(policy, target), {
				value: aliceBot,
			}),
			expected._tag === "Allow",
		)
		assert.strictEqual(Policy.coverage(policy, target)._tag, "Some")
		assert.isArray(Effect.runSync(Policy.permittedFields(policy, request)))
		const codec = Policy.schema(App)
		const again = policy.pipe(
			Schema.encodeSync(codec),
			Schema.decodeSync(codec),
		)
		assert.isTrue(Equal.equals(policy, again))
		assert.strictEqual(Policy.decideSync(again, request)._tag, expected._tag)
	})

	it("loads further condition and policy levels", () => {
		assert.doesNotThrow(() =>
			Schema.decodeSync(Condition.schema(App, "Bot"))(conditionText("n", 129)),
		)
		assert.doesNotThrow(() => Policy.all([policyOf("n")]))
	})

	it("decides a large path test without making a larger residual", () => {
		const parts = Arr.replicate("n", 6_000)
		const Item = Resource.make("Item", {
			actions: ["read"],
			fields: { name: Schema.String },
			path: (fields) => Arr.replicate(fields.name, 6_000),
		})
		const domain = Domain.make({
			principal: Schema.Struct({}),
			resources: [Item],
		})
		const policy = Policy.define(domain)(function* (_) {
			yield* _.allow("read", Item, { when: ($) => $.under(...parts) })
		})
		const request = {
			action: "read",
			resource: Item.make({ name: "n" }),
			principal: {},
		} as const
		assert.strictEqual(Policy.decideSync(policy, request)._tag, "Allow")
		assert.strictEqual(
			Effect.runSync(Policy.decide(policy, request))._tag,
			"Allow",
		)
	})

	it("provides predicate services in a deep policy", () => {
		class Gate extends Context.Service<Gate, boolean>()(
			"@nmnmcc/ability/tests/Deep.test/Gate",
		) {}
		const leaf = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("gate", () => Gate),
			})
		})
		const tree = Arr.reduce(Arr.range(1, 64 - 1), leaf, (inner, index) =>
			index % 2 === 0 ? Policy.all([inner]) : Policy.firstOf([inner]),
		)
		const provided = Policy.provideContext(tree, Context.make(Gate, true))
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
})
