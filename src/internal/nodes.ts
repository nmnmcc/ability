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

/** A field of the principal, with the domain that made the reference. */
export class PrincipalRef extends Data.Class<{ readonly path: string }> {
	readonly _tag = "Principal"
	readonly #domain: object | undefined

	constructor(path: string, domain?: object) {
		super({ path })
		this.#domain = domain
	}

	static domainOf(ref: PrincipalRef): object | undefined {
		return ref.#domain
	}
}

export type Operand = Literal | PrincipalRef

const operands = Data.taggedEnum<Literal>()

export const literal = (value: Scalar): Literal => operands.Literal({ value })

export const principalRef = (path: string, domain?: object): PrincipalRef =>
	new PrincipalRef(path, domain)

export const principalDomainOf = (ref: PrincipalRef): object | undefined =>
	PrincipalRef.domainOf(ref)

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
	const most = Limits.fieldPathParts
	const parts = path.split(".", most + 1).length
	if (parts > most) {
		throw Limits.exceeded(
			"A field path",
			"fieldPathParts",
			"parts",
			parts,
			most,
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
			return principalRef(
				checkPath(operand.path),
				operand instanceof PrincipalRef
					? principalDomainOf(operand)
					: undefined,
			)
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
	checkWeight({ ...leaf, weight: 1 + values.length })
	return Object.freeze(Arr.map(values, checkOperand))
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

/** The domain that made a condition. This is not part of structural equality. */
export interface Origin {
	readonly domain: object
	readonly kind: string
}

const combinedOrigin = (children: ReadonlyArray<Node>): Origin | undefined =>
	Arr.reduce(children, undefined as Origin | undefined, (current, child) => {
		const origin = originOf(child)
		if (current === undefined) return origin
		if (origin === undefined) return current
		if (current.domain !== origin.domain)
			throw new Error("Conditions must come from the same domain")
		return current.kind === origin.kind
			? current
			: { domain: current.domain, kind: "*" }
	})

/** The base of every node. It keeps the facts. */
abstract class Base extends Data.Class {
	/**
	 * The JSON form of the node. Values that JSON can not hold give an error.
	 */
	toJSON(): unknown {
		return toJson(this as unknown as Node)
	}

	readonly #facts: Facts
	readonly #origin: Origin | undefined

	static originOf(node: Base): Origin | undefined {
		return node.#origin
	}

	constructor(props: object, facts: Facts, origin: Origin | undefined) {
		super(props as never)
		this.#facts = facts
		this.#origin = origin
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
	constructor(origin?: Origin) {
		super({}, leaf, origin)
	}
}

/** Always false. */
export class False extends Base {
	readonly _tag = "False"
	constructor(origin?: Origin) {
		super({}, leaf, origin)
	}
}

/** Compares a field with a value. */
export class Compare extends Base {
	readonly _tag = "Compare"
	declare readonly op: CompareOperator
	declare readonly field: string
	declare readonly value: Operand
	constructor(
		props: {
			readonly op: CompareOperator
			readonly field: string
			readonly value: Operand
		},
		origin?: Origin,
	) {
		if (!isCompareOperator(props.op)) {
			throw new Error(`"${String(props.op)}" is not a compare operator`)
		}
		super(
			{
				op: props.op,
				field: checkPath(props.field),
				value: checkOperand(props.value),
			},
			{ ...leaf, weight: 2 },
			origin,
		)
	}
}

/** True when a field is equal to one of the values. */
export class In extends Base {
	readonly _tag = "In"
	declare readonly field: string
	declare readonly values: ReadonlyArray<Operand>
	constructor(
		props: {
			readonly field: string
			readonly values: ReadonlyArray<Operand>
		},
		origin?: Origin,
	) {
		const values = checkOperands(props.values)
		super(
			{ field: checkPath(props.field), values },
			valuesFacts(values),
			origin,
		)
	}
}

/** True when a field is not `null` and not missing. */
export class Exists extends Base {
	readonly _tag = "Exists"
	declare readonly field: string
	constructor(props: { readonly field: string }, origin?: Origin) {
		super({ field: checkPath(props.field) }, leaf, origin)
	}
}

/** True when the path of the resource starts with the prefix. */
export class Under extends Base {
	readonly _tag = "Under"
	declare readonly prefix: ReadonlyArray<Operand>
	constructor(
		props: { readonly prefix: ReadonlyArray<Operand> },
		origin?: Origin,
	) {
		const prefix = checkOperands(props.prefix)
		super({ prefix }, valuesFacts(prefix), origin)
	}
}

const checkChildren = (conditions: unknown): ReadonlyArray<Node> => {
	if (!Array.isArray(conditions)) {
		throw new Error("The children of a node must be an array")
	}
	checkWeight({ ...leaf, weight: 1 + conditions.length })
	const children = Array.from(conditions as ReadonlyArray<unknown>)
	if (!Arr.every(children, isNode)) {
		throw notNode()
	}
	return Object.freeze(children)
}

export class And extends Base {
	readonly _tag = "And"
	declare readonly conditions: ReadonlyArray<Node>
	constructor(conditions: ReadonlyArray<Node>, origin?: Origin) {
		const children = checkChildren(conditions)
		super(
			{ conditions: children },
			factsOf(children),
			origin ?? combinedOrigin(children),
		)
	}
}

export class Or extends Base {
	readonly _tag = "Or"
	declare readonly conditions: ReadonlyArray<Node>
	constructor(conditions: ReadonlyArray<Node>, origin?: Origin) {
		const children = checkChildren(conditions)
		super(
			{ conditions: children },
			factsOf(children),
			origin ?? combinedOrigin(children),
		)
	}
}

export class Not extends Base {
	readonly _tag = "Not"
	declare readonly condition: Node
	constructor(condition: Node, origin?: Origin) {
		if (!isNode(condition)) {
			throw notNode()
		}
		super({ condition }, factsOf([condition]), origin ?? originOf(condition))
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
	constructor(
		props: { readonly name: string; readonly run: Run },
		origin?: Origin,
	) {
		if (typeof props.name !== "string" || typeof props.run !== "function") {
			throw new Error("A predicate needs a name and a test")
		}
		super(
			{ name: props.name, run: props.run },
			{ size: 1, weight: 1, depth: 1, opaque: true },
			origin,
		)
	}
}

/** Gives the test of a predicate, with no types. */
export const runOf = (node: Predicate): Run => node.run as Run

/** A node of a condition. */
export type Node =
	True | False | Compare | In | Exists | Under | And | Or | Not | Predicate

/** Gives the origin without exposing a mutable mark on a node. */
export const originOf = (node: Node): Origin | undefined => Base.originOf(node)

/** Adds a domain boundary to a node, or checks the boundary it already has. */
export const bind = (node: Node, domain: object, kind: string): Node => {
	const current = originOf(node)
	if (current !== undefined) {
		if (current.domain !== domain)
			throw new Error("A condition belongs to another domain")
		return node
	}
	const origin = { domain, kind }
	switch (node._tag) {
		case "True":
			return new True(origin)
		case "False":
			return new False(origin)
		case "Compare":
			return new Compare(node, origin)
		case "In":
			return new In(node, origin)
		case "Exists":
			return new Exists(node, origin)
		case "Under":
			return new Under(node, origin)
		case "And":
			return new And(node.conditions, origin)
		case "Or":
			return new Or(node.conditions, origin)
		case "Not":
			return new Not(node.condition, origin)
		case "Predicate":
			return new Predicate({ name: node.name, run: runOf(node) }, origin)
	}
}

/** Keeps a domain boundary when a walk makes a new root. */
export const inherit = (node: Node, source: Node): Node => {
	const origin = originOf(source)
	return origin === undefined ? node : bind(node, origin.domain, origin.kind)
}

/** Keeps the common domain when a smart constructor reduces its children. */
export const inheritAll = (node: Node, children: ReadonlyArray<Node>): Node => {
	const origin = combinedOrigin(children)
	return origin === undefined ? node : bind(node, origin.domain, origin.kind)
}

const operandJson = (operand: Operand): unknown => {
	if (operand._tag === "Principal") {
		return { _tag: "Principal", path: operand.path }
	}
	if (typeof operand.value === "number" && !Number.isFinite(operand.value)) {
		throw new Error("A JSON number must be finite")
	}
	return { _tag: "Literal", value: operand.value }
}

/** Gives the JSON form of a bounded condition with no predicate. */
export const toJson = (node: Node): unknown => {
	switch (node._tag) {
		case "True":
		case "False":
			return { _tag: node._tag }
		case "Compare":
			return {
				_tag: "Compare",
				op: node.op,
				field: node.field,
				value: operandJson(node.value),
			}
		case "In":
			return {
				_tag: "In",
				field: node.field,
				values: Arr.map(node.values, operandJson),
			}
		case "Exists":
			return { _tag: "Exists", field: node.field }
		case "Under":
			return { _tag: "Under", prefix: Arr.map(node.prefix, operandJson) }
		case "And":
		case "Or":
			return { _tag: node._tag, conditions: Arr.map(node.conditions, toJson) }
		case "Not":
			return { _tag: "Not", condition: toJson(node.condition) }
		case "Predicate":
			throw new Error(`The predicate "${node.name}" has no JSON form`)
	}
}

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
