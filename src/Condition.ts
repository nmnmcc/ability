/**
 * A condition is a test on a resource value. A rule applies only when its
 * condition is true.
 *
 * A condition is plain data: a tree of nodes. So you can:
 * - test it on a value with {@link evaluate};
 * - put the principal into it and make it smaller with {@link partial}, which
 *   gives a "residual" condition: the part that still depends on the
 *   resource;
 * - change it into a database query with {@link fold};
 * - keep it as JSON with {@link schema}.
 *
 * Make conditions with a {@link Builder}. A rule gives you a builder for its
 * resource, so the field names and the value types are checked.
 *
 * {@link Builder.predicate} is the one way out of plain data. A predicate runs
 * any `Effect`. Its error type and its service type go into the type of the
 * check. A rule with a predicate can not become JSON, and the type system
 * stops you when you try.
 *
 * @stability stable
 * @since 0.3.0
 */
// A predicate keeps its error type and service type in the public types. The
// code below works on the nodes with no types, where they are `unknown`, so
// the language service check for `unknown` in an Effect is off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import type * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as MutableHashSet from "effect/MutableHashSet"
import { hasProperty, isObject } from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Resource from "./Resource.ts"

/**
 * A value that a condition can compare.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Scalar = string | number | boolean | null

/**
 * A fixed value in a condition.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Literal {
	readonly _tag: "Literal"
	readonly value: Scalar
}

/**
 * A field of the principal. {@link partial} puts the value of the field in its
 * place.
 *
 * A principal field that is `null` or missing has no value. A `Compare`, `In`
 * or `Under` test with it is always false, also with `ne`. So a principal with
 * no id never matches a resource with no owner. `not` still turns false into
 * true.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface PrincipalRef {
	readonly _tag: "Principal"
	readonly path: string
}

/**
 * A field of the principal with a known value type `A`, from a principal of
 * the type `P`. The type fields are only in the types. A reference with no
 * type does not have them, so it can not stand for a field of any type. A
 * test with the reference reads a principal of the type `P`, so it can not go
 * into a rule of a domain with another principal. With no `P`, it is `never`,
 * and a test with the reference fits no rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Ref<A, P = never> = PrincipalRef & {
	readonly "~Ref": () => A
	readonly "~Principal": (principal: P) => void
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Operand = Literal | PrincipalRef

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type CompareOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte"

/**
 * Always true.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface True {
	readonly _tag: "True"
}

/**
 * Always false.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface False {
	readonly _tag: "False"
}

/**
 * Compares a field with a value. A missing field has the value `null`. `lt`,
 * `lte`, `gt` and `gte` are false when the two sides are not both numbers or
 * both strings.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Compare {
	readonly _tag: "Compare"
	readonly op: CompareOperator
	readonly field: string
	readonly value: Operand
}

/**
 * True when a field is equal to one of the values.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface In {
	readonly _tag: "In"
	readonly field: string
	readonly values: ReadonlyArray<Operand>
}

/**
 * True when a field is not `null` and not missing.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Exists {
	readonly _tag: "Exists"
	readonly field: string
}

/**
 * True when the path of the resource starts with the prefix. A resource with
 * no path is never under a prefix.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Under {
	readonly _tag: "Under"
	readonly prefix: ReadonlyArray<Operand>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface And {
	readonly _tag: "And"
	readonly conditions: ReadonlyArray<Ast>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Or {
	readonly _tag: "Or"
	readonly conditions: ReadonlyArray<Ast>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Not {
	readonly _tag: "Not"
	readonly condition: Ast
}

/**
 * A test that runs an `Effect`. It can not become JSON or a query.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Predicate {
	readonly _tag: "Predicate"
	readonly name: string
	readonly run: (
		value: any,
		principal: any,
	) => Effect.Effect<boolean, unknown, unknown>
}

/**
 * The nodes of a condition, without types.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Ast =
	True | False | Compare | In | Exists | Under | And | Or | Not | Predicate

/**
 * The type marker for a condition with a {@link Predicate}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Opaque = "Opaque"

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Variance<E, R, O> {
	readonly E: () => E
	readonly R: () => R
	readonly O: () => O
}

/**
 * What the predicates of a condition read: a resource value of the type `V`
 * and a principal of the type `P`. It is only in the types.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Reads<V, P> {
	readonly value: V
	readonly principal: P
}

/**
 * The type fields of a condition. They are only in the types.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Marks<E, R, O, I> {
	readonly "~Condition": Variance<E, R, O>
	/** `I` is what the predicates read. See {@link Reads}. */
	readonly "~Reads": (reads: I) => void
}

/**
 * An `And` node with the types of its children.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface AndCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "And"
	readonly conditions: ReadonlyArray<Condition<E, R, O, I>>
}

/**
 * An `Or` node with the types of its children.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface OrCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "Or"
	readonly conditions: ReadonlyArray<Condition<E, R, O, I>>
}

/**
 * A `Not` node with the types of its child.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface NotCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "Not"
	readonly condition: Condition<E, R, O, I>
}

/**
 * A predicate node with its types. `"~Predicate"` is only in the types. It has
 * the type `O`, so a plain condition, with `O` as `never`, can not be a
 * predicate. The builder makes predicates with `O` as {@link Opaque}.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface PredicateCondition<E, R, O, I> extends Marks<E, R, O, I> {
	readonly _tag: "Predicate"
	readonly name: string
	readonly run: (value: any, principal: any) => Effect.Effect<boolean, E, R>
	readonly "~Predicate": O
}

/**
 * A condition. `E` and `R` are the error type and the service type of its
 * predicates. `O` is {@link Opaque} when the condition has a predicate, and
 * `never` when it is plain data. `I` is what its predicates read. See
 * {@link Reads}.
 *
 * The type fields are only in the types. A plain node made by hand does not
 * have them, so it is not a condition. Use the builder. Each child of a node
 * is a condition with the same types, so a node can not hide the types of a
 * predicate inside it. A predicate is a condition only when `O` is
 * {@link Opaque}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Condition<E = never, R = never, O = never, I = unknown> =
	| ((True | False | Compare | In | Exists | Under) & Marks<E, R, O, I>)
	| AndCondition<E, R, O, I>
	| OrCondition<E, R, O, I>
	| NotCondition<E, R, O, I>
	| PredicateCondition<E, R, O, I>

/**
 * Any condition.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Condition<any, any, any, any>

/**
 * The error type of a condition.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Error<C> = C extends {
	readonly "~Condition"?: Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a condition.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Services<C> = C extends {
	readonly "~Condition"?: Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * What the predicates of a condition read. For a union of conditions, it is
 * what all of them read.
 *
 * @stability stable
 * @category utility types
 * @since 0.4.0
 */
export type ReadsOf<C> = [C] extends [
	{ readonly "~Reads": (reads: infer I) => void },
]
	? I
	: unknown

/**
 * {@link Opaque} when a condition has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<C> = C extends {
	readonly "~Condition"?: Variance<infer _E, infer _R, infer O>
}
	? O
	: never

type Leaf = string | number | boolean | bigint | symbol | null | undefined
type PreviousDepth = [never, 0, 1, 2, 3]
type FieldPathInternal<T, Depth extends number> = [Depth] extends [never]
	? never
	: {
			[K in keyof T & string]-?: NonNullable<T[K]> extends Leaf
				? K
				: NonNullable<T[K]> extends ReadonlyArray<unknown> | Function
					? never
					: NonNullable<T[K]> extends object
						? `${K}.${FieldPathInternal<NonNullable<T[K]>, PreviousDepth[Depth]>}`
						: never
		}[keyof T & string]

/**
 * The paths of the fields of `T` that hold one value, with dots for nested
 * fields. Arrays are left out. The type goes down four levels, so type
 * checking stays fast. For a union of types, only the common fields are
 * paths.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type FieldPath<T> = [T] extends [object]
	? FieldPathInternal<T, 4>
	: never

type Normalize<A> = Exclude<A, undefined> | (undefined extends A ? null : never)

/**
 * The type of the field of `T` at `Path`. A field that may be missing may also
 * be `null`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type PathValue<
	T,
	Path extends string,
> = Path extends `${infer Head}.${infer Rest}`
	? Head extends keyof T
		? undefined extends T[Head]
			? PathValue<NonNullable<T[Head]>, Rest> | null
			: null extends T[Head]
				? PathValue<NonNullable<T[Head]>, Rest> | null
				: PathValue<T[Head], Rest>
		: never
	: Path extends keyof T
		? Normalize<T[Path]>
		: never

/**
 * A value for a field of type `A`: a fixed value, or a field of the principal
 * with the same type.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type OperandOf<A, P = never> = Extract<A, Scalar> | Ref<A, P>

type ScalarPath<T> = {
	[F in FieldPath<T>]: PathValue<T, F> extends Scalar ? F : never
}[FieldPath<T>]

type OrderedPath<T> = {
	[F in FieldPath<T>]: Exclude<PathValue<T, F>, null> extends number | string
		? F
		: never
}[FieldPath<T>]

/**
 * A test made by a {@link Builder}. It runs no code, but it keeps the value
 * type of its resource, so a test on the fields of one resource can not go
 * into a rule for another resource. A test with a field of the principal
 * keeps the principal type `P` too.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export type Test<Value, P = unknown> = Condition<
	never,
	never,
	never,
	Reads<Value, P>
>

/**
 * The principal type that a test reads: the principal of each field of the
 * principal in the values `V`, and `unknown` when there is none. A reference
 * from another builder keeps the principal of that builder.
 */
type PrincipalOf<V, _P> = [Extract<V, PrincipalRef>] extends [never]
	? unknown
	: [Extract<V, PrincipalRef>] extends [
				{ readonly "~Principal": (principal: infer Q) => void },
		  ]
		? Q
		: unknown

/**
 * Makes conditions for a resource with the data type `Data` and the value type
 * `Value`, and a principal with the type `P`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Builder<Data, Value, P> {
	/** The field is equal to the value. */
	readonly eq: <
		const F extends FieldPath<Data>,
		const V extends OperandOf<PathValue<Data, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	/** The field is not equal to the value. */
	readonly ne: <
		const F extends FieldPath<Data>,
		const V extends OperandOf<PathValue<Data, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly lt: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<PathValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly lte: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<PathValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly gt: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<PathValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly gte: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<PathValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	/** The field is equal to one of the values. */
	readonly in: <
		const F extends FieldPath<Data>,
		const Vs extends ReadonlyArray<OperandOf<PathValue<Data, F>, any>>,
	>(
		field: F,
		values: Vs,
	) => Test<Value, PrincipalOf<Vs[number], P>>
	/** The field has a value that is not `null`. */
	readonly exists: <const F extends FieldPath<Data>>(field: F) => Test<Value>
	/** The path of the resource starts with these parts. */
	readonly under: <
		const Ps extends ReadonlyArray<string | null | Ref<string | null, any>>,
	>(
		...prefix: Ps
	) => Test<Value, PrincipalOf<Ps[number], P>>
	/**
	 * A field of the principal, to use as a value. The field must have a
	 * {@link Scalar} type.
	 */
	readonly principal: <const F extends ScalarPath<P>>(
		field: F,
	) => Ref<PathValue<P, F>, P>
	readonly and: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<
		Error<Cs[number]>,
		Services<Cs[number]>,
		OpaqueOf<Cs[number]>,
		ReadsOf<Cs[number]>
	>
	readonly or: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<
		Error<Cs[number]>,
		Services<Cs[number]>,
		OpaqueOf<Cs[number]>,
		ReadsOf<Cs[number]>
	>
	readonly not: <C extends Any>(
		condition: C,
	) => Condition<Error<C>, Services<C>, OpaqueOf<C>, ReadsOf<C>>
	/**
	 * A test that runs any code. It may give a boolean or an `Effect`. A
	 * condition with a predicate can not become JSON or a query.
	 */
	readonly predicate: <E = never, R = never>(
		name: string,
		test: (
			value: Value,
			principal: P,
		) => boolean | Effect.Effect<boolean, E, R>,
	) => Condition<E, R, Opaque, Reads<Value, P>>
}

const nodes = Data.taggedEnum<Ast>()
const operands = Data.taggedEnum<Operand>()

const literal = (value: Scalar): Literal => operands.Literal({ value })

const isOperand = (u: unknown): u is Operand =>
	hasProperty(u, "_tag") && (u._tag === "Literal" || u._tag === "Principal")

const toOperand = (value: unknown): Operand =>
	isOperand(value) ? value : literal(value as Scalar)

const compare =
	(op: CompareOperator) =>
	(field: string, value: unknown): Compare =>
		nodes.Compare({ op, field, value: toOperand(value) })

const makeAnd = (...conditions: ReadonlyArray<Ast>): Ast =>
	nodes.And({ conditions })

const makeOr = (...conditions: ReadonlyArray<Ast>): Ast =>
	nodes.Or({ conditions })

const makeNot = (condition: Ast): Ast => nodes.Not({ condition })

const makePredicate = (
	name: string,
	run: (value: unknown, principal: unknown) => Effect.Effect<boolean, any, any>,
): Ast => nodes.Predicate({ name, run })

const sharedBuilder: Builder<any, any, any> = {
	eq: compare("eq"),
	ne: compare("ne"),
	lt: compare("lt"),
	lte: compare("lte"),
	gt: compare("gt"),
	gte: compare("gte"),
	in: (field: string, values: ReadonlyArray<unknown>) =>
		nodes.In({ field, values: values.map(toOperand) }),
	exists: (field: string) => nodes.Exists({ field }),
	under: (...prefix: ReadonlyArray<unknown>) =>
		nodes.Under({ prefix: prefix.map(toOperand) }),
	principal: (path: string) => operands.Principal({ path }),
	and: makeAnd,
	or: makeOr,
	not: makeNot,
	predicate: (
		name: string,
		test: (
			value: unknown,
			principal: unknown,
		) => boolean | Effect.Effect<boolean, unknown, unknown>,
	) =>
		makePredicate(name, (value, principal) =>
			Effect.suspend(() => {
				const result = test(value, principal)
				return Effect.isEffect(result) ? result : Effect.succeed(result)
			}),
		),
} as never

/**
 * Makes a builder. Rules give you a builder with the right types, so you do not
 * often need this.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const builder = <Data, Value, P>(): Builder<Data, Value, P> =>
	sharedBuilder

/**
 * Always true.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const always: Condition = nodes.True() as Condition

/**
 * Always false.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const never: Condition = nodes.False() as Condition

/**
 * True when all the conditions are true. With no conditions, it is true.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const and: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<
	Error<Cs[number]>,
	Services<Cs[number]>,
	OpaqueOf<Cs[number]>,
	ReadsOf<Cs[number]>
> = makeAnd as never

/**
 * True when one of the conditions is true. With no conditions, it is false.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const or: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<
	Error<Cs[number]>,
	Services<Cs[number]>,
	OpaqueOf<Cs[number]>,
	ReadsOf<Cs[number]>
> = makeOr as never

/**
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const not: <C extends Any>(
	condition: C,
) => Condition<Error<C>, Services<C>, OpaqueOf<C>, ReadsOf<C>> =
	makeNot as never

/**
 * The data that a condition needs for a test.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Input {
	/** The resource value. */
	readonly value: object
	/**
	 * The principal. Without it, a principal field has no value. See
	 * {@link PrincipalRef}.
	 */
	readonly principal?: object | undefined
	/** The path of the resource. Without it, `Under` is false. */
	readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
}

/**
 * Gets a field of an object by a path with dots. A missing field, or a field
 * under a value that is not an object, gives `null`.
 */
const getField = (value: unknown, path: string): unknown => {
	let cursor: unknown = value
	for (const key of path.split(".")) {
		if (!isObject(cursor) || !Object.hasOwn(cursor, key)) {
			return null
		}
		cursor = (cursor as Record<string, unknown>)[key]
	}
	return cursor === undefined ? null : cursor
}

const isScalar = (value: unknown): value is Scalar =>
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value))

/**
 * Gives the value of an operand. A principal field that is `null`, missing, or
 * not a {@link Scalar} gives `undefined`. No field of a resource is
 * `undefined`, so a test with it is never true. This keeps the check closed: a
 * principal with no id never matches a resource with no owner. It also keeps
 * other values, such as a `bigint`, out of the residual condition.
 */
const resolve = (operand: Operand, principal: unknown): unknown => {
	if (operand._tag === "Literal") {
		return operand.value
	}
	const value = getField(principal, operand.path)
	return isScalar(value) ? value : undefined
}

const testCompare = (
	op: CompareOperator,
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

/**
 * Gives the values of a resource path. It gives `undefined` when the resource
 * has no path.
 */
const pathValues = (
	value: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): ReadonlyArray<unknown> | undefined =>
	path?.map((segment) =>
		typeof segment === "string" ? segment : getField(value, segment.field),
	)

const testUnder = (prefix: ReadonlyArray<Operand>, input: Input): boolean => {
	const values = pathValues(input.value, input.path)
	if (values === undefined || prefix.length > values.length) {
		return false
	}
	return prefix.every(
		(operand, index) => resolve(operand, input.principal) === values[index],
	)
}

/**
 * True when a condition has a {@link Predicate}.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const hasPredicate = (condition: Ast): boolean => {
	const cached = predicateNodes.get(condition)
	if (cached !== undefined) {
		return cached
	}
	const result = hasPredicateOnce(condition)
	predicateNodes.set(condition, result)
	return result
}

// One node may be a child of many nodes. Each walk below keeps its work on a
// node, so a condition with shared children takes time for its nodes, not
// for its paths.

const predicateNodes = new WeakMap<Ast, boolean>()

const hasPredicateOnce: (condition: Ast) => boolean = nodes.$match({
	Predicate: () => true,
	And: (node) => node.conditions.some(hasPredicate),
	Or: (node) => node.conditions.some(hasPredicate),
	Not: (node) => hasPredicate(node.condition),
	True: () => false,
	False: () => false,
	Compare: () => false,
	In: () => false,
	Exists: () => false,
	Under: () => false,
})

const provideAst = (
	ast: Ast,
	context: Context.Context<never>,
	done: Map<Ast, Ast> = new Map(),
): Ast => {
	if (!hasPredicate(ast)) {
		return ast
	}
	const cached = done.get(ast)
	if (cached !== undefined) {
		return cached
	}
	let result: Ast
	switch (ast._tag) {
		case "Predicate":
			result = makePredicate(ast.name, (value, principal) =>
				Effect.provideContext(ast.run(value, principal), context),
			)
			break
		case "And":
			result = makeAnd(
				...ast.conditions.map((child) => provideAst(child, context, done)),
			)
			break
		case "Or":
			result = makeOr(
				...ast.conditions.map((child) => provideAst(child, context, done)),
			)
			break
		case "Not":
			result = makeNot(provideAst(ast.condition, context, done))
			break
		default:
			result = ast
	}
	done.set(ast, result)
	return result
}

/**
 * Gives the services in `context` to every predicate of a condition, so the
 * condition needs no services when it runs.
 *
 * @stability stable
 * @category services
 * @since 0.4.0
 */
export const provideContext: {
	<R>(
		context: Context.Context<R>,
	): <E, O, I>(condition: Condition<E, R, O, I>) => Condition<E, never, O, I>
	<E, R, O, I>(
		condition: Condition<E, R, O, I>,
		context: Context.Context<R>,
	): Condition<E, never, O, I>
} = dual(2, provideAst) as never

const evaluateSyncAst = (ast: Ast, input: Input): boolean =>
	evaluateSyncNode(ast, input, new Map())

const evaluateSyncNode = (
	ast: Ast,
	input: Input,
	done: Map<Ast, boolean>,
): boolean => {
	const cached = done.get(ast)
	if (cached !== undefined) {
		return cached
	}
	const result = evaluateSyncOnce(ast, input, done)
	done.set(ast, result)
	return result
}

const evaluateSyncOnce = (
	ast: Ast,
	input: Input,
	done: Map<Ast, boolean>,
): boolean => {
	switch (ast._tag) {
		case "True":
			return true
		case "False":
			return false
		case "Compare":
			return testCompare(
				ast.op,
				getField(input.value, ast.field),
				resolve(ast.value, input.principal),
			)
		case "In": {
			const field = getField(input.value, ast.field)
			return ast.values.some(
				(operand) => resolve(operand, input.principal) === field,
			)
		}
		case "Exists":
			return getField(input.value, ast.field) !== null
		case "Under":
			return testUnder(ast.prefix, input)
		case "And":
			return ast.conditions.every((child) =>
				evaluateSyncNode(child, input, done),
			)
		case "Or":
			return ast.conditions.some((child) =>
				evaluateSyncNode(child, input, done),
			)
		case "Not":
			return !evaluateSyncNode(ast.condition, input, done)
		case "Predicate":
			// The types stop this. A predicate needs `evaluate`.
			throw new globalThis.Error(
				`The predicate "${ast.name}" needs an Effect. Use Condition.evaluate.`,
			)
	}
}

const evaluateAst = (
	ast: Ast,
	input: Input,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!hasPredicate(ast)) {
		return Effect.sync(() => evaluateSyncAst(ast, input))
	}
	switch (ast._tag) {
		case "Predicate":
			return ast.run(input.value, input.principal)
		case "Not":
			return Effect.map(evaluateAst(ast.condition, input), (value) => !value)
		case "And":
			return Effect.gen(function* () {
				for (const child of ast.conditions) {
					if (!(yield* evaluateAst(child, input))) {
						return false
					}
				}
				return true
			})
		case "Or":
			return Effect.gen(function* () {
				for (const child of ast.conditions) {
					if (yield* evaluateAst(child, input)) {
						return true
					}
				}
				return false
			})
		default:
			return Effect.sync(() => evaluateSyncAst(ast, input))
	}
}

/**
 * The input of {@link evaluate} that the predicates of a condition need: a
 * value and a principal of the types in `I`. See {@link Reads}.
 */
type ReadsInput<I> =
	I extends Reads<infer V, infer P>
		? { readonly value: V } & (unknown extends P
				? unknown
				: { readonly principal: P })
		: unknown

/**
 * `unknown` when `In` gives what `I` reads, and `never` when it does not. For
 * a union, each member must give it, so the test is not split over the union.
 */
type ReadsFrom<I, In> = [In] extends [ReadsInput<I>] ? unknown : never

/**
 * Tests a condition on a value. A predicate may fail with its error. When the
 * condition has a predicate, the input must have the value and the principal
 * that the predicate reads.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluate: {
	<In extends Input>(
		input: In,
	): <E, R, O, I>(
		condition: Condition<E, R, O, I> & ReadsFrom<I, In>,
	) => Effect.Effect<boolean, E, R>
	<E, R, O, I, In extends Input>(
		condition: Condition<E, R, O, I>,
		input: In & ReadsInput<I>,
	): Effect.Effect<boolean, E, R>
} = dual(2, evaluateAst) as never

/**
 * Tests a condition with no predicate on a value, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluateSync: {
	// A condition with no predicate reads nothing, so `I` does not matter.
	(input: Input): (condition: Condition<never, never, never, any>) => boolean
	(condition: Condition<never, never, never, any>, input: Input): boolean
} = dual(2, evaluateSyncAst)

// The nodes are Effect data, so a hash set finds an equal node at once. A
// test of each pair of nodes would take a very long time for a long list.

const dedupe = (conditions: ReadonlyArray<Ast>): ReadonlyArray<Ast> => {
	const seen = MutableHashSet.empty<Ast>()
	const output: Array<Ast> = []
	for (const condition of conditions) {
		if (!MutableHashSet.has(seen, condition)) {
			MutableHashSet.add(seen, condition)
			output.push(condition)
		}
	}
	return output
}

/**
 * Removes the children that the other children make useless. In an `Or`,
 * `a OR (a AND b)` is `a`. In an `And`, `a AND (a OR b)` is `a`. The
 * children are already without copies.
 */
const absorb = (
	inner: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
): ReadonlyArray<Ast> => {
	const all = MutableHashSet.make(...conditions)
	return conditions.filter(
		(condition) =>
			condition._tag !== inner ||
			!condition.conditions.some((part) => MutableHashSet.has(all, part)),
	)
}

/**
 * Removes children that do not change the result. A predicate may fail, and it
 * may give another answer when it runs again. So when a child has a predicate,
 * every child stays, and each one runs in its place.
 */
const reduce = (
	inner: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
): ReadonlyArray<Ast> =>
	conditions.some(hasPredicate) ? conditions : absorb(inner, dedupe(conditions))

const flatten = (
	tag: "And" | "Or",
	conditions: ReadonlyArray<Ast>,
): ReadonlyArray<Ast> =>
	conditions.flatMap((child) => {
		const simple = simplifyAst(child)
		return simple._tag === tag ? simple.conditions : [simple]
	})

/**
 * Gives the result of an `And` with a `False` child, or of an `Or` with a
 * `True` child. The children are tested in order, so a predicate before the
 * constant still runs, and it may fail. When there is such a predicate, the
 * children before the constant stay, so the failure is not lost. The other
 * children stay too, because they decide if the predicate runs.
 */
const shortCircuit = (
	tag: "And" | "Or",
	children: ReadonlyArray<Ast>,
	index: number,
): Ast => {
	const constant = tag === "And" ? never : always
	const neutral = tag === "And" ? "True" : "False"
	const before = children
		.slice(0, index)
		.filter((child) => child._tag !== neutral)
	if (!before.some(hasPredicate)) {
		return constant
	}
	return tag === "And"
		? makeAnd(...before, constant)
		: makeOr(...before, constant)
}

/**
 * The nodes that are already simple. A residual condition is made of simple
 * parts, so the work on each part is done only one time.
 */
const simple = new WeakMap<Ast, Ast>()

const simplifyAst = (ast: Ast): Ast => {
	const cached = simple.get(ast)
	if (cached !== undefined) {
		return cached
	}
	const result = simplifyNode(ast)
	simple.set(ast, result)
	simple.set(result, result)
	return result
}

const simplifyNode = (ast: Ast): Ast => {
	switch (ast._tag) {
		case "And": {
			const flat = flatten("And", ast.conditions)
			const stop = flat.findIndex((child) => child._tag === "False")
			if (stop !== -1) {
				return shortCircuit("And", flat, stop)
			}
			const children = flat.filter((child) => child._tag !== "True")
			const unique = reduce("Or", children)
			if (unique.length === 0) {
				return always
			}
			return unique.length === 1 ? unique[0]! : makeAnd(...unique)
		}
		case "Or": {
			const flat = flatten("Or", ast.conditions)
			const stop = flat.findIndex((child) => child._tag === "True")
			if (stop !== -1) {
				return shortCircuit("Or", flat, stop)
			}
			const children = flat.filter((child) => child._tag !== "False")
			const unique = reduce("And", children)
			if (unique.length === 0) {
				return never
			}
			return unique.length === 1 ? unique[0]! : makeOr(...unique)
		}
		case "Not": {
			const child = simplifyAst(ast.condition)
			switch (child._tag) {
				case "True":
					return never
				case "False":
					return always
				case "Not":
					return child.condition
				case "Compare":
					// A principal field with no value makes `eq` and `ne` both false,
					// so only a fixed value lets `not eq` become `ne`.
					if (
						child.value._tag === "Literal" &&
						(child.op === "eq" || child.op === "ne")
					) {
						return nodes.Compare({
							op: child.op === "eq" ? "ne" : "eq",
							field: child.field,
							value: child.value,
						})
					}
					return makeNot(child)
				default:
					return makeNot(child)
			}
		}
		case "In":
			return ast.values.length === 0 ? never : ast
		default:
			return ast
	}
}

/**
 * Makes a condition smaller without a change to its meaning. It removes `True`
 * and `False` from `And` and `Or`, joins nested `And` and `Or` nodes, and
 * removes double `Not` nodes.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const simplify: <E, R, O, I>(
	condition: Condition<E, R, O, I>,
) => Condition<E, R, O, I> = simplifyAst as never

/**
 * Puts the value of the principal into an operand. It gives `undefined` for a
 * principal field with no value. See {@link resolve}.
 */
const bindOperand = (
	operand: Operand,
	principal: unknown,
): Literal | undefined => {
	if (operand._tag === "Literal") {
		return operand
	}
	const value = resolve(operand, principal)
	return value === undefined ? undefined : literal(value as Scalar)
}

const expandUnder = (
	prefix: ReadonlyArray<Operand>,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
): Ast => {
	if (path === undefined || prefix.length > path.length) {
		return never
	}
	const parts: Array<Ast> = []
	prefix.forEach((operand, index) => {
		const value = resolve(operand, principal)
		const segment = path[index]!
		if (value === undefined) {
			parts.push(never)
		} else if (typeof segment === "string") {
			parts.push(segment === value ? always : never)
		} else {
			parts.push(
				nodes.Compare({
					op: "eq",
					field: segment.field,
					value: literal(value as Scalar),
				}),
			)
		}
	})
	return makeAnd(...parts)
}

const bind = (
	ast: Ast,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
	done: Map<Ast, Ast> = new Map(),
): Ast => {
	const cached = done.get(ast)
	if (cached !== undefined) {
		return cached
	}
	const result = bindOnce(ast, principal, path, done)
	done.set(ast, result)
	return result
}

const bindOnce = (
	ast: Ast,
	principal: unknown,
	path: ReadonlyArray<Resource.PathSegment> | undefined,
	done: Map<Ast, Ast>,
): Ast => {
	switch (ast._tag) {
		case "Compare": {
			const value = bindOperand(ast.value, principal)
			return value === undefined
				? never
				: nodes.Compare({ op: ast.op, field: ast.field, value })
		}
		case "In":
			return nodes.In({
				field: ast.field,
				values: ast.values.flatMap((operand) => {
					const value = bindOperand(operand, principal)
					return value === undefined ? [] : [value]
				}),
			})
		case "Under":
			return expandUnder(ast.prefix, principal, path)
		case "And":
			return makeAnd(
				...ast.conditions.map((child) => bind(child, principal, path, done)),
			)
		case "Or":
			return makeOr(
				...ast.conditions.map((child) => bind(child, principal, path, done)),
			)
		case "Not":
			return makeNot(bind(ast.condition, principal, path, done))
		case "Predicate":
			return makePredicate(ast.name, (value) => ast.run(value, principal))
		default:
			return ast
	}
}

interface PartialInput {
	readonly principal?: object | undefined
	readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
}

/**
 * The principal that {@link partial} must get for the predicates of a
 * condition. A predicate keeps the principal that it gets, so the principal
 * must have the type that the predicate reads.
 */
type PrincipalInput<I> =
	I extends Reads<infer _V, infer P>
		? unknown extends P
			? unknown
			: { readonly principal: P }
		: unknown

/** `unknown` when `In` gives what `I` reads, and `never` when it does not. */
type PrincipalFrom<I, In> = [In] extends [PrincipalInput<I>] ? unknown : never

/** What a condition reads after {@link partial}: the value, and no principal. */
type Bound<I> = I extends Reads<infer V, infer _P> ? Reads<V, unknown> : I

/**
 * Puts the principal into a condition and expands `Under` with the path of the
 * resource. The result is simplified. It has no principal fields and no
 * `Under` nodes. It is `True` or `False` when the answer does not depend on the
 * resource value.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const partial: {
	<In extends PartialInput>(
		input: In,
	): <E, R, O, I>(
		condition: Condition<E, R, O, I> & PrincipalFrom<I, In>,
	) => Condition<E, R, O, Bound<I>>
	<E, R, O, I>(
		condition: Condition<E, R, O, I>,
		input: PartialInput & PrincipalInput<I>,
	): Condition<E, R, O, Bound<I>>
} = dual(
	2,
	(
		ast: Ast,
		input: {
			readonly principal?: object | undefined
			readonly path?: ReadonlyArray<Resource.PathSegment> | undefined
		},
	): Ast => simplifyAst(bind(ast, input.principal, input.path)),
)

/**
 * The functions that change each node of a condition into another form, such
 * as a database query.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Interpreter<A> {
	readonly true: () => A
	readonly false: () => A
	readonly compare: (op: CompareOperator, field: string, value: Scalar) => A
	readonly in: (field: string, values: ReadonlyArray<Scalar>) => A
	readonly exists: (field: string) => A
	readonly and: (conditions: ReadonlyArray<A>) => A
	readonly or: (conditions: ReadonlyArray<A>) => A
	readonly not: (condition: A) => A
	/** Optional. Without it, a predicate makes `fold` fail. */
	readonly predicate?: (name: string) => A
}

/**
 * The error when `fold` can not change a node.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export class Untranslatable extends Schema.TaggedError<Untranslatable>(
	"@nmnmcc/ability/Condition/Untranslatable",
)("Untranslatable", { reason: Schema.String }) {}

const literalValue = (operand: Operand, field: string): Scalar => {
	if (operand._tag !== "Literal") {
		throw Untranslatable.make({
			reason: `The field "${field}" uses a principal field. Call Condition.partial first.`,
		})
	}
	return operand.value
}

const foldAst = <A>(ast: Ast, interpreter: Interpreter<A>): A => {
	switch (ast._tag) {
		case "True":
			return interpreter.true()
		case "False":
			return interpreter.false()
		case "Compare":
			return interpreter.compare(
				ast.op,
				ast.field,
				literalValue(ast.value, ast.field),
			)
		case "In":
			return interpreter.in(
				ast.field,
				ast.values.map((operand) => literalValue(operand, ast.field)),
			)
		case "Exists":
			return interpreter.exists(ast.field)
		case "Under":
			throw Untranslatable.make({
				reason:
					"An Under node needs the resource path. Call Condition.partial first.",
			})
		case "And":
			return interpreter.and(
				ast.conditions.map((child) => foldAst(child, interpreter)),
			)
		case "Or":
			return interpreter.or(
				ast.conditions.map((child) => foldAst(child, interpreter)),
			)
		case "Not":
			return interpreter.not(foldAst(ast.condition, interpreter))
		case "Predicate":
			if (interpreter.predicate === undefined) {
				throw Untranslatable.make({
					reason: `The predicate "${ast.name}" can not become a query`,
				})
			}
			return interpreter.predicate(ast.name)
	}
}

/**
 * Changes a condition into another form with an interpreter. Call
 * {@link partial} first: `fold` fails on principal fields and on `Under`
 * nodes, and on predicates when the interpreter has no `predicate` function.
 *
 * @stability stable
 * @category converting
 * @since 0.3.0
 */
export const fold: {
	<A>(
		interpreter: Interpreter<A>,
	): (condition: Any) => Effect.Effect<A, Untranslatable>
	<A>(
		condition: Any,
		interpreter: Interpreter<A>,
	): Effect.Effect<A, Untranslatable>
} = dual(
	2,
	<A>(
		ast: Ast,
		interpreter: Interpreter<A>,
	): Effect.Effect<A, Untranslatable> =>
		Effect.try({
			try: () => foldAst(ast, interpreter),
			catch: (cause) => {
				if (cause instanceof Untranslatable) {
					return cause
				}
				throw cause
			},
		}),
)

/**
 * The fields that a condition uses.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const fields = (condition: Ast): ReadonlyArray<string> => {
	const output = new Set<string>()
	const seen = new Set<Ast>()
	const visit = (node: Ast): void => {
		if (seen.has(node)) {
			return
		}
		seen.add(node)
		switch (node._tag) {
			case "Compare":
			case "In":
			case "Exists":
				output.add(node.field)
				return
			case "And":
			case "Or":
				node.conditions.forEach(visit)
				return
			case "Not":
				visit(node.condition)
				return
			default:
				return
		}
	}
	visit(condition)
	return Array.from(output)
}

/**
 * The JSON form of a condition with no predicate.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Encoded =
	Exclude<Ast, Predicate | And | Or | Not> | EncodedAnd | EncodedOr | EncodedNot

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedAnd {
	readonly _tag: "And"
	readonly conditions: ReadonlyArray<Encoded>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedOr {
	readonly _tag: "Or"
	readonly conditions: ReadonlyArray<Encoded>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedNot {
	readonly _tag: "Not"
	readonly condition: Encoded
}

const ScalarSchema = Schema.Union([
	Schema.String,
	Schema.Finite,
	Schema.Boolean,
	Schema.Null,
])

const OperandSchema = Schema.Union([
	Schema.TaggedStruct("Literal", { value: ScalarSchema }),
	Schema.TaggedStruct("Principal", { path: Schema.String }),
])

const Recursive = Schema.suspend((): Schema.Codec<Condition, Encoded> => schema)

/**
 * The Schema of a condition with no predicate. It checks the shape only. Use
 * `Policy.schema` to check the field names against a domain too.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema: Schema.Codec<Condition, Encoded> = Schema.Union([
	Schema.TaggedStruct("True", {}),
	Schema.TaggedStruct("False", {}),
	Schema.TaggedStruct("Compare", {
		op: Schema.Literals(["eq", "ne", "lt", "lte", "gt", "gte"]),
		field: Schema.String,
		value: OperandSchema,
	}),
	Schema.TaggedStruct("In", {
		field: Schema.String,
		values: Schema.Array(OperandSchema),
	}),
	Schema.TaggedStruct("Exists", { field: Schema.String }),
	Schema.TaggedStruct("Under", { prefix: Schema.Array(OperandSchema) }),
	Schema.TaggedStruct("And", { conditions: Schema.Array(Recursive) }),
	Schema.TaggedStruct("Or", { conditions: Schema.Array(Recursive) }),
	Schema.TaggedStruct("Not", { condition: Recursive }),
]) as never
