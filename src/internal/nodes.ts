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
import * as Schema from "effect/Schema"
import * as Limits from "./limits.ts"
import * as Trampoline from "./trampoline.ts"

/** A value that a condition can compare. */
export type Scalar = string | number | boolean | null

/** The operators of a `Compare` test. The decoders read this list too. */
export const CompareOperator = Schema.Literals([
	"eq",
	"ne",
	"lt",
	"lte",
	"gt",
	"gte",
])

export type CompareOperator = typeof CompareOperator.Type

/**
 * Tests if a value is an operator. It reads the list of the Schema with
 * `includes`: for a short list, this is about twice as fast as
 * `Schema.is`, and a decoder tests each node of a large input.
 */
export const isCompareOperator = (u: unknown): u is CompareOperator =>
	(CompareOperator.literals as ReadonlyArray<unknown>).includes(u)

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
	readonly weight: number
	readonly depth: number
	readonly opaque: boolean
}

const leaf: Facts = { size: 1, weight: 1, depth: 1, opaque: false }

/**
 * The facts of a test with values, as `In` and `Under`. Each value counts in
 * the weight, since a walk that reads the test reads its values too. It stops
 * a test past the limits.
 */
const valuesFacts = (values: ReadonlyArray<Operand>): Facts =>
	checkWeight({ ...leaf, weight: 1 + values.length })

const checkWeight = (facts: Facts): Facts => {
	if (facts.weight > Limits.conditionNodes) {
		throw Limits.exceeded(
			"A condition",
			"conditionNodes",
			"nodes and values",
			facts.weight,
			Limits.conditionNodes,
		)
	}
	return facts
}

/** The facts of a node with children. It stops a node past the limits. */
const factsOf = (children: ReadonlyArray<Node>): Facts => {
	const size = Arr.reduce(children, 1, (total, child) => total + child.size)
	const weight = Arr.reduce(children, 1, (total, child) => total + child.weight)
	checkWeight({ ...leaf, weight })
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
		weight,
		depth,
		opaque: Arr.some(children, (child) => child.opaque),
	}
}

/** The base of every node. It keeps the facts. */
abstract class Base extends Data.Class {
	/**
	 * The JSON form of the node, for `JSON.stringify`. A number that JSON can
	 * not hold, as `Infinity`, becomes an object that no decoder takes, in
	 * place of `null`, which would change the test.
	 */
	toJSON(): unknown {
		return toJson(this as unknown as Node)
	}

	readonly #facts: Facts

	constructor(props: object, facts: Facts) {
		super(props as never)
		this.#facts = facts
	}

	/** The number of nodes, with a shared child counted for each place. */
	get size(): number {
		return this.#facts.size
	}

	/**
	 * The number of nodes and of the values of their `In` and `Under` tests,
	 * with a shared child counted for each place. A walk that reads the tests
	 * does this much work, so the limits of the nodes count it.
	 */
	get weight(): number {
		return this.#facts.weight
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
		if (!isCompareOperator(props.op)) {
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
		const values = checkOperands(props.values)
		super({ field: checkPath(props.field), values }, valuesFacts(values))
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
		const prefix = checkOperands(props.prefix)
		super({ prefix }, valuesFacts(prefix))
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

/** The test of a predicate, with no types. */
export type Run = (
	value: unknown,
	principal: unknown,
) => Effect.Effect<boolean, unknown, unknown>

/**
 * A test that runs an `Effect`. Its test takes inputs of the type `never`, so
 * no code can call it with a value of the wrong type: `Condition.evaluate`
 * checks the input. Use {@link runOf} inside the library.
 */
export class Predicate extends Base {
	readonly _tag = "Predicate"
	declare readonly name: string
	declare readonly run: (
		value: never,
		principal: never,
	) => Effect.Effect<boolean, unknown, unknown>
	constructor(props: { readonly name: string; readonly run: Run }) {
		if (typeof props.name !== "string" || typeof props.run !== "function") {
			throw new Error("A predicate needs a name and a test")
		}
		super(
			{ name: props.name, run: props.run },
			{ size: 1, weight: 1, depth: 1, opaque: true },
		)
	}
}

/** Gives the test of a predicate, with no types. */
export const runOf = (node: Predicate): Run => node.run as Run

/** A node of a condition. */
export type Node =
	True | False | Compare | In | Exists | Under | And | Or | Not | Predicate

const operandJson = (operand: Operand): unknown =>
	operand._tag === "Literal"
		? {
				_tag: "Literal",
				// JSON has no `Infinity`, `-Infinity` or `NaN`. Such a number
				// becomes an object that the decoder does not take.
				value:
					typeof operand.value === "number" && !Number.isFinite(operand.value)
						? { nonFinite: String(operand.value) }
						: operand.value,
			}
		: { _tag: "Principal", path: operand.path }

/**
 * Gives the JSON form of a condition with no predicate. The walk takes the
 * steps of a trampoline, so a deep condition does not fill the stack.
 */
export const toJson = (root: Node): unknown =>
	Trampoline.run(root.depth, (R) => {
		const go = (node: Node): Trampoline.Step<unknown> => {
			switch (node._tag) {
				case "True":
				case "False":
					return R.succeed({ _tag: node._tag })
				case "Compare":
					return R.succeed({
						_tag: "Compare",
						op: node.op,
						field: node.field,
						value: operandJson(node.value),
					})
				case "In":
					return R.succeed({
						_tag: "In",
						field: node.field,
						values: Arr.map(node.values, operandJson),
					})
				case "Exists":
					return R.succeed({ _tag: "Exists", field: node.field })
				case "Under":
					return R.succeed({
						_tag: "Under",
						prefix: Arr.map(node.prefix, operandJson),
					})
				case "And":
				case "Or": {
					const tag = node._tag
					return R.map(
						R.forEach(node.conditions, (child) => R.suspend(() => go(child))),
						(conditions) => ({ _tag: tag, conditions }),
					)
				}
				case "Not":
					return R.map(
						R.suspend(() => go(node.condition)),
						(condition) => ({
							_tag: "Not",
							condition,
						}),
					)
				case "Predicate":
					throw new Error(
						`The predicate "${node.name}" can not become JSON. A condition with a predicate has no JSON form.`,
					)
			}
		}
		return go(root)
	})

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
