/**
 * The work on condition nodes: smart constructors, simplification, the step
 * that puts the principal in, tests on a value, and folds.
 *
 * The constructors of the nodes keep each condition small and low, so each
 * walk here is a plain walk with no memo. A shared child is walked again for
 * each place, and the limits of the nodes keep that work small.
 */
// A predicate gives an Effect with an error type and a service type that this
// code does not know, so they are `unknown` here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Arr from "effect/Array"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import type * as Resource from "../Resource.ts"
import * as Nodes from "./nodes.ts"
import { readPath } from "./read.ts"

type Node = Nodes.Node

const { always, never } = Nodes

// Smart constructors

/**
 * Keeps the first node of each structure, in order. A node with a predicate is
 * equal only to itself, as its test is a function.
 */
const dedupe = (nodes: ReadonlyArray<Node>): ReadonlyArray<Node> =>
	Arr.flatten(
		Arr.mapAccum(nodes, HashSet.empty<Node>(), (seen, node) => [
			HashSet.add(seen, node),
			HashSet.has(seen, node) ? [] : [node],
		])[1],
	)

/**
 * Removes the children that the other children make useless. In an `Or`,
 * `a OR (a AND b)` is `a`. In an `And`, `a AND (a OR b)` is `a`.
 */
const absorb = (
	inner: "And" | "Or",
	nodes: ReadonlyArray<Node>,
): ReadonlyArray<Node> => {
	const all = HashSet.fromIterable(nodes)
	return Arr.filter(
		nodes,
		(node) =>
			node._tag !== inner ||
			!Arr.some(node.conditions, (part) => HashSet.has(all, part)),
	)
}

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
 * - it puts the children of a child of the same kind into the node;
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
		child._tag === tag && !child.opaque ? child.conditions : [child],
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

/** Makes a condition simple, from its leaves up. */
export const simplify = (node: Node): Node => {
	switch (node._tag) {
		case "And":
		case "Or":
			return junction(node._tag, Arr.map(node.conditions, simplify))
		case "Not":
			return node.condition.pipe(simplify, not)
		case "In":
			return node.values.length === 0 ? never : node
		default:
			return node
	}
}

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

/** Tests a condition with no predicate on a value. */
export const evaluateSync = (node: Node, input: Input): boolean => {
	switch (node._tag) {
		case "True":
			return true
		case "False":
			return false
		case "Compare":
			return testCompare(
				node.op,
				getField(input.value, node.field),
				resolve(node.value, input.principal),
			)
		case "In": {
			const field = getField(input.value, node.field)
			return node.values.some(
				(operand) => resolve(operand, input.principal) === field,
			)
		}
		case "Exists":
			return getField(input.value, node.field) !== null
		case "Under":
			return testUnder(node.prefix, input)
		case "And":
			return Arr.every(node.conditions, (child) => evaluateSync(child, input))
		case "Or":
			return Arr.some(node.conditions, (child) => evaluateSync(child, input))
		case "Not":
			return !evaluateSync(node.condition, input)
		case "Predicate":
			// The types stop this. A predicate needs `evaluate`.
			throw new Error(
				`The predicate "${node.name}" needs an Effect. Use Condition.evaluate.`,
			)
	}
}

/**
 * Tests a condition on a value. The children of `And` and `Or` run in order,
 * and they stop at the first child that gives the answer.
 */
export const evaluate = (
	node: Node,
	input: Input,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!node.opaque) {
		return Effect.sync(() => evaluateSync(node, input))
	}
	switch (node._tag) {
		case "Predicate":
			return node.run(input.value, input.principal)
		case "Not":
			return Effect.map(evaluate(node.condition, input), (value) => !value)
		case "And":
			return Effect.map(
				Effect.findFirst(node.conditions, (child) =>
					Effect.map(evaluate(child, input), (value) => !value),
				),
				Option.isNone,
			)
		case "Or":
			return Effect.map(
				Effect.findFirst(node.conditions, (child) => evaluate(child, input)),
				Option.isSome,
			)
		default:
			return Effect.sync(() => evaluateSync(node, input))
	}
}

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
export const partial = (node: Node, input: PartialInput): Node => {
	const bind = (current: Node): Node => {
		switch (current._tag) {
			case "Compare": {
				const value = bindOperand(current.value, input.principal)
				return value === undefined
					? never
					: value === current.value
						? current
						: new Nodes.Compare({ op: current.op, field: current.field, value })
			}
			case "In": {
				const values = Arr.flatMap(current.values, (operand) =>
					Option.toArray(
						Option.fromUndefinedOr(bindOperand(operand, input.principal)),
					),
				)
				return values.length === 0
					? never
					: new Nodes.In({ field: current.field, values })
			}
			case "Under":
				return expandUnder(current.prefix, input.principal, input.path)
			case "And":
				return and(Arr.map(current.conditions, bind))
			case "Or":
				return or(Arr.map(current.conditions, bind))
			case "Not":
				return current.condition.pipe(bind, not)
			case "Predicate": {
				const run = current.run
				return new Nodes.Predicate({
					name: current.name,
					run: (value) => run(value, input.principal),
				})
			}
			default:
				return current
		}
	}
	return bind(node)
}

/** Gives the services in `context` to every predicate of a condition. */
export const provide = (node: Node, context: Context.Context<never>): Node => {
	if (!node.opaque) {
		return node
	}
	switch (node._tag) {
		case "Predicate": {
			const run = node.run
			return new Nodes.Predicate({
				name: node.name,
				run: (value, principal) =>
					Effect.provideContext(run(value, principal), context),
			})
		}
		case "And":
			return new Nodes.And(
				Arr.map(node.conditions, (child) => provide(child, context)),
			)
		case "Or":
			return new Nodes.Or(
				Arr.map(node.conditions, (child) => provide(child, context)),
			)
		case "Not":
			return new Nodes.Not(provide(node.condition, context))
		default:
			return node
	}
}

/** The fields that a condition tests, in the order that they first come. */
export const fields = (node: Node): ReadonlyArray<string> => {
	const all = (current: Node): ReadonlyArray<string> => {
		switch (current._tag) {
			case "Compare":
			case "In":
			case "Exists":
				return [current.field]
			case "And":
			case "Or":
				return Arr.flatMap(current.conditions, all)
			case "Not":
				return all(current.condition)
			default:
				return []
		}
	}
	return Arr.flatten(
		Arr.mapAccum(all(node), HashSet.empty<string>(), (seen, field) => [
			HashSet.add(seen, field),
			HashSet.has(seen, field) ? [] : [field],
		])[1],
	)
}
