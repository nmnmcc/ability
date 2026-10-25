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
 * Checks that an object of the input is a plain object or a plain list. A
 * list is a plain list only with the prototype of `Array`: a subclass of
 * `Array` may have a field, as a getter `when`, too.
 */
const checkPrototype = (input: object, at: Place.Place | undefined): void => {
	const prototype: unknown = Object.getPrototypeOf(input)
	if (
		prototype !== Object.prototype &&
		prototype !== null &&
		prototype !== Array.prototype
	) {
		throw problemAt(
			at,
			"A part of the input is not plain data: it is not a plain object",
		)
	}
}

/**
 * Checks that an object of the input is plain JSON data: a plain object or
 * a plain list, with no field that a loop over the keys does not see, other
 * than the `length` of a list. A walk that counts the fields that a loop
 * sees, as for a `meta`, must see every field that a Schema may read after.
 */
export const checkPlain = (
	input: object,
	at: Place.Place | undefined,
): void => {
	checkPrototype(input, at)
	const list = Array.isArray(input)
	if (
		!Arr.every(
			Reflect.ownKeys(input),
			(key) =>
				(list && key === "length") ||
				(typeof key === "string" &&
					Object.prototype.propertyIsEnumerable.call(input, key)),
		)
	) {
		throw problemAt(
			at,
			"A part of the input is not plain data: it has a field that a loop does not see",
		)
	}
}

/**
 * Reads a field of the input at the place `at`. JSON has only plain objects
 * and lists, with fields that a loop over the keys sees. So an object with
 * another prototype, as a value of a class, is a problem: its prototype may
 * have a field, as a method `when`, that a read of a condition would take as
 * missing, and a rule that loses its condition allows more. A field that is
 * not an own data field that a loop sees is a problem too. A missing field
 * reads `null`.
 */
export const read = (
	input: unknown,
	name: string,
	at: Place.Place | undefined,
): unknown => {
	if (typeof input !== "object" || input === null) {
		return null
	}
	checkPrototype(input, at)
	const property = Object.getOwnPropertyDescriptor(input, name)
	if (property === undefined) {
		return null
	}
	if (property.enumerable !== true || !("value" in property)) {
		throw problemAt(Place.at(at, name), `The field "${name}" is not plain data`)
	}
	return property.value === undefined ? null : property.value
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
/**
 * A count of the nodes of a larger input, as a policy, that the nodes and
 * values of a condition count in. It throws past its limit.
 */
export type Outer = (more: number, at: Place.Place | undefined) => void

const decoder = (
	budget: Budget,
	outer: Outer | undefined,
): ((part: Part) => Node) => {
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
		// The limit of the condition comes first, as it is the nearer one.
		const counted = (more: number): void => {
			count.nodes += more
			if (count.nodes > budget.limits.conditionNodes) {
				throw problemAt(
					at,
					`A condition has more than ${String(budget.limits.conditionNodes)} nodes and values. The most is ${String(budget.limits.conditionNodes)}.`,
				)
			}
			outer?.(more, at)
		}
		counted(1)
		// The values of an `In` or an `Under` test count in the weight of the
		// condition. The length of the list counts before the decoder reads
		// any value, so a very long list stops before it takes memory.
		const operands = (name: string): ReadonlyArray<Nodes.Operand> => {
			const list = read(input, name, at)
			if (Array.isArray(list)) {
				counted(list.length)
			}
			return decodeOperands(input, name, at, budget)
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
								values: operands("values"),
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
								prefix: operands("prefix"),
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
	outer?: Outer,
): Node => decoder(budget, outer)({ input, at })

/** Decodes the JSON form of a condition, with the default limits. */
export const decode = (input: unknown): Result.Result<Node, Problem> => {
	try {
		return Result.succeed(
			decoder(
				{ used: 0, limits: Limits.defaults },
				undefined,
			)({
				input,
				at: undefined,
			}),
		)
	} catch (error) {
		if (error instanceof Problem) {
			return Result.fail(error)
		}
		throw error
	}
}
