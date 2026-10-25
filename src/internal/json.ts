/**
 * The JSON form of a condition. The decoder is a walk of the trampoline, so a
 * deep input does not fill the stack. It reads at most `jsonNodes` objects
 * and array items, with a shared object counted for each place, so no input
 * can take a very long time. It makes
 * each node with its constructor, and it reads only the own data fields of
 * the input, as a condition reads a value.
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Result from "effect/Result"
import type * as SchemaIssue from "effect/SchemaIssue"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as Place from "./place.ts"
import { readPart } from "./read.ts"
import * as Trampoline from "./trampoline.ts"

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

/**
 * The count of the objects and items that one decode has read, with the
 * limits of the decode. It belongs to one decode.
 */
export interface Budget {
	used: number
	readonly limits: Limits.Limits
}

export const problem = (path: ReadonlyArray<PropertyKey>, message: string) =>
	new Problem({ path, message })

/**
 * The problem at a place of the input. A decoder keeps the place of each
 * part, which shares the path of its parent, and makes the full path only for
 * a problem: see `Place`.
 */
export const problemAt = (at: Place.Place | undefined, message: string) =>
	problem(Place.pathOf(at), message)

/** Counts `count` more objects or items, and stops past the limit. */
export const spend = (
	budget: Budget,
	count: number,
	at: Place.Place | undefined,
): void => {
	budget.used += count
	const most = budget.limits.jsonNodes
	if (budget.used > most) {
		throw problemAt(
			at,
			`The input has more than ${String(most)} objects and items. The most is ${String(most)}.`,
		)
	}
}

/**
 * Reads a field of the input at the place `at`. A field that is not plain
 * data is a problem.
 */
export const read = (
	input: unknown,
	name: string,
	at: Place.Place | undefined,
): unknown => {
	try {
		return readPart(input, name)
	} catch {
		throw problemAt(Place.at(at, name), `The field "${name}" is not plain data`)
	}
}

export const readString = (
	input: unknown,
	name: string,
	at: Place.Place | undefined,
): string => {
	const value = read(input, name, at)
	if (typeof value !== "string") {
		throw problemAt(Place.at(at, name), `The field "${name}" must be a string`)
	}
	return value
}

/** Reads the items of an array. The place of an item is `at`, `name`, index. */
export const readList = (
	input: unknown,
	name: string,
	at: Place.Place | undefined,
	budget: Budget,
): ReadonlyArray<unknown> => {
	const value = read(input, name, at)
	const place = Place.at(at, name)
	if (!Array.isArray(value)) {
		throw problemAt(place, `The field "${name}" must be an array`)
	}
	const list: ReadonlyArray<unknown> = value
	spend(budget, list.length, place)
	// `Array.makeBy` of Effect gives at least one item, so it can not make an
	// empty list. An array-like object with a length makes one with no read
	// of the items before the read rule.
	return Array.from({ length: list.length }, (_, index) =>
		read(list, String(index), place),
	)
}

/**
 * Reads a field path, and stops one with more parts than the limit of the
 * decode. A node checks the ceiling only, since it does not know its domain.
 */
const readPath = (
	input: unknown,
	name: string,
	at: Place.Place | undefined,
	budget: Budget,
): string => {
	const path = readString(input, name, at)
	const most = budget.limits.fieldPathParts
	const parts = path.split(".", most + 1).length
	if (parts > most) {
		throw problemAt(
			Place.at(at, name),
			`A field path has more than ${String(most)} parts. The most is ${String(most)}.`,
		)
	}
	return path
}

const isJsonScalar = (value: unknown): value is Nodes.Scalar =>
	Nodes.isScalar(value) && (typeof value !== "number" || Number.isFinite(value))

const decodeOperand = (
	input: unknown,
	at: Place.Place | undefined,
	budget: Budget,
): Nodes.Operand => {
	const tag = read(input, "_tag", at)
	if (tag === "Literal") {
		// A missing value is not `null`: a test with `null` has its own
		// meaning, and a lost value must not become one.
		const own =
			typeof input === "object" && input !== null
				? Object.getOwnPropertyDescriptor(input, "value")
				: undefined
		if (own === undefined || ("value" in own && own.value === undefined)) {
			throw problemAt(Place.at(at, "value"), "A fixed value is missing")
		}
		const value = read(input, "value", at)
		if (!isJsonScalar(value)) {
			throw problemAt(
				Place.at(at, "value"),
				"A fixed value must be a string, a finite number, a boolean or null",
			)
		}
		return Nodes.literal(value)
	}
	if (tag === "Principal") {
		return Nodes.principalRef(readPath(input, "path", at, budget))
	}
	throw problemAt(
		Place.at(at, "_tag"),
		'An operand must have the tag "Literal" or "Principal"',
	)
}

const decodeOperands = (
	input: unknown,
	name: string,
	at: Place.Place | undefined,
	budget: Budget,
): ReadonlyArray<Nodes.Operand> =>
	Arr.map(readList(input, name, at, budget), (operand, index) =>
		decodeOperand(operand, Place.at(at, name, index), budget),
	)

/** A part of the input to decode, with its place. */
interface Part {
	readonly input: unknown
	readonly at: Place.Place | undefined
}

/**
 * The decoder of a condition, with the budget of one decode. It is a walk of
 * the trampoline for an input of unknown depth, so a deep input does not fill
 * the stack.
 */
const decoder = (budget: Budget): ((part: Part) => Node) => {
	// The nodes of this condition that the decoder has read. A condition with
	// more nodes than `conditionNodes` does not load, so the decoder stops at
	// the first node past it, and it does not read the rest of a very large
	// input. The count belongs to the decode of one condition.
	const count = { nodes: 0 }
	return Trampoline.adaptive<Part, Node>((R, child) => (part, depth) => {
		const { input, at } = part
		if (typeof input !== "object" || input === null) {
			throw problemAt(at, "A condition node must be an object")
		}
		spend(budget, 1, at)
		count.nodes += 1
		if (count.nodes > budget.limits.conditionNodes) {
			throw problemAt(
				at,
				`A condition has more than ${String(budget.limits.conditionNodes)} nodes and values. The most is ${String(budget.limits.conditionNodes)}.`,
			)
		}
		// A node past a limit, such as a field path with too many parts, is a
		// problem at its place. The constructor checks the ceilings, and the
		// decoder checks the limits of the decode.
		const make = (build: () => Node): Node => {
			const node = (() => {
				try {
					return build()
				} catch (error) {
					if (error instanceof Limits.LimitExceeded) {
						throw problemAt(at, error.message)
					}
					throw error
				}
			})()
			const most = budget.limits.conditionNodes
			if (node.weight > most) {
				throw problemAt(
					at,
					`A condition has ${String(node.weight)} nodes and values. The most is ${String(most)}.`,
				)
			}
			return node
		}
		const children = (name: string) =>
			R.forEach(readList(input, name, at, budget), (item, index) =>
				child({ input: item, at: Place.at(at, name, index) }, depth + 1),
			)
		const tag = read(input, "_tag", at)
		switch (tag) {
			case "True":
				return R.succeed(Nodes.always)
			case "False":
				return R.succeed(Nodes.never)
			case "Compare": {
				const op = readString(input, "op", at)
				if (!Nodes.isCompareOperator(op)) {
					throw problemAt(
						Place.at(at, "op"),
						`"${op}" is not a compare operator`,
					)
				}
				return R.succeed(
					make(
						() =>
							new Nodes.Compare({
								op,
								field: readPath(input, "field", at, budget),
								value: decodeOperand(
									read(input, "value", at),
									Place.at(at, "value"),
									budget,
								),
							}),
					),
				)
			}
			case "In":
				return R.succeed(
					make(
						() =>
							new Nodes.In({
								field: readPath(input, "field", at, budget),
								values: decodeOperands(input, "values", at, budget),
							}),
					),
				)
			case "Exists":
				return R.succeed(
					make(
						() =>
							new Nodes.Exists({ field: readPath(input, "field", at, budget) }),
					),
				)
			case "Under":
				return R.succeed(
					make(
						() =>
							new Nodes.Under({
								prefix: decodeOperands(input, "prefix", at, budget),
							}),
					),
				)
			case "And":
				return R.map(children("conditions"), (conditions) =>
					make(() => new Nodes.And(conditions)),
				)
			case "Or":
				return R.map(children("conditions"), (conditions) =>
					make(() => new Nodes.Or(conditions)),
				)
			case "Not":
				return R.map(
					child(
						{
							input: read(input, "condition", at),
							at: Place.at(at, "condition"),
						},
						depth + 1,
					),
					(condition) => make(() => new Nodes.Not(condition)),
				)
			default:
				throw problemAt(Place.at(at, "_tag"), "The node has no known tag")
		}
	})
}

/**
 * Decodes the JSON form of a condition at a path, with the budget of a larger
 * decode. It throws a {@link Problem}.
 */
export const decodeAt = (
	input: unknown,
	at: Place.Place | undefined,
	budget: Budget,
): Node => decoder(budget)({ input, at })

/** Decodes the JSON form of a condition, with the default limits. */
export const decode = (input: unknown): Result.Result<Node, Problem> => {
	try {
		return Result.succeed(
			decoder({ used: 0, limits: Limits.defaults })({ input, at: undefined }),
		)
	} catch (error) {
		if (error instanceof Problem) {
			return Result.fail(error)
		}
		throw error
	}
}
