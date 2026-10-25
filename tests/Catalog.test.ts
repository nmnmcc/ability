import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Option, Schema, type SchemaAST } from "effect"
import * as Catalog from "../src/internal/catalog.ts"
import { readPart, readPath } from "../src/internal/read.ts"

const catalogOf = (schema: Schema.Top) => Catalog.catalogOf(schema.ast)

const texts = (schema: Schema.Top) =>
	Arr.map(catalogOf(schema).fields, (field) => field.text)

const fieldOf = (schema: Schema.Top, path: string): Catalog.Field => {
	const field = Catalog.lookup(catalogOf(schema), path)
	assert.isDefined(field)
	return field!
}

class Owner extends Schema.Class<Owner>("CatalogOwner")({
	id: Schema.String,
	email: Schema.optionalKey(Schema.String),
}) {
	get label() {
		return this.id
	}
}

interface Link {
	readonly value: string
	readonly next: Link | null
}
const Link: Schema.Codec<Link> = Schema.Struct({
	value: Schema.String,
	next: Schema.NullOr(Schema.suspend((): Schema.Codec<Link> => Link)),
})

describe("Catalog", () => {
	it("lists the fields of a struct, a field before the fields below it", () => {
		assert.deepStrictEqual(
			texts(
				Schema.Struct({
					id: Schema.String,
					settings: Schema.Struct({ model: Schema.String, size: Schema.Int }),
				}),
			),
			["id", "settings", "settings.model", "settings.size"],
		)
	})

	it("knows the kinds of the values of each field", () => {
		const schema = Schema.Struct({
			name: Schema.String,
			level: Schema.Int,
			ratio: Schema.Finite,
			flag: Schema.Boolean,
			state: Schema.Literals(["open", "closed"]),
			owner: Schema.NullOr(Schema.String),
			note: Schema.optionalKey(Schema.String),
		})
		assert.deepStrictEqual(fieldOf(schema, "level").kinds, {
			...Catalog.noKinds,
			number: "integer",
		})
		assert.strictEqual(fieldOf(schema, "ratio").kinds.number, "finite")
		assert.isTrue(fieldOf(schema, "flag").kinds.boolean)
		assert.deepStrictEqual(fieldOf(schema, "state").kinds.literals, [
			"open",
			"closed",
		])
		assert.isTrue(fieldOf(schema, "owner").kinds.null)
		assert.isTrue(fieldOf(schema, "note").kinds.null)
		assert.isFalse(fieldOf(schema, "name").kinds.null)
	})

	it("reads the data fields of a class, not its getters", () => {
		const schema = Schema.Struct({ owner: Owner })
		assert.deepStrictEqual(texts(schema), ["owner", "owner.id", "owner.email"])
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "owner.label"))
		assert.isTrue(fieldOf(schema, "owner.email").kinds.null)
	})

	it("puts the branches of a union together", () => {
		const schema = Schema.Struct({
			box: Schema.Union([
				Schema.Struct({ kind: Schema.Literal("a"), size: Schema.Int }),
				Schema.Struct({ kind: Schema.Literal("b"), label: Schema.String }),
			]),
			either: Schema.Union([
				Schema.String,
				Schema.Struct({ part: Schema.String }),
			]),
		})
		assert.deepStrictEqual(fieldOf(schema, "box.kind").kinds.literals, [
			"a",
			"b",
		])
		// A branch with no `size` may still have it as an extra field.
		assert.deepStrictEqual(fieldOf(schema, "box.size").kinds, Catalog.anyKinds)
		// Below a string, a part reads `null`.
		assert.isTrue(fieldOf(schema, "either.part").kinds.null)
		assert.isTrue(fieldOf(schema, "either").listed)
		assert.isTrue(fieldOf(schema, "either").kinds.string)
	})

	it("gives a part for the keys of a record", () => {
		const schema = Schema.Struct({
			tags: Schema.Record(Schema.String, Schema.String),
			counts: Schema.Record(Schema.Finite, Schema.String),
			entries: Schema.Record(
				Schema.TemplateLiteral(["x", Schema.String]),
				Schema.Struct({ secret: Schema.String }),
			),
		})
		assert.deepStrictEqual(texts(schema), [
			"tags",
			"tags.*",
			"counts",
			"counts.*",
			"entries",
			"entries.*",
			"entries.*.secret",
		])
		assert.isTrue(fieldOf(schema, "tags.owner").kinds.null)
		assert.isTrue(fieldOf(schema, "tags").open)
		assert.isTrue(fieldOf(schema, "tags").listed)
		assert.isDefined(Catalog.lookup(catalogOf(schema), "counts.1"))
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "counts.x"))
		assert.isDefined(Catalog.lookup(catalogOf(schema), "entries.x1.secret"))
		assert.isUndefined(Catalog.lookup(catalogOf(schema), "entries.y1.secret"))
	})

	it("names a number key of a struct with its text", () => {
		const schema = Schema.Struct({
			data: Schema.Record(Schema.Literal(1), Schema.String),
		})
		assert.deepStrictEqual(texts(schema), ["data", "data.1"])
		assert.isTrue(fieldOf(schema, "data.1").kinds.string)
		assert.isTrue(fieldOf(schema, "data.1").listed)
	})

	it("marks the fields where a read may find data that is not plain", () => {
		class Named extends Schema.Class<Named>("CatalogNamed")({
			flag: Schema.String,
		}) {}
		const schema = Schema.Struct({
			owner: Schema.Union([Owner, Schema.Struct({ label: Schema.String })]),
			named: Schema.Union([Named, Schema.Struct({ other: Schema.String })]),
			dated: Schema.Union([
				Schema.Date,
				Schema.Struct({ flag: Schema.String }),
			]),
			text: Schema.Union([
				Schema.String,
				Schema.Struct({ flag: Schema.String }),
			]),
			any: Schema.Union([
				Schema.Unknown,
				Schema.Struct({ flag: Schema.String }),
			]),
		})
		// The class `Owner` has a getter `label`, and no field of that name.
		assert.isFalse(fieldOf(schema, "owner.label").plain)
		assert.isTrue(fieldOf(schema, "owner.id").plain)
		// A struct without the field is copied into a plain object, but a
		// class without the field may have a getter of that name.
		assert.isTrue(fieldOf(schema, "named.flag").plain)
		assert.isFalse(fieldOf(schema, "named.other").plain)
		assert.isFalse(fieldOf(schema, "dated.flag").plain)
		assert.isTrue(fieldOf(schema, "text.flag").plain)
		assert.isFalse(fieldOf(schema, "any.flag").plain)
		assert.isTrue(fieldOf(schema, "dated").plain)
	})

	it("stops a recursive Schema at the most parts of a path", () => {
		const schema = Schema.Struct({ root: Link })
		assert.isDefined(Catalog.lookup(catalogOf(schema), "root.next.next.value"))
		assert.isDefined(
			Catalog.lookup(catalogOf(schema), "root.next.next.next.value"),
		)
		assert.isUndefined(
			Catalog.lookup(catalogOf(schema), "root.next.next.next.next.value"),
		)
		// A struct at the last part is one field.
		assert.isTrue(fieldOf(schema, "root.next.next.next.next").listed)
	})

	it("keeps a value with parts that it does not know as one field", () => {
		const schema = Schema.Struct({
			when: Schema.Date,
			tags: Schema.Array(Schema.String),
			data: Schema.Json,
			empty: Schema.Struct({}),
		})
		assert.deepStrictEqual(texts(schema), ["when", "tags", "data", "empty"])
		assert.deepStrictEqual(fieldOf(schema, "data").kinds, Catalog.anyKinds)
		assert.deepStrictEqual(fieldOf(schema, "empty").kinds, Catalog.anyKinds)
		assert.isTrue(fieldOf(schema, "tags").open)
		assert.isTrue(fieldOf(schema, "tags").kinds.object)
	})

	it("does not take a field name with a dot or an empty name", () => {
		assert.throws(
			() => catalogOf(Schema.Struct({ "a.b": Schema.String })),
			/may not have a dot/,
		)
		assert.throws(
			() => catalogOf(Schema.Struct({ "": Schema.String })),
			/may not be empty/,
		)
	})

	it("stops a Schema with too many fields", () => {
		const wide = Schema.Struct(
			Object.fromEntries(
				Array.from({ length: 10_001 }, (_, index) => [
					`f${String(index)}`,
					Schema.String,
				]),
			),
		)
		assert.throws(() => catalogOf(wide), /The most is 10000/)
	})
})

describe("read", () => {
	it("reads own data fields, and null for a missing one", () => {
		assert.strictEqual(readPart({ a: 1 }, "a"), 1)
		assert.isNull(readPart({ a: undefined }, "a"))
		assert.isNull(readPart({}, "a"))
		assert.isNull(readPart("text", "length"))
		assert.isNull(readPart(null, "a"))
		assert.isNull(readPart({}, "constructor"))
		assert.strictEqual(readPath({ a: { b: 2 } }, ["a", "b"]), 2)
		assert.strictEqual(readPart(Owner.make({ id: "o" }), "id"), "o")
	})

	it("does not read a getter or a field that a loop does not see", () => {
		assert.throws(
			() => readPart(Owner.make({ id: "o" }), "label"),
			/not plain data/,
		)
		const hidden = Object.defineProperty({}, "a", { value: 1 })
		assert.throws(() => readPart(hidden, "a"), /not plain data/)
		const accessor = Object.defineProperty({}, "a", {
			get: () => 1,
			enumerable: true,
		})
		assert.throws(() => readPart(accessor, "a"), /not plain data/)
	})
})

/** Gives each field of the catalog with a path of names for one value. */
const placesOf = (
	branch: Catalog.Branch,
	value: unknown,
	names: ReadonlyArray<string>,
): ReadonlyArray<readonly [Catalog.Field, ReadonlyArray<string>]> => {
	const here =
		branch.field === undefined ? [] : [[branch.field, names] as const]
	const below = readPath(value, names)
	const keys =
		branch.key === undefined || typeof below !== "object" || below === null
			? []
			: Arr.filter(
					[...Object.keys(below), "absent"],
					(key) =>
						!Option.isSome(
							Arr.findFirst(branch.children, ([name]) => name === key),
						),
				)
	return [
		...here,
		...Arr.flatMap(branch.children, ([name, child]) =>
			placesOf(child, value, [...names, name]),
		),
		...(branch.keyBranch === undefined
			? []
			: Arr.flatMap(keys, (key) =>
					placesOf(branch.keyBranch!, value, [...names, key]),
				)),
	]
}

/** Tests that each value that a read gives fits the kinds of its field. */
const fitsCatalog = (ast: SchemaAST.AST, value: unknown): boolean => {
	const catalog = Catalog.catalogOf(ast)
	return Arr.every(placesOf(catalog.root, value, []), ([field, names]) =>
		Catalog.accepts(field.kinds, readPath(value, names)),
	)
}

describe("Catalog properties", () => {
	const Shape = Schema.Struct({
		name: Schema.String,
		level: Schema.Int,
		ratio: Schema.Finite,
		flag: Schema.Boolean,
		state: Schema.Literals(["open", "closed"]),
		owner: Schema.NullOr(Owner),
		note: Schema.optionalKey(Schema.String),
		box: Schema.Union([
			Schema.Struct({ kind: Schema.Literal("a"), size: Schema.Int }),
			Schema.Struct({ kind: Schema.Literal("b"), label: Schema.String }),
		]),
		either: Schema.Union([Schema.String, Schema.Struct({ part: Schema.Int })]),
		tags: Schema.Record(Schema.String, Schema.String),
		counts: Schema.Record(Schema.String, Schema.Struct({ n: Schema.Int })),
		link: Link,
		when: Schema.Date,
		list: Schema.Array(Schema.String),
	})

	it.prop(
		"holds every value that a read of a Schema value gives",
		{ value: Shape },
		({ value }) => fitsCatalog(Shape.ast, value),
	)
})
