import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Exit, Schema } from "effect"
import { Policy } from "../src/index.ts"
import * as Json from "../src/internal/json.ts"
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
						meta: { value: null },
					},
				],
			})
			const invalid = text.replace('"value":null', '"value":1e400')
			const error = yield* Effect.flip(PolicyJson.decode(invalid, App))
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

	it("reads and writes text above the old length cap", () => {
		const text = JSON.stringify("x".repeat(1000001))
		assert.strictEqual(Json.stringify(Json.parse(text)), text)
		assert.strictEqual(Json.parse(`${text} `), "x".repeat(1000001))
	})
	it("reads containers past the old depth cap", () => {
		const text = JSON.stringify(nested(300))
		assert.strictEqual(Json.stringify(Json.parse(text)), text)
	})
	it("reads more than 100000 JSON items", () => {
		const items = Array.from({ length: 100001 }, () => null)
		assert.strictEqual(
			(Json.parse(JSON.stringify(items)) as ReadonlyArray<unknown>).length,
			items.length,
		)
	})

	it("rejects invalid text and numbers that JSON cannot keep", () => {
		assert.throws(() => Json.parse("{"), Json.Problem)
		assert.throws(() => Json.parse("1e400"), /finite numbers/)
		assert.throws(() => Json.stringify({ value: Number.NaN }), /finite numbers/)
		assert.throws(() => Json.stringify({ value: Infinity }), /finite numbers/)
		assert.throws(() => Json.stringify({ value: undefined }), /JSON data/)
	})

	it("copies JSON meta without depth or size caps", () => {
		const input = { list: ["one", { two: true }] }
		const copy = Json.copyMeta(input)
		assert.strictEqual(copy.size, 5)
		assert.deepStrictEqual(copy.value, input)
		assert.notStrictEqual(copy.value, input)
		input.list.push("three")
		assert.deepStrictEqual(copy.value, { list: ["one", { two: true }] })
		assert.strictEqual(Json.copyMeta(nested(32)).size, 33)
		assert.strictEqual(
			Json.copyMeta(Array.from({ length: 10001 }, () => null)).size,
			10002,
		)
	})
	it("rejects cycles but copies each use of a shared object", () => {
		const cycle: { child?: unknown } = {}
		cycle.child = cycle
		assert.throws(() => Json.copyMeta(cycle), /cycle/)
		const shared = { value: 1 }
		assert.deepStrictEqual(Json.copyMeta([shared, shared]).value, [
			{ value: 1 },
			{ value: 1 },
		])
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
