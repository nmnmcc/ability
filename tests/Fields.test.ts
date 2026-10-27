import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Catalog from "../src/internal/catalog.ts"
import * as Rules from "../src/internal/rule.ts"
import { Domain, Policy, Resource } from "../src/index.ts"

describe("Field selectors", () => {
	it("matches exact fields, parents and the star", () => {
		assert.isTrue(Rules.matchesField("title", "title"))
		assert.isTrue(Rules.matchesField("settings", "settings.model"))
		assert.isTrue(Rules.matchesField("*", "settings.model"))
		assert.isFalse(Rules.matchesField("settings", "settingsMore"))
		assert.isFalse(Rules.matchesField("settings.model", "settings"))
	})

	it("finds denied children below a whole parent", () => {
		assert.isTrue(Rules.matchesInside("settings.secret", "settings"))
		assert.isFalse(Rules.matchesInside("settingsMore.secret", "settings"))
		assert.isFalse(Rules.matchesInside("settings", "settings.secret"))
	})

	it("treats unsupported patterns as literal text", () => {
		assert.isFalse(Rules.matchesField("secret*", "secretKey"))
		assert.isFalse(Rules.matchesField("settings.*", "settings.model"))
		assert.isFalse(Rules.matchesField("**.secret", "settings.secret"))
	})

	it("finds only selectors of a fixed directory", () => {
		const catalog = Catalog.catalogOf(
			Schema.Struct({ settings: Schema.Struct({ model: Schema.String }) }).ast,
		)
		const fits = Rules.fitsOf(catalog)
		assert.isTrue(fits("*"))
		assert.isTrue(fits("settings"))
		assert.isTrue(fits("settings.model"))
		assert.isFalse(fits("settings.*"))
		assert.isFalse(fits("missing"))
		assert.isFalse(Rules.fitsOf(Catalog.catalogOf(Schema.Struct({}).ast))("*"))
	})
})

describe("Resource lists", () => {
	it("accepts an action of one listed resource and checks only its value type", () => {
		const Readable = Resource.make("Readable", {
			actions: ["read"],
			fields: { value: Schema.String },
		})
		const Writable = Resource.make("Writable", {
			actions: ["write"],
			fields: { value: Schema.Finite },
		})
		const App = Domain.make({
			principal: Schema.Struct({ id: Schema.String }),
			resources: [Readable, Writable],
		})
		const policy = Schema.decodeSync(Policy.schema(App))(
			JSON.stringify({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Readable", "Writable"],
						when: {
							_tag: "Compare",
							op: "eq",
							field: "value",
							value: { _tag: "Literal", value: "one" },
						},
					},
				],
			}),
		)
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: { id: "one" },
				action: "read",
				resource: Readable.make({ value: "one" }),
			})._tag,
			"Allow",
		)
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: { id: "one" },
				action: "write",
				resource: Writable.make({ value: 1 }),
			})._tag,
			"NotApplicable",
		)
	})
})

describe("Opaque fields", () => {
	it("rejects a JSON comparison on a transformed field but keeps whole field access", () => {
		const Item = Resource.make("Item", {
			actions: ["read"],
			fields: { value: Schema.FiniteFromString },
		})
		const App = Domain.make({
			principal: Schema.Struct({ id: Schema.String }),
			resources: [Item],
		})
		const codec = Policy.schema(App)
		assert.throws(
			() =>
				Schema.decodeSync(codec)(
					JSON.stringify({
						_tag: "Rules",
						algorithm: "denyOverrides",
						rules: [
							{
								_tag: "Allow",
								actions: ["read"],
								resources: ["Item"],
								when: {
									_tag: "Compare",
									op: "eq",
									field: "value",
									value: { _tag: "Literal", value: 1 },
								},
							},
						],
					}),
				),
			/predicate/,
		)
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Item, {
				fields: ["value"],
				when: ($) => $.exists("value"),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: { id: "one" },
				action: "read",
				resource: Item.make({ value: 1 }),
				field: "value",
			})._tag,
			"Allow",
		)
		assert.strictEqual(
			Policy.coverage(policy, {
				principal: { id: "one" },
				action: "read",
				kind: "Item",
				field: "value",
			})._tag,
			"Unknown",
		)
	})
})
