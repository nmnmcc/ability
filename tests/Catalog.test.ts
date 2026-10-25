import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Option, Schema, type SchemaAST } from "effect"
import { Domain, Resource } from "../src/index.ts"
import * as Catalog from "../src/internal/catalog.ts"
import { Caller } from "./fixtures.ts"
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
		// The struct has no field `id`.
		assert.isFalse(fieldOf(schema, "owner.label").plain)
		assert.isFalse(fieldOf(schema, "owner.id").plain)
		// A struct or a class without the field may have it with any value, as
		// a list, or as a getter of a class.
		assert.isFalse(fieldOf(schema, "named.flag").plain)
		assert.isFalse(fieldOf(schema, "named.other").plain)
		assert.isFalse(fieldOf(schema, "dated.flag").plain)
		assert.isTrue(fieldOf(schema, "text.flag").plain)
		assert.isFalse(fieldOf(schema, "any.flag").plain)
		assert.isTrue(fieldOf(schema, "dated").plain)
	})

	it("finds a field of a recursive Schema at any part, up to the limit", () => {
		const schema = Schema.Struct({ root: Link })
		const catalog = catalogOf(schema)
		// `next` and `next.next` lead to one place.
		assert.isTrue(catalog.branches.length < 10)
		const deep = (links: number) =>
			["root", ...Arr.makeBy(links, () => "next"), "value"].join(".")
		assert.isDefined(Catalog.lookup(catalog, deep(998)))
		assert.isUndefined(Catalog.lookup(catalog, deep(999)))
		assert.isDefined(Catalog.lookup(catalog, deep(1998), 2000))
		assert.isUndefined(Catalog.lookup(catalog, deep(3), 4))
		// A struct at the last part is one field.
		assert.isTrue(Catalog.lookup(catalog, "root", 1)!.listed)
		assert.isFalse(Catalog.lookup(catalog, "root")!.listed)
		// The list goes into each recursive place one time on each path. The
		// place of `root.next.next` may be missing too, so it is not the place
		// of `root.next`.
		assert.deepStrictEqual(texts(schema), [
			"root",
			"root.value",
			"root.next",
			"root.next.value",
			"root.next.next",
			"root.next.next.value",
			"root.next.next.next",
		])
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

	it("makes the catalog of a union very many levels deep", () => {
		const deep = Arr.reduce(
			Arr.range(1, 5000),
			Schema.String as Schema.Codec<string>,
			(inner) => Schema.Union([Schema.String, inner]),
		)
		const Deep = Resource.make("DeepUnion", {
			actions: ["read"],
			fields: { name: deep },
		})
		assert.doesNotThrow(() =>
			Domain.make({ principal: Caller, resources: [Deep] }),
		)
		assert.isTrue(fieldOf(Schema.Struct({ name: deep }), "name").kinds.string)
	})

	it("reads a number with very many checks", () => {
		const checked = Arr.reduce(
			Arr.range(1, 10_000),
			Schema.isGreaterThan(0) as SchemaAST.Check<number>,
			// Each check holds the group of the checks before it.
			(inner, index) => Schema.isLessThan(index + 10).and(inner),
		)
		// The search for the check of whole numbers opens every group.
		const schema = Schema.Struct({ n: Schema.Finite.check(checked) })
		assert.strictEqual(fieldOf(schema, "n").kinds.number, "finite")
	})

	it("makes the catalog of a struct with very many fields", () => {
		const Wide = Resource.make("VeryWide", {
			actions: ["read"],
			fields: Object.fromEntries(
				Array.from({ length: 150_000 }, (_, index) => [
					`f${String(index)}`,
					Schema.String,
				]),
			),
		})
		const domain = Domain.make({
			principal: Caller,
			resources: [Wide],
			limits: { catalogFields: 200_000 },
		})
		assert.isDefined(domain.resources)
	}, 60_000)

	it("stops a Schema with more fields than its domain takes", () => {
		const wide = Resource.make("Wide", {
			actions: ["read"],
			fields: Object.fromEntries(
				Array.from({ length: 1001 }, (_, index) => [
					`f${String(index)}`,
					Schema.String,
				]),
			),
		})
		assert.doesNotThrow(() =>
			Domain.make({ principal: Caller, resources: [wide] }),
		)
		assert.throws(
			() =>
				Domain.make({
					principal: Caller,
					resources: [wide],
					limits: { catalogFields: 1000 },
				}),
			/The Schema of the resource "Wide" has 1001 fields. The most is 1000./,
		)
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

/** Gives each place of the catalog with a path of names for one value. */
const placesOf = (
	catalog: Catalog.Catalog,
	branch: Catalog.Branch,
	value: unknown,
	names: ReadonlyArray<string>,
): ReadonlyArray<readonly [Catalog.Branch, ReadonlyArray<string>]> => {
	const here = names.length === 0 ? [] : [[branch, names] as const]
	const below = readPath(value, names)
	// Below a part that is not an object, a read gives `null`. The walk checks
	// one more level there and stops, since a recursive Schema has no end.
	if (typeof below !== "object" || below === null) {
		return [
			...here,
			...Arr.map(
				branch.children,
				([name, id]) => [catalog.branches[id]!, [...names, name]] as const,
			),
		]
	}
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
		...Arr.flatMap(branch.children, ([name, id]) =>
			placesOf(catalog, catalog.branches[id]!, value, [...names, name]),
		),
		...(branch.keyBranch === undefined
			? []
			: Arr.flatMap(keys, (key) =>
					placesOf(catalog, catalog.branches[branch.keyBranch!]!, value, [
						...names,
						key,
					]),
				)),
	]
}

/** Tests that each value that a read gives fits the kinds of its field. */
const fitsCatalog = (ast: SchemaAST.AST, value: unknown): boolean => {
	const catalog = Catalog.catalogOf(ast)
	return Arr.every(
		placesOf(catalog, catalog.root, value, []),
		([branch, names]) => Catalog.accepts(branch.kinds, readPath(value, names)),
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
