import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Schema } from "effect"
import * as Catalog from "../src/internal/catalog.ts"
import * as Limits from "../src/internal/limits.ts"
import * as Nodes from "../src/internal/nodes.ts"
import * as Search from "../src/internal/search.ts"
import { readPart, readPath } from "../src/internal/read.ts"

const catalogOf = (schema: Schema.Top) => Catalog.catalogOf(schema.ast)
const texts = (schema: Schema.Top) =>
	Arr.map(catalogOf(schema).fields, (field) => field.text)
const fieldOf = (schema: Schema.Top, path: string): Catalog.Field => {
	const field = Catalog.lookup(catalogOf(schema), path)
	assert.isDefined(field)
	return field!
}

class Owner extends Schema.Class<Owner, { readonly brand: unique symbol }>(
	"CatalogOwner",
)({
	id: Schema.String,
	email: Schema.optionalKey(Schema.String),
}) {
	get label() {
		return this.id
	}
	labelText() {
		return this.id
	}
}

describe("Catalog", () => {
	it("lists fixed fields with each parent before its children", () => {
		const schema = Schema.Struct({
			id: Schema.String,
			settings: Schema.Struct({ model: Schema.String, size: Schema.Int }),
		})
		assert.deepStrictEqual(texts(schema), [
			"id",
			"settings",
			"settings.model",
			"settings.size",
		])
		assert.isTrue(catalogOf(schema).supported)
		assert.isFalse(fieldOf(schema, "settings").listed)
		assert.isTrue(fieldOf(schema, "settings").open)
		assert.isTrue(fieldOf(schema, "settings.size").listed)
	})

	it("keeps the scalar kinds and the two known number checks", () => {
		const schema = Schema.Struct({
			name: Schema.String,
			level: Schema.Int,
			ratio: Schema.Finite,
			flag: Schema.Boolean,
			state: Schema.Literals(["open", "closed"]),
			owner: Schema.NullOr(Schema.String),
			note: Schema.optionalKey(Schema.String),
		})
		assert.strictEqual(fieldOf(schema, "level").kinds.number, "integer")
		assert.strictEqual(fieldOf(schema, "ratio").kinds.number, "finite")
		assert.deepStrictEqual(fieldOf(schema, "state").kinds.literals, [
			"open",
			"closed",
		])
		assert.isTrue(fieldOf(schema, "flag").kinds.boolean)
		assert.isTrue(fieldOf(schema, "owner").kinds.null)
		assert.isTrue(fieldOf(schema, "note").kinds.null)
		assert.isFalse(fieldOf(schema, "name").kinds.null)
		assert.isTrue(catalogOf(schema).supported)
	})

	it("uses safe integers for the catalog and search", () => {
		const catalog = catalogOf(Schema.Struct({ value: Schema.Int }))
		const kinds = Catalog.lookup(catalog, "value")!.kinds
		Arr.forEach(
			[
				Number.MIN_SAFE_INTEGER - 1,
				Number.MIN_SAFE_INTEGER,
				Number.MAX_SAFE_INTEGER,
				Number.MAX_SAFE_INTEGER + 1,
				1.5,
			],
			(value) => {
				const accepted = Schema.is(Schema.Int)(value)
				assert.strictEqual(Catalog.accepts(kinds, value), accepted)
				const condition = new Nodes.Compare({
					op: "eq",
					field: "value",
					value: Nodes.literal(value),
				})
				assert.strictEqual(
					Search.satisfiable(condition, catalog)._tag,
					accepted ? "Satisfiable" : "Unsatisfiable",
				)
			},
		)
	})

	it("reads only the data fields of a standard class", () => {
		const schema = Schema.Struct({ owner: Owner })
		assert.deepStrictEqual(texts(schema), ["owner", "owner.id", "owner.email"])
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "owner.label"))
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "owner.labelText"))
		assert.isTrue(catalogOf(schema).supported)
	})

	it("keeps nullable and optional objects but makes no proof for them", () => {
		const schema = Schema.Struct({
			a: Schema.NullOr(Schema.Struct({ id: Schema.String })),
			b: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
		})
		assert.deepStrictEqual(texts(schema), ["a", "a.id", "b", "b.id"])
		assert.isTrue(fieldOf(schema, "a.id").kinds.null)
		assert.isTrue(fieldOf(schema, "b.id").kinds.null)
		assert.isFalse(catalogOf(schema).supported)
	})

	it("keeps complex shapes as whole fields", () => {
		const schema = Schema.Struct({
			items: Schema.Array(Schema.String),
			data: Schema.Record(Schema.String, Schema.String),
			box: Schema.Union([
				Schema.Struct({ a: Schema.String }),
				Schema.Struct({ b: Schema.String }),
			]),
			custom: Schema.declare(
				(value): value is string => typeof value === "string",
			),
			value: Schema.Unknown,
		})
		assert.deepStrictEqual(texts(schema), [
			"items",
			"data",
			"box",
			"custom",
			"value",
		])
		assert.isFalse(catalogOf(schema).supported)
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "data.key"))
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "items.0"))
	})

	it("does not call a recursive Schema thunk", () => {
		const schema = Schema.Struct({
			link: Schema.suspend(() => {
				throw new Error("Do not open this Schema")
			}),
		})
		assert.deepStrictEqual(texts(schema), ["link"])
		assert.isFalse(catalogOf(schema).supported)
	})

	it("does not run user checks and makes no proof for them", () => {
		const schema = Schema.Struct({
			value: Schema.String.check(
				Schema.makeFilter(() => {
					throw new Error("Do not run this check")
				}),
			),
		})
		assert.deepStrictEqual(texts(schema), ["value"])
		assert.isFalse(catalogOf(schema).supported)
	})

	it("makes no proof for a scalar codec", () => {
		const schema = Schema.Struct({ value: Schema.FiniteFromString })
		assert.deepStrictEqual(texts(schema), ["value"])
		assert.isFalse(catalogOf(schema).supported)
		assert.isFalse(fieldOf(schema, "value").scalar)
		assert.deepStrictEqual(
			Search.satisfiable(Nodes.always, catalogOf(schema)),
			{
				_tag: "Unknown",
				reason: "schema",
			},
		)
	})

	it("ends each path at five parts", () => {
		const schema = Schema.Struct({
			a: Schema.Struct({
				b: Schema.Struct({
					c: Schema.Struct({
						d: Schema.Struct({ e: Schema.Struct({ f: Schema.String }) }),
					}),
				}),
			}),
		})
		assert.deepStrictEqual(texts(schema), [
			"a",
			"a.b",
			"a.b.c",
			"a.b.c.d",
			"a.b.c.d.e",
		])
		assert.isTrue(fieldOf(schema, "a.b.c.d.e").listed)
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "a.b.c.d.e.f"))
		assert.isFalse(catalogOf(schema).supported)
	})

	it("takes 1,000 fields and rejects one more", () => {
		const fields = Object.fromEntries(
			Arr.makeBy(Limits.catalogFields, (index) => [
				`field${index}`,
				Schema.String,
			]),
		)
		assert.strictEqual(
			catalogOf(Schema.Struct(fields)).fields.length,
			Limits.catalogFields,
		)
		assert.throws(
			() => catalogOf(Schema.Struct({ ...fields, extra: Schema.String })),
			/The most is 1000/,
		)
	})

	it("rejects names with a dot, a star, or no text", () => {
		Arr.forEach(["a.b", "a*", ""], (name) => {
			assert.throws(
				() => catalogOf(Schema.Struct({ [name]: Schema.String })),
				/field name/,
			)
		})
	})

	it("knows when a required field has no value", () => {
		assert.isFalse(catalogOf(Schema.Struct({ value: Schema.Never })).inhabited)
		assert.isTrue(
			catalogOf(Schema.Struct({ value: Schema.optionalKey(Schema.Never) }))
				.inhabited,
		)
		assert.isTrue(
			catalogOf(Schema.Struct({ value: Schema.NullOr(Schema.Never) }))
				.inhabited,
		)
	})
})

describe("Own data reads", () => {
	it("reads values and makes missing or undefined values null", () => {
		assert.strictEqual(readPart({ value: 1 }, "value"), 1)
		assert.strictEqual(readPart({ value: undefined }, "value"), null)
		assert.strictEqual(readPart({}, "value"), null)
		assert.strictEqual(readPath({ one: { two: 2 } }, ["one", "two"]), 2)
		assert.strictEqual(readPath({}, ["one", "two"]), null)
	})

	it("does not call getters or read prototypes", () => {
		class Value {
			get value() {
				throw new Error("Do not run this getter")
			}
		}
		assert.strictEqual(readPart(new Value(), "value"), null)
		assert.strictEqual(
			readPart(
				{
					get value() {
						throw new Error("Do not run this getter")
					},
				},
				"value",
			),
			null,
		)
		assert.strictEqual(readPart({}, "constructor"), null)
	})

	it("reads hidden own data fields without Error rules", () => {
		assert.strictEqual(readPart(new Error("no"), "message"), "no")
		assert.strictEqual(readPart(new Error("no"), "name"), null)
		assert.strictEqual(readPart(Owner.make({ id: "one" }), "id"), "one")
	})
})
