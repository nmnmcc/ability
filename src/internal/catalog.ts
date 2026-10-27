/** A fixed directory of the data fields of a Schema. */
import * as Arr from "effect/Array"
import type * as SchemaAST from "effect/SchemaAST"

/** The kinds of values that a field may hold. */
export interface Kinds {
	/** The field may be `null`, `undefined` or missing. */
	readonly null: boolean
	readonly boolean: boolean
	/** The field may hold any string. */
	readonly string: boolean
	/** The numbers that the field may hold. */
	readonly number: "none" | "integer" | "finite" | "any"
	/** The field may hold an object, or a value that is not a scalar. */
	readonly object: boolean
	/** Single values that the field may hold, other than the ones above. */
	readonly literals: ReadonlyArray<string | number | boolean>
}

/** No value: the kinds of a field of `Schema.Never`. */
export const noKinds: Kinds = {
	null: false,
	boolean: false,
	string: false,
	number: "none",
	object: false,
	literals: [],
}

/** Any value. */
export const anyKinds: Kinds = {
	null: true,
	boolean: true,
	string: true,
	number: "any",
	object: true,
	literals: [],
}

const nullKinds: Kinds = { ...noKinds, null: true }
const objectKinds: Kinds = { ...noKinds, object: true }

const numberOrder = ["none", "integer", "finite", "any"] as const

/** The kinds of a field that may hold a value of `left` or of `right`. */
export const joinKinds = (left: Kinds, right: Kinds): Kinds => ({
	null: left.null || right.null,
	boolean: left.boolean || right.boolean,
	string: left.string || right.string,
	number:
		numberOrder.indexOf(left.number) >= numberOrder.indexOf(right.number)
			? left.number
			: right.number,
	object: left.object || right.object,
	// A native `Set` finds copies about ten times as fast as `Arr.dedupe`. It
	// takes `0` and `-0` as one, as `includes` does when a test reads them.
	literals: Array.from(new Set([...left.literals, ...right.literals])),
})

/** Tests if a number fits the numbers of a field. */
export const fitsNumber = (number: Kinds["number"], value: number): boolean => {
	switch (number) {
		case "none":
			return false
		case "integer":
			return Number.isSafeInteger(value)
		case "finite":
			return Number.isFinite(value)
		case "any":
			return true
	}
}

/**
 * Tests if a field with these kinds may hold a value. A missing value and
 * `undefined` are `null`.
 */
export const accepts = (kinds: Kinds, value: unknown): boolean => {
	if (value === null || value === undefined) {
		return kinds.null
	}
	switch (typeof value) {
		case "boolean":
			return kinds.boolean || kinds.literals.includes(value)
		case "string":
			return kinds.string || kinds.literals.includes(value)
		case "number":
			return fitsNumber(kinds.number, value) || kinds.literals.includes(value)
		default:
			return kinds.object
	}
}

/** One named data field. Complex values stay whole. */
export interface Field {
	readonly path: ReadonlyArray<string>
	readonly text: string
	readonly kinds: Kinds
	/** A field that can appear in a list of granted fields. */
	readonly listed: boolean
	/** The value has parts, so a denial below it blocks its whole value. */
	readonly open: boolean
	readonly plain: boolean
	/** Ordinary comparisons read only known scalar values. */
	readonly scalar: boolean
}

/** The fields and proof support of one Schema. */
export interface Catalog {
	readonly fields: ReadonlyArray<Field>
	readonly supported: boolean
	readonly inhabited: boolean
}

interface Shape {
	readonly kinds: Kinds
	readonly struct?: SchemaAST.Objects
	readonly supported: boolean
	readonly inhabited: boolean
}

const hasKinds = (kinds: Kinds): boolean =>
	kinds.null ||
	kinds.boolean ||
	kinds.string ||
	kinds.number !== "none" ||
	kinds.object ||
	kinds.literals.length > 0

/** Only these two checks have a model in the value search. */
const checksOf = (
	ast: SchemaAST.AST,
): {
	readonly supported: boolean
	readonly number: Kinds["number"]
} => {
	const checks = ast.checks ?? []
	const ids = Arr.map(checks, (check) => check.annotations?.representation?.id)
	return {
		supported: Arr.every(
			ids,
			(id) =>
				ast._tag === "Number" &&
				(id === "effect/schema/isInt" || id === "effect/schema/isFinite"),
		),
		number: ids.includes("effect/schema/isInt")
			? "integer"
			: ids.includes("effect/schema/isFinite")
				? "finite"
				: "any",
	}
}

/** A standard class has one struct and its own single construction step. */
const classStruct = (
	ast: SchemaAST.Declaration,
): SchemaAST.Objects | undefined => {
	const [inner] = ast.typeParameters
	return ast.annotations?.["~constructor"] !== undefined &&
		ast.typeParameters.length === 1 &&
		inner?._tag === "Objects" &&
		ast.encoding?.length === 1 &&
		ast.encoding[0]?.to === inner
		? inner
		: undefined
}

/** Read the known parts of a Schema. Unknown parts stay opaque. */
const shapeOf = (ast: SchemaAST.AST): Shape => {
	if (
		ast.encoding !== undefined &&
		!(ast._tag === "Declaration" && classStruct(ast) !== undefined)
	) {
		return { kinds: anyKinds, supported: false, inhabited: true }
	}
	const checks = checksOf(ast)
	const supported = checks.supported && ast.encoding === undefined
	const scalar = (kinds: Kinds): Shape => ({
		kinds,
		supported,
		inhabited: hasKinds(kinds),
	})
	switch (ast._tag) {
		case "Null":
		case "Undefined":
			return scalar(nullKinds)
		case "Never":
			return scalar(noKinds)
		case "String":
			return scalar({ ...noKinds, string: true })
		case "Boolean":
			return scalar({ ...noKinds, boolean: true })
		case "Number":
			return scalar({ ...noKinds, number: checks.number })
		case "Literal":
			return typeof ast.literal === "bigint"
				? { kinds: objectKinds, supported: false, inhabited: true }
				: scalar({ ...noKinds, literals: [ast.literal] })
		case "Enum":
			return scalar({
				...noKinds,
				literals: Arr.map(ast.enums, ([, value]) => value),
			})
		case "Objects":
			return ast.indexSignatures.length === 0 && ast.encoding === undefined
				? { kinds: objectKinds, struct: ast, supported, inhabited: true }
				: { kinds: objectKinds, supported: false, inhabited: true }
		case "Declaration": {
			const struct = classStruct(ast)
			return struct === undefined
				? { kinds: anyKinds, supported: false, inhabited: true }
				: {
						...shapeOf(struct),
						supported: checks.supported && checksOf(struct).supported,
					}
		}
		case "Union": {
			const parts = Arr.map(ast.types, (member) => shapeOf(member))
			const kinds = Arr.reduce(parts, noKinds, (all, part) =>
				joinKinds(all, part.kinds),
			)
			const objects = Arr.filter(parts, (part) => part.kinds.object)
			const nullableStruct =
				objects.length === 1 &&
				objects[0]?.struct !== undefined &&
				Arr.every(
					parts,
					(part) =>
						part === objects[0] || !hasKinds({ ...part.kinds, null: false }),
				)
			return {
				kinds,
				...(nullableStruct ? { struct: objects[0]!.struct! } : {}),
				supported:
					supported &&
					objects.length === 0 &&
					Arr.every(parts, (part) => part.supported),
				inhabited: Arr.some(parts, (part) => part.inhabited),
			}
		}
		default:
			return { kinds: anyKinds, supported: false, inhabited: true }
	}
}

/** Builds a directory once. Recursive and open shapes are never expanded. */
export const catalogOf = (ast: SchemaAST.AST): Catalog => {
	const fields: Array<Field> = []
	const state = { supported: true }
	const visit = (
		node: SchemaAST.AST,
		path: ReadonlyArray<string>,
		missing: boolean,
	): boolean => {
		const shape = shapeOf(node)
		const optional = missing || node.context?.isOptional === true
		const kinds = optional ? joinKinds(shape.kinds, nullKinds) : shape.kinds
		state.supported &&= shape.supported
		const struct = shape.struct
		if (struct !== undefined && (optional || kinds.null)) {
			state.supported = false
		}
		const children = struct?.propertySignatures ?? []
		const expand = struct !== undefined
		if (path.length > 0) {
			fields.push({
				path,
				text: path.join("."),
				kinds,
				listed: !expand || children.length === 0,
				open: kinds.object,
				plain: true,
				scalar: !shape.kinds.object,
			})
		}
		if (!expand) {
			return shape.inhabited || optional
		}
		const inhabited = Arr.reduce(children, true, (all, child) => {
			if (typeof child.name === "symbol") {
				state.supported = false
				return all
			}
			const name = String(child.name)
			if (name === "" || name.includes(".") || name.includes("*")) {
				throw new Error(
					`A field name must be nonempty and have no dot or star: "${name}"`,
				)
			}
			const childInhabited = visit(
				child.type,
				[...path, name],
				optional || kinds.null,
			)
			return all && childInhabited
		})
		return inhabited || optional || kinds.null
	}
	const inhabited = visit(ast, [], false)
	return { fields, supported: state.supported, inhabited }
}

/** Finds one exact path in the directory. */
export const lookup = (catalog: Catalog, text: string): Field | undefined =>
	catalog.fields.find((field) => field.text === text)

/** Lists a field before the fields below it. */
export const fieldsOf = (catalog: Catalog): ReadonlyArray<Field> =>
	catalog.fields
