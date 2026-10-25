import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Result, Schema } from "effect"
import * as Catalog from "../src/internal/catalog.ts"
import * as Patterns from "../src/internal/patterns.ts"

const parse = (text: string): Patterns.Pattern =>
	Result.getOrThrow(Patterns.parse(text))

const matches = (text: string, field: string): boolean =>
	Patterns.matches(parse(text), field.split("."))

/** Makes a regular expression for a part with stars. */
const partRegex = (part: string): RegExp =>
	new RegExp(
		`^${part
			.split("*")
			.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("[^.]*")}$`,
	)

/**
 * A plain matcher to check the real one: it tries each way to match, and it
 * goes back when a way fails. A pattern that matches the names before the end
 * matches the field too.
 */
const reference = (
	parts: ReadonlyArray<string>,
	names: ReadonlyArray<string>,
): boolean => {
	const [part, ...rest] = parts
	if (part === undefined) {
		return true
	}
	if (part === "**") {
		return (
			reference(rest, names) ||
			(names.length > 0 && reference(parts, names.slice(1)))
		)
	}
	const [name, ...after] = names
	return (
		name !== undefined && partRegex(part).test(name) && reference(rest, after)
	)
}

describe("Patterns", () => {
	it("matches names, stars inside a part, and **", () => {
		assert.isTrue(matches("name", "name"))
		assert.isFalse(matches("name", "names"))
		assert.isTrue(matches("secret*", "secretKey"))
		assert.isTrue(matches("*Key", "secretKey"))
		assert.isTrue(matches("s*c*t", "secret"))
		assert.isFalse(matches("s*c*t", "secrets"))
		assert.isFalse(matches("a*a", "a"))
		assert.isTrue(matches("**.secret", "secret"))
		assert.isTrue(matches("**.secret", "a.b.secret"))
		assert.isTrue(matches("a.**.b", "a.b"))
		assert.isFalse(matches("a.**.b", "a"))
	})

	it("matches the fields below a field that it matches", () => {
		assert.isTrue(matches("pay", "pay.amount"))
		assert.isTrue(matches("pay.*", "pay.amount.cents"))
		assert.isFalse(matches("pay.amount", "pay"))
	})

	it("tells when a pattern may match a field below a field", () => {
		const below = (text: string, field: string) =>
			Patterns.matchesBelow(parse(text), field.split("."))
		assert.isTrue(below("settings.secret", "settings"))
		assert.isTrue(below("**.secret", "settings"))
		assert.isFalse(below("settings", "settings"))
		assert.isFalse(below("name.*", "settings"))
	})

	it("does not take ** inside a part, or too many parts", () => {
		assert.isTrue(Result.isFailure(Patterns.parse("a**")))
		assert.isTrue(Result.isFailure(Patterns.parse("***")))
		// A pattern has at most the `patternParts` of its domain.
		assert.isTrue(Result.isFailure(Patterns.parse("a.".repeat(16) + "a", 16)))
		assert.isTrue(Result.isSuccess(Patterns.parse("a.".repeat(15) + "a", 16)))
		assert.isTrue(Result.isSuccess(Patterns.parse("a.".repeat(999) + "a")))
		assert.isTrue(Result.isFailure(Patterns.parse("a.".repeat(1000) + "a")))
	})

	it("matches a key of a record by its Schema, and any key by a star", () => {
		const catalog = Catalog.catalogOf(
			Schema.Struct({
				tags: Schema.Record(
					Schema.TemplateLiteral(["x", Schema.String]),
					Schema.String,
				),
			}).ast,
		)
		const fits = (text: string) => Patterns.fitsCatalog(parse(text), catalog)
		assert.isTrue(fits("tags.x1"))
		assert.isFalse(fits("tags.y1"))
		assert.isTrue(fits("tags.y*"))
		assert.isTrue(fits("**"))
		assert.isFalse(fits("other"))
	})
})

describe("Patterns properties", () => {
	const Part = Schema.Literals(["a", "b", "ab", "*", "a*", "*b", "a*b", "**"])
	const Name = Schema.Literals(["a", "b", "ab", "ba", "aab", ""])
	const Parts = Schema.Array(Part).check(Schema.isMaxLength(8))
	const Names = Schema.Array(Name).check(Schema.isMaxLength(8))

	it.prop(
		"matches as a plain matcher that goes back does",
		{ parts: Parts, names: Names },
		({ parts, names }) =>
			Patterns.matches(parse(parts.join(".")), names) ===
			reference(parts.join(".").split("."), names),
	)

	const Tree = Schema.Struct({
		a: Schema.Struct({
			b: Schema.String,
			ab: Schema.Struct({ a: Schema.String }),
		}),
		b: Schema.String,
		ba: Schema.Struct({ b: Schema.Struct({ aab: Schema.String }) }),
	})
	const catalog = Catalog.catalogOf(Tree.ast)

	it.prop(
		"fits a catalog when it matches one of its fields",
		{ parts: Parts },
		({ parts }) =>
			Patterns.fitsCatalog(parse(parts.join(".")), catalog) ===
			Arr.some(Catalog.fieldsOf(catalog), (field) =>
				reference(parts.join(".").split("."), field.text.split(".")),
			),
	)
})
