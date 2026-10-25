/**
 * The work on condition nodes: smart constructors, simplification, the step
 * that puts the principal in, tests on a value, and folds.
 *
 * The constructors of the nodes keep each condition small, so each walk here
 * has no memo. A shared child is walked again for each place, and the limits
 * of the nodes keep that work small. A walk takes the steps of a trampoline,
 * so a deep condition does not fill the stack: see `Trampoline`.
 */
// A predicate gives an Effect with an error type and a service type that this
// code does not know, so they are `unknown` here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Arr from "effect/Array"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type * as Resource from "../Resource.ts"
import * as Nodes from "./nodes.ts"
import { readPath } from "./read.ts"
import * as Trampoline from "./trampoline.ts"

type Node = Nodes.Node

const { always, never } = Nodes

// Keys of structure

/** The text of an operand. The type is in it, so `"1"` is not `1`. */
const operandText = (operand: Nodes.Operand): ReadonlyArray<string> =>
	operand._tag === "Literal"
		? [typeof operand.value, String(operand.value)]
		: ["principal", operand.path]

/** The parts of the text of a condition with no predicate. */
const shapeOf = (node: Node): unknown => {
	switch (node._tag) {
		case "True":
		case "False":
			return [node._tag]
		case "Compare":
			return [node._tag, node.op, node.field, operandText(node.value)]
		case "In":
			return [node._tag, node.field, Arr.map(node.values, operandText)]
		case "Exists":
			return [node._tag, node.field]
		case "Under":
			return [node._tag, Arr.map(node.prefix, operandText)]
		case "And":
		case "Or":
			return [node._tag, Arr.map(node.conditions, shapeOf)]
		case "Not":
			return [node._tag, shapeOf(node.condition)]
		case "Predicate":
			// A smart constructor and a search do not ask for the text of a
			// predicate: it is equal only to itself.
			throw new Error("A predicate has no text of structure")
	}
}

/**
 * The text of the structure of a condition with no predicate. Two conditions
 * with one text give the same answer for every value. It reads all of the
 * condition, so a search counts its size in the budget.
 */
const structureText = (node: Node): string => JSON.stringify(shapeOf(node))

/**
 * The work of the text of the structure of a condition: each node, and each
 * value of an `In` test or an `Under` test. A node counts as one in `size`,
 * also an `In` test with very many values. This walk reads the nodes only,
 * so it takes `size` steps.
 */
const weightOf = (node: Node): number => {
	switch (node._tag) {
		case "In":
			return 1 + node.values.length
		case "Under":
			return 1 + node.prefix.length
		case "And":
		case "Or":
			return Arr.reduce(
				node.conditions,
				1,
				(total, child) => total + weightOf(child),
			)
		case "Not":
			return 1 + weightOf(node.condition)
		default:
			return 1
	}
}

/**
 * The most nodes of a condition that a smart constructor reads for its key,
 * and the most children of a child that it puts into a node. A larger child
 * is its own key, and it stays one child, so the work of a constructor stays
 * small. A deep chain of `And` nodes, for one, does not copy all its leaves
 * at each level.
 */
const keyNodes = 64

/** The most work of a key, with the values of its tests: see {@link weightOf}. */
const keyWeight = 256

/**
 * The key of a child in a smart constructor: the text of its structure, or
 * the node itself when it is large. The keys go into a native `Set`, not a
 * `HashSet` of Effect. The hash of a string in Effect has no random seed, so
 * a policy could hold very many strings with one hash, and each test of the
 * set would read all of them. A native `Set` finds a node by the node itself,
 * and it hashes a string with the random seed of the engine.
 */
export const keyOf = (node: Node): string | Node =>
	node.size > keyNodes || weightOf(node) > keyWeight
		? node
		: structureText(node)

/**
 * Keeps the first node of each structure, in order. A large node is a copy
 * only of itself.
 */
const dedupe = (nodes: ReadonlyArray<Node>): ReadonlyArray<Node> => {
	// The set belongs to this call.
	const seen = new Set<string | Node>()
	return Arr.filter(nodes, (node) => {
		const key = keyOf(node)
		if (seen.has(key)) {
			return false
		}
		seen.add(key)
		return true
	})
}

/**
 * Removes the children that the other children make useless. In an `Or`,
 * `a OR (a AND b)` is `a`. In an `And`, `a AND (a OR b)` is `a`.
 */
const absorb = (
	inner: "And" | "Or",
	nodes: ReadonlyArray<Node>,
): ReadonlyArray<Node> => {
	// A native `Set`, as in `dedupe`.
	const all = new Set(Arr.map(nodes, keyOf))
	return Arr.filter(
		nodes,
		(node) =>
			node._tag !== inner ||
			!Arr.some(node.conditions, (part) => all.has(keyOf(part))),
	)
}

// Smart constructors

/**
 * Gives the result of an `And` with a `False` child, or of an `Or` with a
 * `True` child. The children are tested in order, so a predicate before the
 * constant still runs, and it may fail. When there is such a predicate, the
 * children before the constant stay, so the failure is not lost.
 */
const shortCircuit = (
	tag: "And" | "Or",
	children: ReadonlyArray<Node>,
	index: number,
): Node => {
	const constant = tag === "And" ? never : always
	const neutral = tag === "And" ? "True" : "False"
	const before = Arr.filter(
		Arr.take(children, index),
		(child) => child._tag !== neutral,
	)
	if (!Arr.some(before, (child) => child.opaque)) {
		return constant
	}
	return tag === "And"
		? new Nodes.And([...before, constant])
		: new Nodes.Or([...before, constant])
}

/**
 * Makes an `And` or an `Or` of simple children, and makes it simple. It looks
 * one level down only:
 * - it puts the children of a child of the same kind into the node, when
 *   the child has at most `keyNodes` of them;
 * - it stops at a `False` in an `And`, or at a `True` in an `Or`;
 * - it removes `True` from an `And`, `False` from an `Or`, copies, and the
 *   children that other children make useless.
 *
 * A predicate may fail, and it may give another answer when it runs again. So
 * when a child has a predicate, the children stay as they are, and each one
 * runs in its place. A child with a predicate is not put into the node either.
 */
const junction = (tag: "And" | "Or", children: ReadonlyArray<Node>): Node => {
	const constant = tag === "And" ? "False" : "True"
	const neutral = tag === "And" ? "True" : "False"
	const flat = Arr.flatMap(children, (child) =>
		child._tag === tag && !child.opaque && child.conditions.length <= keyNodes
			? child.conditions
			: [child],
	)
	return Option.match(
		Arr.findFirstIndex(flat, (child) => child._tag === constant),
		{
			onSome: (stop) => shortCircuit(tag, flat, stop),
			onNone: () => {
				const kept = Arr.filter(flat, (child) => child._tag !== neutral)
				const unique = Arr.some(kept, (child) => child.opaque)
					? kept
					: absorb(tag === "And" ? "Or" : "And", dedupe(kept))
				return unique.length === 0
					? tag === "And"
						? always
						: never
					: unique.length === 1
						? unique[0]!
						: tag === "And"
							? new Nodes.And(unique)
							: new Nodes.Or(unique)
			},
		},
	)
}

/** An `And` of simple children, made simple. */
export const and = (children: ReadonlyArray<Node>): Node =>
	junction("And", children)

/** An `Or` of simple children, made simple. */
export const or = (children: ReadonlyArray<Node>): Node =>
	junction("Or", children)

/** A `Not` of a simple child, made simple. */
export const not = (child: Node): Node => {
	switch (child._tag) {
		case "True":
			return never
		case "False":
			return always
		case "Not":
			return child.condition
		case "Compare":
			// A principal field with no value makes `eq` and `ne` both false, so
			// only a fixed value lets `not eq` become `ne`.
			return child.value._tag === "Literal" &&
				(child.op === "eq" || child.op === "ne")
				? new Nodes.Compare({
						op: child.op === "eq" ? "ne" : "eq",
						field: child.field,
						value: child.value,
					})
				: new Nodes.Not(child)
		default:
			return new Nodes.Not(child)
	}
}

type Step<A> = Trampoline.Step<A>

/** The children of a node, each walked by `go` as a step of `R`. */
const eachChild = <A>(
	R: Trampoline.Runner,
	children: ReadonlyArray<Node>,
	go: (child: Node) => Step<A>,
): Step<ReadonlyArray<A>> =>
	R.forEach(children, (child) => R.suspend(() => go(child)))

/** Makes a condition simple, from its leaves up. */
export const simplify = (node: Node): Node =>
	Trampoline.run(node.depth, (R) => {
		const go = (current: Node): Step<Node> => {
			switch (current._tag) {
				case "And":
				case "Or": {
					const tag = current._tag
					return R.map(eachChild(R, current.conditions, go), (children) =>
						junction(tag, children),
					)
				}
				case "Not":
					return R.map(
						R.suspend(() => go(current.condition)),
						not,
					)
				case "In":
					return R.succeed(current.values.length === 0 ? never : current)
				default:
					return R.succeed(current)
			}
		}
		return go(node)
	})

// Tests on a value

/** The data that a condition needs for a test. */
export interface Input {
	readonly value: object
	readonly principal?: object | undefined
	readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
}

/**
 * Gets a field of a value by a path with dots. It reads only plain data: see
 * `readPart`. A missing field, or a field under a value that is not an object,
 * gives `null`.
 */
const getField = (value: unknown, path: string): unknown =>
	readPath(value, path.split("."))

/**
 * Gives the value of an operand. A principal field that is `null`, missing, or
 * not a scalar gives `undefined`. No field of a resource is `undefined`, so a
 * test with it is never true. This keeps the check closed: a principal with no
 * id never matches a resource with no owner.
 */
const resolve = (operand: Nodes.Operand, principal: unknown): unknown => {
	if (operand._tag === "Literal") {
		return operand.value
	}
	const value = getField(principal, operand.path)
	return value !== null && Nodes.isScalar(value) ? value : undefined
}

export const testCompare = (
	op: Nodes.CompareOperator,
	left: unknown,
	right: unknown,
): boolean => {
	if (right === undefined) {
		return false
	}
	switch (op) {
		case "eq":
			return left === right
		case "ne":
			return left !== right
		default: {
			const ordered =
				(typeof left === "number" && typeof right === "number") ||
				(typeof left === "string" && typeof right === "string")
			if (!ordered) {
				return false
			}
			const a = left as number | string
			const b = right as number | string
			switch (op) {
				case "lt":
					return a < b
				case "lte":
					return a <= b
				case "gt":
					return a > b
				case "gte":
					return a >= b
			}
		}
	}
}

/** Gives the values of the path of a resource, or `undefined` for no path. */
const pathValues = (
	value: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): ReadonlyArray<unknown> | undefined =>
	path?.map((segment) =>
		typeof segment === "string" ? segment : getField(value, segment.field),
	)

const testUnder = (
	prefix: ReadonlyArray<Nodes.Operand>,
	input: Input,
): boolean => {
	const values = pathValues(input.value, input.path)
	if (values === undefined || prefix.length > values.length) {
		return false
	}
	// An operand with no value never matches, also a hole in a path that gives
	// `undefined` too.
	return prefix.every((operand, index) => {
		const value = resolve(operand, input.principal)
		return value !== undefined && value === values[index]
	})
}

/**
 * The test of a simple condition with no predicate on a value, as a walk.
 * The children of `And` and `Or` run in order, and they stop at the first
 * child that gives the answer.
 */
const testWith = (input: Input) => (R: Trampoline.Runner) => {
	const go = (node: Node): Step<boolean> => {
		switch (node._tag) {
			case "True":
				return R.succeed(true)
			case "False":
				return R.succeed(false)
			case "Compare":
				return R.succeed(
					testCompare(
						node.op,
						getField(input.value, node.field),
						resolve(node.value, input.principal),
					),
				)
			case "In": {
				const field = getField(input.value, node.field)
				return R.succeed(
					node.values.some(
						(operand) => resolve(operand, input.principal) === field,
					),
				)
			}
			case "Exists":
				return R.succeed(getField(input.value, node.field) !== null)
			case "Under":
				return R.succeed(testUnder(node.prefix, input))
			case "And":
				return R.every(node.conditions, (child) => R.suspend(() => go(child)))
			case "Or":
				return R.some(node.conditions, (child) => R.suspend(() => go(child)))
			case "Not":
				return R.map(
					R.suspend(() => go(node.condition)),
					(value) => !value,
				)
			case "Predicate":
				// The types stop this. A predicate needs `evaluate`.
				throw new Error(
					`The predicate "${node.name}" needs an Effect. Use Condition.evaluate.`,
				)
		}
	}
	return go
}

/** Tests a simple condition with no predicate on a value. */
const testSync = (node: Node, input: Input): boolean =>
	Trampoline.run(node.depth, (R) => testWith(input)(R)(node))

/**
 * Tests a simple condition on a value. The children of `And` and `Or` run in
 * order, and they stop at the first child that gives the answer. Each call
 * for a child is a step of the Effect, so a deep condition does not fill the
 * stack. A part with no predicate runs as a walk in the same loop.
 */
const test = (
	node: Node,
	input: Input,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!node.opaque) {
		return node.depth <= Trampoline.directDepth
			? Effect.sync(() => testSync(node, input))
			: node.pipe(testWith(input)(Trampoline.loop), Trampoline.toEffect)
	}
	switch (node._tag) {
		case "Predicate":
			return Nodes.runOf(node)(input.value, input.principal)
		case "Not":
			return Effect.map(
				Effect.suspend(() => test(node.condition, input)),
				(value) => !value,
			)
		case "And":
			return Effect.map(
				Effect.findFirst(node.conditions, (child) =>
					Effect.map(
						Effect.suspend(() => test(child, input)),
						(value) => !value,
					),
				),
				Option.isNone,
			)
		case "Or":
			return Effect.map(
				Effect.findFirst(node.conditions, (child) =>
					Effect.suspend(() => test(child, input)),
				),
				Option.isSome,
			)
		default:
			return Effect.sync(() => testSync(node, input))
	}
}

/**
 * Tests a condition with no predicate on a value. The test runs on the
 * simple form of the condition with the principal in it, as a residual does.
 * So a test reads only the fields that the residual reads: a read of a field
 * that is not plain data is a defect, and a field that the answer does not
 * need, as in `x AND False`, is not read.
 */
export const evaluateSync = (node: Node, input: Input): boolean =>
	testSync(partial(node, input), input)

/** Tests a condition on a value, as {@link evaluateSync} does. */
export const evaluate = (
	node: Node,
	input: Input,
): Effect.Effect<boolean, unknown, unknown> =>
	Effect.suspend(() => test(partial(node, input), input))

// The principal and the path

/**
 * Puts the value of the principal into an operand. It gives `undefined` for a
 * principal field with no value. See {@link resolve}.
 */
const bindOperand = (
	operand: Nodes.Operand,
	principal: unknown,
): Nodes.Literal | undefined => {
	if (operand._tag === "Literal") {
		return operand
	}
	const value = resolve(operand, principal)
	return value === undefined ? undefined : Nodes.literal(value as Nodes.Scalar)
}

const expandUnder = (
	prefix: ReadonlyArray<Nodes.Operand>,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): Node => {
	if (path === undefined || prefix.length > path.length) {
		return never
	}
	return and(
		Arr.map(prefix, (operand, index): Node => {
			const value = resolve(operand, principal)
			const segment = path[index]!
			return value === undefined
				? never
				: typeof segment === "string"
					? segment === value
						? always
						: never
					: new Nodes.Compare({
							op: "eq",
							field: segment.field,
							value: Nodes.literal(value as Nodes.Scalar),
						})
		}),
	)
}

/** The principal and the path of the resource, for {@link partial}. */
export interface PartialInput {
	readonly principal?: object | undefined
	readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
}

/**
 * Puts the principal into a condition and expands `Under` with the path of the
 * resource. The result is simple. It has no principal fields and no `Under`
 * nodes. A predicate keeps the principal.
 */
export const partial = (node: Node, input: PartialInput): Node =>
	Trampoline.run(node.depth, (R) => {
		const bind = (current: Node): Step<Node> => {
			switch (current._tag) {
				case "Compare": {
					const value = bindOperand(current.value, input.principal)
					return R.succeed(
						value === undefined
							? never
							: value === current.value
								? current
								: new Nodes.Compare({
										op: current.op,
										field: current.field,
										value,
									}),
					)
				}
				case "In": {
					const values = Arr.flatMap(current.values, (operand) =>
						Option.toArray(
							Option.fromUndefinedOr(bindOperand(operand, input.principal)),
						),
					)
					return R.succeed(
						values.length === 0
							? never
							: new Nodes.In({ field: current.field, values }),
					)
				}
				case "Under":
					return R.succeed(
						expandUnder(current.prefix, input.principal, input.path),
					)
				case "And":
					return R.map(eachChild(R, current.conditions, bind), and)
				case "Or":
					return R.map(eachChild(R, current.conditions, bind), or)
				case "Not":
					return R.map(
						R.suspend(() => bind(current.condition)),
						not,
					)
				case "Predicate": {
					const run = Nodes.runOf(current)
					return R.succeed(
						new Nodes.Predicate({
							name: current.name,
							run: (value) => run(value, input.principal),
						}),
					)
				}
				default:
					return R.succeed(current)
			}
		}
		return bind(node)
	})

/** Gives the services in `context` to every predicate of a condition. */
export const provide = (node: Node, context: Context.Context<never>): Node =>
	Trampoline.run(node.depth, (R) => {
		const go = (current: Node): Step<Node> => {
			if (!current.opaque) {
				return R.succeed(current)
			}
			switch (current._tag) {
				case "Predicate": {
					const run = Nodes.runOf(current)
					return R.succeed(
						new Nodes.Predicate({
							name: current.name,
							run: (value, principal) =>
								Effect.provideContext(run(value, principal), context),
						}),
					)
				}
				case "And":
					return R.map(
						eachChild(R, current.conditions, go),
						(children) => new Nodes.And(children),
					)
				case "Or":
					return R.map(
						eachChild(R, current.conditions, go),
						(children) => new Nodes.Or(children),
					)
				case "Not":
					return R.map(
						R.suspend(() => go(current.condition)),
						(child) => new Nodes.Not(child),
					)
				default:
					return R.succeed(current)
			}
		}
		return go(node)
	})

/** The fields that a condition tests, in the order that they first come. */
export const fields = (node: Node): ReadonlyArray<string> => {
	// The fields go into one native `Set`, in order, as in `dedupe`: a field
	// of a condition that is not bound to a domain may be any string. A walk
	// that joined the lists of the children would copy the list of a deep
	// condition at each level. The set belongs to this walk.
	const seen = new Set<string>()
	Trampoline.run(node.depth, (R) => {
		const go = (current: Node): Step<undefined> => {
			switch (current._tag) {
				case "Compare":
				case "In":
				case "Exists":
					seen.add(current.field)
					return R.succeed(undefined)
				case "And":
				case "Or":
					return R.map(eachChild(R, current.conditions, go), () => undefined)
				case "Not":
					return R.suspend(() => go(current.condition))
				default:
					return R.succeed(undefined)
			}
		}
		return go(node)
	})
	return Array.from(seen)
}
