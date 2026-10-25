/**
 * The nodes of a condition. Each node is a class, and only its constructor
 * makes one, also when a condition comes from JSON. The constructor checks the
 * data of the node and works out three facts once:
 * - `size`: the number of nodes, with a shared child counted for each place;
 * - `depth`: the number of levels;
 * - `opaque`: the node has a predicate.
 *
 * The constructor stops a node that goes past `conditionNodes` or
 * `conditionDepth`. So a walk over any condition visits at most
 * `conditionNodes` nodes and goes at most `conditionDepth` levels down, and it
 * needs no memo.
 *
 * The facts are private fields, so `Equal` and `Hash` do not read them: two
 * nodes with the same data are equal.
 */
// A predicate gives an Effect with an error type and a service type that the
// nodes do not know, so they are `unknown` here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import { hasProperty } from "effect/Predicate"
import * as Limits from "./limits.ts"

/** A value that a condition can compare. */
export type Scalar = string | number | boolean | null

export type CompareOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte"

/** A fixed value. */
export interface Literal {
	readonly _tag: "Literal"
	readonly value: Scalar
}

/** A field of the principal. */
export interface PrincipalRef {
	readonly _tag: "Principal"
	readonly path: string
}

export type Operand = Literal | PrincipalRef

const operands = Data.taggedEnum<Operand>()

export const literal = (value: Scalar): Literal => operands.Literal({ value })

export const principalRef = (path: string): PrincipalRef =>
	operands.Principal({ path })

const compareOperators: ReadonlyArray<string> = [
	"eq",
	"ne",
	"lt",
	"lte",
	"gt",
	"gte",
]

/** Tests if a value is a scalar. Any number is one, also `NaN`. */
export const isScalar = (value: unknown): value is Scalar =>
	value === null ||
	typeof value === "string" ||
	typeof value === "number" ||
	typeof value === "boolean"

/**
 * Checks a field path: a string with at most `fieldPathParts` parts. A longer
 * path is never a field of a resource or of the principal.
 */
const checkPath = (path: unknown): string => {
	if (typeof path !== "string") {
		throw new Error("A field path must be a string")
	}
	const parts = path.split(".", Limits.fieldPathParts + 1).length
	if (parts > Limits.fieldPathParts) {
		throw Limits.exceeded(
			"A field path",
			"fieldPathParts",
			"parts",
			parts,
			Limits.fieldPathParts,
		)
	}
	return path
}

/** Checks an operand, and gives a new one with only its data. */
const checkOperand = (operand: unknown): Operand => {
	if (hasProperty(operand, "_tag")) {
		if (
			operand._tag === "Literal" &&
			hasProperty(operand, "value") &&
			isScalar(operand.value)
		) {
			return literal(operand.value)
		}
		if (operand._tag === "Principal" && hasProperty(operand, "path")) {
			return principalRef(checkPath(operand.path))
		}
	}
	throw new Error(
		"An operand must be a fixed scalar value or a field of the principal",
	)
}

const checkOperands = (values: unknown): ReadonlyArray<Operand> => {
	if (!Array.isArray(values)) {
		throw new Error("A list of operands must be an array")
	}
	return Object.freeze(Arr.map(Array.from(values), checkOperand))
}

interface Facts {
	readonly size: number
	readonly depth: number
	readonly opaque: boolean
}

const leaf: Facts = { size: 1, depth: 1, opaque: false }

/** The facts of a node with children. It stops a node past the limits. */
const factsOf = (children: ReadonlyArray<Node>): Facts => {
	const size = Arr.reduce(children, 1, (total, child) => total + child.size)
	if (size > Limits.conditionNodes) {
		throw Limits.exceeded(
			"A condition",
			"conditionNodes",
			"nodes",
			size,
			Limits.conditionNodes,
		)
	}
	const depth =
		1 + Arr.reduce(children, 0, (top, child) => Math.max(top, child.depth))
	if (depth > Limits.conditionDepth) {
		throw Limits.exceeded(
			"A condition",
			"conditionDepth",
			"levels",
			depth,
			Limits.conditionDepth,
		)
	}
	return {
		size,
		depth,
		opaque: Arr.some(children, (child) => child.opaque),
	}
}

/** The base of every node. It keeps the facts. */
abstract class Base extends Data.Class {
	readonly #facts: Facts

	constructor(props: object, facts: Facts) {
		super(props as never)
		this.#facts = facts
	}

	/** The number of nodes, with a shared child counted for each place. */
	get size(): number {
		return this.#facts.size
	}

	/** The number of levels. */
	get depth(): number {
		return this.#facts.depth
	}

	/** The node has a predicate. */
	get opaque(): boolean {
		return this.#facts.opaque
	}
}

/** Always true. */
export class True extends Base {
	readonly _tag = "True"
	constructor() {
		super({}, leaf)
	}
}

/** Always false. */
export class False extends Base {
	readonly _tag = "False"
	constructor() {
		super({}, leaf)
	}
}

/** Compares a field with a value. */
export class Compare extends Base {
	readonly _tag = "Compare"
	declare readonly op: CompareOperator
	declare readonly field: string
	declare readonly value: Operand
	constructor(props: {
		readonly op: CompareOperator
		readonly field: string
		readonly value: Operand
	}) {
		if (!compareOperators.includes(props.op)) {
			throw new Error(`"${String(props.op)}" is not a compare operator`)
		}
		super(
			{
				op: props.op,
				field: checkPath(props.field),
				value: checkOperand(props.value),
			},
			leaf,
		)
	}
}

/** True when a field is equal to one of the values. */
export class In extends Base {
	readonly _tag = "In"
	declare readonly field: string
	declare readonly values: ReadonlyArray<Operand>
	constructor(props: {
		readonly field: string
		readonly values: ReadonlyArray<Operand>
	}) {
		super(
			{ field: checkPath(props.field), values: checkOperands(props.values) },
			leaf,
		)
	}
}

/** True when a field is not `null` and not missing. */
export class Exists extends Base {
	readonly _tag = "Exists"
	declare readonly field: string
	constructor(props: { readonly field: string }) {
		super({ field: checkPath(props.field) }, leaf)
	}
}

/** True when the path of the resource starts with the prefix. */
export class Under extends Base {
	readonly _tag = "Under"
	declare readonly prefix: ReadonlyArray<Operand>
	constructor(props: { readonly prefix: ReadonlyArray<Operand> }) {
		super({ prefix: checkOperands(props.prefix) }, leaf)
	}
}

const checkChildren = (conditions: unknown): ReadonlyArray<Node> => {
	if (!Array.isArray(conditions)) {
		throw new Error("The children of a node must be an array")
	}
	const children = Array.from(conditions as ReadonlyArray<unknown>)
	if (!Arr.every(children, isNode)) {
		throw notNode()
	}
	return Object.freeze(children)
}

export class And extends Base {
	readonly _tag = "And"
	declare readonly conditions: ReadonlyArray<Node>
	constructor(conditions: ReadonlyArray<Node>) {
		const children = checkChildren(conditions)
		super({ conditions: children }, factsOf(children))
	}
}

export class Or extends Base {
	readonly _tag = "Or"
	declare readonly conditions: ReadonlyArray<Node>
	constructor(conditions: ReadonlyArray<Node>) {
		const children = checkChildren(conditions)
		super({ conditions: children }, factsOf(children))
	}
}

export class Not extends Base {
	readonly _tag = "Not"
	declare readonly condition: Node
	constructor(condition: Node) {
		if (!isNode(condition)) {
			throw notNode()
		}
		super({ condition }, factsOf([condition]))
	}
}

/** A test that runs an `Effect`. */
export class Predicate extends Base {
	readonly _tag = "Predicate"
	declare readonly name: string
	declare readonly run: (
		value: unknown,
		principal: unknown,
	) => Effect.Effect<boolean, unknown, unknown>
	constructor(props: {
		readonly name: string
		readonly run: (
			value: unknown,
			principal: unknown,
		) => Effect.Effect<boolean, unknown, unknown>
	}) {
		if (typeof props.name !== "string" || typeof props.run !== "function") {
			throw new Error("A predicate needs a name and a test")
		}
		super(
			{ name: props.name, run: props.run },
			{ size: 1, depth: 1, opaque: true },
		)
	}
}

/** A node of a condition. */
export type Node =
	True | False | Compare | In | Exists | Under | And | Or | Not | Predicate

/** Tests if a value is a node. Only a constructor of a node makes one. */
export const isNode = (u: unknown): u is Node => u instanceof Base

const notNode = (): Error =>
	new Error(
		"A condition must be made with a builder or a function of Condition. A plain object is not a condition",
	)

/** Gives a value as a node, or throws when it is not a node. */
export const toNode = (u: unknown): Node => {
	if (!isNode(u)) {
		throw notNode()
	}
	return u
}

export const always: Node = new True()

export const never: Node = new False()
