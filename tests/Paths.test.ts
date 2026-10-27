import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Schema } from "effect"
import { Condition, Policy } from "../src/index.ts"
import {
	App,
	Deep,
	Leaf,
	path100,
	path101,
	valueAtDepth,
} from "./path-fixtures.ts"

const principal = valueAtDepth(100, "yes")
const value = (leaf: string) => ({
	...valueAtDepth(100, leaf),
	_tag: "Leaf" as const,
})

describe("long paths", () => {
	it.effect(
		"keeps decisions, residuals and JSON in agreement at part 100",
		() =>
			Effect.gen(function* () {
				const policy = Policy.define(App)(function* (_) {
					yield* _.allow("read", Leaf, {
						fields: [path100],
						when: ($) => $.eq(path100, $.principal(path100)),
					})
				})
				const request = {
					principal,
					action: "read",
					kind: "Leaf",
					field: path100,
				} as const
				const residual = Policy.residual(policy, request)
				const codec = Policy.schema(App)
				const text = yield* Schema.encodeEffect(codec)(policy)
				const loaded = yield* Schema.decodeEffect(codec)(text)
				const conditionCodec = Condition.schema(App, "Leaf")
				const conditionText =
					yield* Schema.encodeEffect(conditionCodec)(residual)
				const condition =
					yield* Schema.decodeEffect(conditionCodec)(conditionText)
				Arr.forEach(["yes", "no"], (leaf) => {
					const resource = value(leaf)
					const input = {
						principal,
						action: "read",
						resource,
						field: path100,
					} as const
					const allowed = Policy.decideSync(policy, input)._tag === "Allow"
					assert.strictEqual(allowed, leaf === "yes")
					assert.strictEqual(
						Policy.decideSync(loaded, input)._tag === "Allow",
						allowed,
					)
					assert.strictEqual(
						Condition.evaluateSync(residual, { value: resource, principal }),
						allowed,
					)
					assert.strictEqual(
						Condition.evaluateSync(condition, { value: resource, principal }),
						allowed,
					)
				})
				assert.strictEqual(Policy.coverage(policy, request)._tag, "Some")
				assert.deepStrictEqual(
					yield* Policy.permittedFields(policy, {
						principal,
						action: "read",
						resource: value("yes"),
					}),
					[path100],
				)
			}),
	)
	it("loads part 101 in policy and condition text", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Deep, {
				fields: [path101],
				when: ($) => $.eq(path101, "yes"),
			})
		})
		const codec = Policy.schema(App)
		const text = Schema.encodeSync(codec)(policy)
		assert.doesNotThrow(() => Schema.decodeSync(codec)(text))
		const conditionCodec = Condition.schema(App, "Deep")
		assert.doesNotThrow(() =>
			Schema.decodeSync(conditionCodec)(
				JSON.stringify({ _tag: "Exists", field: path101 }),
			),
		)
	})
})
