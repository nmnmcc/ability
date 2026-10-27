import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import {
	Authorizer,
	Condition,
	Domain,
	Policy,
	Resource,
} from "../src/index.ts"
import { App, Deep, Leaf, path100, path101 } from "./path-fixtures.ts"

const $ = Condition.builder(App, "Leaf")
const deep = Condition.builder(App, "Deep")
const rules = Policy.builder(App)

describe("long paths", () => {
	it("reads 100 parts without losing the value type", () => {
		expect($.eq).type.toBeCallableWith(path100, "yes")
		expect($.eq).type.not.toBeCallableWith(path100, 1)
		expect($.gt).type.toBeCallableWith(path100, "a")
		expect($.in).type.toBeCallableWith(path100, ["yes", "no"])
		expect($.in).type.not.toBeCallableWith(path100, [1])
		expect($.principal(path100)).type.toBe<
			Condition.Ref<string, typeof App.principal.Type>
		>()
		expect($.eq).type.toBeCallableWith(path100, $.principal(path100))
		expect($.exists).type.toBeCallableWith("a")
		expect(deep.exists).type.toBeCallableWith("a")
		expect(deep.exists).type.toBeCallableWith(path100)
		expect(deep.eq).type.not.toBeCallableWith(path100, "yes")
	})
	it("rejects missing fields and accepts part 101", () => {
		expect($.exists).type.not.toBeCallableWith("a.missing")
		expect($.eq).type.not.toBeCallableWith(`${path100}.missing`, "yes")
		expect(deep.exists).type.toBeCallableWith(path101)
		expect(deep.eq).type.toBeCallableWith(path101, "yes")
		expect($.principal).type.not.toBeCallableWith(path101)
		expect($.principal).type.not.toBeCallableWith("a.missing")
		expect(rules.allow).type.toBeCallableWith("read", Deep, {
			fields: [path101],
		})
	})
	it("keeps paths in rules and requests", () => {
		expect(rules.allow).type.toBeCallableWith("read", Leaf, {
			fields: [path100],
		})
		expect(rules.deny).type.toBeCallableWith("write", Deep, {
			fields: [path100],
		})
		expect({
			action: "read",
			kind: "Leaf",
			field: path100,
		} as const).type.toBeAssignableTo<Policy.KindTarget<typeof App>>()
		expect({
			action: "read",
			kind: "Deep",
			field: path101,
		} as const).type.toBeAssignableTo<Policy.KindTarget<typeof App>>()
		expect<Authorizer.Target<typeof App>>().type.toBe<
			Policy.Target<typeof App> | Policy.KindTarget<typeof App>
		>()
	})
})

type NullableChain<
	N extends number,
	S extends Schema.Top = Schema.String,
	Depth extends ReadonlyArray<unknown> = [],
> = Depth["length"] extends N
	? S
	: NullableChain<
			N,
			Schema.Struct<{ readonly a: Schema.NullOr<S> }>,
			readonly [...Depth, unknown]
		>

type UnionChain<
	N extends number,
	S extends Schema.Top = Schema.String,
	Depth extends ReadonlyArray<unknown> = [],
> = Depth["length"] extends N
	? S
	: UnionChain<N, Schema.NullOr<S>, readonly [...Depth, unknown]>

declare const nullable: NullableChain<100>
declare const union: UnionChain<12>
const Shapes = Resource.make("Shapes", {
	actions: ["read"],
	fields: { ...nullable.fields, choice: union },
})
const ShapesDomain = Domain.make({
	principal: Schema.Struct({}),
	resources: [Shapes],
})
const shapes = Condition.builder(ShapesDomain, "Shapes")

describe("type walks", () => {
	it("keeps null through a long field path", () => {
		expect<
			Condition.FieldValue<typeof nullable.fields, typeof path100>
		>().type.toBe<string | null>()
		expect(shapes.eq).type.toBeCallableWith(path100, "yes")
		expect(shapes.eq).type.toBeCallableWith(path100, null)
		expect(shapes.eq).type.not.toBeCallableWith(path100, 1)
		expect(shapes.exists).type.toBeCallableWith("a")
	})
	it("reads scalar unions past five levels", () => {
		expect(shapes.eq).type.toBeCallableWith("choice", "yes")
		expect(shapes.eq).type.toBeCallableWith("choice", null)
		expect(shapes.eq).type.not.toBeCallableWith("choice", true)
		expect(shapes.gt).type.toBeCallableWith("choice", "a")
	})
})
