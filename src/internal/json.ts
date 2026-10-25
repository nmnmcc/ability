/**
 * The JSON form of a condition. The decoder is a plain walk with two limits:
 * it goes at most `conditionDepth` levels down, and it reads at most
 * `jsonNodes` objects and array items, with a shared object counted for each
 * place. So no input can fill the stack or take a very long time. It makes
 * each node with its constructor, and it reads only the own data fields of
 * the input, as a condition reads a value.
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Result from "effect/Result"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import { readPart } from "./read.ts"

type Node = Nodes.Node

/** Gives the JSON form of a condition with no predicate. See `Nodes.toJson`. */
export const toJson = (node: Node): unknown => Nodes.toJson(node)

/** A problem of an input, with the path of the problem. */
export class Problem extends Data.TaggedError("Problem")<{
	readonly path: ReadonlyArray<PropertyKey>
	readonly message: string
	/** The issue of a Schema that the decode used, as for `meta`. */
	readonly issue?: SchemaIssue.Issue | undefined
}> {}

/** The count of the objects and items that one decode has read. It belongs to one decode. */
export interface Budget {
	used: number
}

export const problem = (path: ReadonlyArray<PropertyKey>, message: string) =>
	new Problem({ path, message })

/** Counts `count` more objects or items, and stops past the limit. */
export const spend = (
	budget: Budget,
	count: number,
	path: ReadonlyArray<PropertyKey>,
): void => {
	budget.used += count
	if (budget.used > Limits.jsonNodes) {
		throw problem(
			path,
			`The input has more than ${String(Limits.jsonNodes)} objects and items. The most is ${String(Limits.jsonNodes)}.`,
		)
	}
}

/** Reads a field of the input. A field that is not plain data is a problem. */
export const read = (
	input: unknown,
	name: string,
	path: ReadonlyArray<PropertyKey>,
): unknown => {
	try {
		return readPart(input, name)
	} catch {
		throw problem([...path, name], `The field "${name}" is not plain data`)
	}
}

export const readString = (
	input: unknown,
	name: string,
	path: ReadonlyArray<PropertyKey>,
): string => {
	const value = read(input, name, path)
	if (typeof value !== "string") {
		throw problem([...path, name], `The field "${name}" must be a string`)
	}
	return value
}

/** Reads the items of an array. */
export const readList = (
	input: unknown,
	name: string,
	path: ReadonlyArray<PropertyKey>,
	budget: Budget,
): ReadonlyArray<unknown> => {
	const value = read(input, name, path)
	const at = [...path, name]
	if (!Array.isArray(value)) {
		throw problem(at, `The field "${name}" must be an array`)
	}
	const list: ReadonlyArray<unknown> = value
	spend(budget, list.length, at)
	// `Array.makeBy` of Effect gives at least one item, so it can not make an
	// empty list. An array-like object with a length makes one with no read
	// of the items before the read rule.
	return Array.from({ length: list.length }, (_, index) =>
		read(list, String(index), at),
	)
}

const isJsonScalar = (value: unknown): value is Nodes.Scalar =>
	Nodes.isScalar(value) && (typeof value !== "number" || Number.isFinite(value))

const decodeOperand = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
): Nodes.Operand => {
	const tag = read(input, "_tag", path)
	if (tag === "Literal") {
		// A missing value is not `null`: a test with `null` has its own
		// meaning, and a lost value must not become one.
		const own =
			typeof input === "object" && input !== null
				? Object.getOwnPropertyDescriptor(input, "value")
				: undefined
		if (own === undefined || ("value" in own && own.value === undefined)) {
			throw problem([...path, "value"], "A fixed value is missing")
		}
		const value = read(input, "value", path)
		if (!isJsonScalar(value)) {
			throw problem(
				[...path, "value"],
				"A fixed value must be a string, a finite number, a boolean or null",
			)
		}
		return Nodes.literal(value)
	}
	if (tag === "Principal") {
		return Nodes.principalRef(readString(input, "path", path))
	}
	throw problem(
		[...path, "_tag"],
		'An operand must have the tag "Literal" or "Principal"',
	)
}

const decodeOperands = (
	input: unknown,
	name: string,
	path: ReadonlyArray<PropertyKey>,
	budget: Budget,
): ReadonlyArray<Nodes.Operand> =>
	Arr.map(readList(input, name, path, budget), (operand, index) =>
		decodeOperand(operand, [...path, name, index]),
	)

const compareOperators: ReadonlyArray<string> = [
	"eq",
	"ne",
	"lt",
	"lte",
	"gt",
	"gte",
]

const decodeNode = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
	depth: number,
	budget: Budget,
): Node => {
	if (depth > Limits.conditionDepth) {
		throw problem(
			path,
			`A condition has more than ${String(Limits.conditionDepth)} levels. The most is ${String(Limits.conditionDepth)}.`,
		)
	}
	if (typeof input !== "object" || input === null) {
		throw problem(path, "A condition node must be an object")
	}
	spend(budget, 1, path)
	const children = (name: string) =>
		Arr.map(readList(input, name, path, budget), (child, index) =>
			decodeNode(child, [...path, name, index], depth + 1, budget),
		)
	try {
		return makeNode(input, path, depth, budget, children)
	} catch (error) {
		// A node past a limit, such as a field path with too many parts, is a
		// problem at its place.
		if (error instanceof Limits.LimitExceeded) {
			throw problem(path, error.message)
		}
		throw error
	}
}

const makeNode = (
	input: object,
	path: ReadonlyArray<PropertyKey>,
	depth: number,
	budget: Budget,
	children: (name: string) => ReadonlyArray<Node>,
): Node => {
	const tag = read(input, "_tag", path)
	switch (tag) {
		case "True":
			return Nodes.always
		case "False":
			return Nodes.never
		case "Compare": {
			const op = readString(input, "op", path)
			if (!compareOperators.includes(op)) {
				throw problem([...path, "op"], `"${op}" is not a compare operator`)
			}
			return new Nodes.Compare({
				op: op as Nodes.CompareOperator,
				field: readString(input, "field", path),
				value: decodeOperand(read(input, "value", path), [...path, "value"]),
			})
		}
		case "In":
			return new Nodes.In({
				field: readString(input, "field", path),
				values: decodeOperands(input, "values", path, budget),
			})
		case "Exists":
			return new Nodes.Exists({ field: readString(input, "field", path) })
		case "Under":
			return new Nodes.Under({
				prefix: decodeOperands(input, "prefix", path, budget),
			})
		case "And":
			return new Nodes.And(children("conditions"))
		case "Or":
			return new Nodes.Or(children("conditions"))
		case "Not":
			return new Nodes.Not(
				decodeNode(
					read(input, "condition", path),
					[...path, "condition"],
					depth + 1,
					budget,
				),
			)
		default:
			throw problem([...path, "_tag"], "The node has no known tag")
	}
}

/**
 * Decodes the JSON form of a condition at a path, with the budget of a larger
 * decode. It throws a {@link Problem}.
 */
export const decodeAt = (
	input: unknown,
	path: ReadonlyArray<PropertyKey>,
	budget: Budget,
): Node => decodeNode(input, path, 1, budget)

/** Decodes the JSON form of a condition. */
export const decode = (input: unknown): Result.Result<Node, Problem> => {
	try {
		return Result.succeed(decodeNode(input, [], 1, { used: 0 }))
	} catch (error) {
		if (error instanceof Problem) {
			return Result.fail(error)
		}
		throw error
	}
}
