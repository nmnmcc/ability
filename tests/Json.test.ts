import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Schema } from "effect"
import { Policy } from "../src/index.ts"
import * as Json from "../src/internal/json.ts"
import * as Limits from "../src/internal/limits.ts"
import * as PolicyJson from "../src/internal/policy-json.ts"
import { App } from "./fixtures.ts"

const nested = (depth: number): unknown =>
	Arr.reduce(Array.from({ length: depth }), null as unknown, (child) => ({
		child,
	}))

describe("JSON boundary", () => {
	it.effect("keeps the full path of a meta problem", () =>
		Effect.gen(function* () {
			const text = JSON.stringify({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Bot"],
						meta: nested(Limits.metaDepth + 1),
					},
				],
			})
			const error = yield* Effect.flip(PolicyJson.decode(text, App))
			assert.deepStrictEqual(error.path.slice(0, 3), ["rules", 0, "meta"])
		}),
	)

	it("rejects empty policy groups but accepts an empty rule list", () => {
		const decode = Schema.decodeExit(Policy.schema(App))
		assert.isTrue(
			Arr.every(["All", "Any", "FirstOf"], (_tag) =>
				Exit.isFailure(decode(JSON.stringify({ _tag, policies: [] }))),
			),
		)
		assert.isTrue(
			Exit.isSuccess(
				decode(
					JSON.stringify({
						_tag: "Rules",
						algorithm: "denyOverrides",
						rules: [],
					}),
				),
			),
		)
	})

	it("takes text at the length limit and stops above it", () => {
		const text = JSON.stringify("x".repeat(Limits.jsonTextLength - 2))
		assert.strictEqual(text.length, Limits.jsonTextLength)
		assert.isString(Json.parse(text))
		assert.strictEqual(Json.stringify(Json.parse(text)), text)
		assert.throws(() => Json.parse(`${text} `), /code units/)
		assert.throws(
			() => Json.stringify("x".repeat(Limits.jsonTextLength - 1)),
			/code units/,
		)
	})

	it("takes bounded containers and stops before deeper walks", () => {
		const text = JSON.stringify(nested(Limits.jsonDepth))
		assert.strictEqual(Json.stringify(Json.parse(text)), text)
		assert.throws(
			() => Json.parse(JSON.stringify(nested(Limits.jsonDepth + 1))),
			/levels/,
		)
		const veryDeep = `${"[".repeat(20_000)}null${"]".repeat(20_000)}`
		assert.throws(() => Json.parse(veryDeep), Json.Problem)
	})

	it("counts every value of a large input", () => {
		const atLimit = Array.from({ length: Limits.jsonItems - 1 }, () => null)
		assert.strictEqual(
			(Json.parse(JSON.stringify(atLimit)) as ReadonlyArray<unknown>).length,
			atLimit.length,
		)
		assert.throws(() => Json.parse(JSON.stringify([...atLimit, null])), /items/)
	})

	it("rejects invalid text and numbers that JSON cannot keep", () => {
		assert.throws(() => Json.parse("{"), Json.Problem)
		assert.throws(() => Json.parse("1e400"), /finite numbers/)
		assert.throws(() => Json.stringify({ value: Number.NaN }), /finite numbers/)
		assert.throws(() => Json.stringify({ value: Infinity }), /finite numbers/)
		assert.throws(() => Json.stringify({ value: undefined }), /JSON data/)
	})

	it("copies and counts JSON meta at its own bounds", () => {
		const input = { list: ["one", { two: true }] }
		const copy = Json.copyMeta(input)
		assert.strictEqual(copy.size, 5)
		assert.deepStrictEqual(copy.value, input)
		assert.notStrictEqual(copy.value, input)
		input.list.push("three")
		assert.deepStrictEqual(copy.value, { list: ["one", { two: true }] })
		assert.strictEqual(
			Json.copyMeta(nested(Limits.metaDepth)).size,
			Limits.metaDepth + 1,
		)
		assert.throws(() => Json.copyMeta(nested(Limits.metaDepth + 1)), /levels/)
		assert.strictEqual(
			Json.copyMeta(Array.from({ length: Limits.policyNodes - 1 }, () => null))
				.size,
			Limits.policyNodes,
		)
		assert.throws(
			() =>
				Json.copyMeta(Array.from({ length: Limits.policyNodes }, () => null)),
			/items/,
		)
	})

	it("rejects meta with data that JSON would lose", () => {
		assert.throws(() => Json.copyMeta(new Date()), /plain data/)
		assert.throws(() => Json.copyMeta({ value: 1n }), /JSON data/)
		assert.throws(() => Json.copyMeta([, "two"]), /every item/)
		assert.throws(
			() => Json.copyMeta({ [Symbol("key")]: "value" }),
			/own data field/,
		)
		const input = {
			get value() {
				throw new Error("The getter ran")
			},
		}
		assert.throws(() => Json.copyMeta(input), /own data field/)
	})
})
