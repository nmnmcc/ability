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
import * as Arr from "effect/Array"
import type * as BigDecimal from "effect/BigDecimal"
import type * as Cause from "effect/Cause"
import type * as Chunk from "effect/Chunk"
import type * as DateTime from "effect/DateTime"
import type * as Duration from "effect/Duration"
import type * as Exit from "effect/Exit"
import type * as HashMap from "effect/HashMap"
import type * as HashSet from "effect/HashSet"
import type * as Option from "effect/Option"
import type * as Redacted from "effect/Redacted"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Result from "effect/Result"
import * as Algebra from "./internal/algebra.ts"
import * as Catalog from "./internal/catalog.ts"
import * as Json from "./internal/json.ts"
import * as Nodes from "./internal/nodes.ts"
import * as Search from "./internal/search.ts"
import * as Resource from "./Resource.ts"

/**
 * A value that a condition can compare.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Scalar = Nodes.Scalar

/**
 * A fixed value in a condition.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Literal = Nodes.Literal

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
export type PrincipalRef = Nodes.PrincipalRef

/**
 * A field of the principal with a known value type `A`, from a principal of
 * the type `P`. The type fields are only in the types. A test with the
 * reference reads a principal of the type `P`, so it can not go into a rule
 * of a domain with another principal.
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
export type CompareOperator = Nodes.CompareOperator

/**
 * Always true.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type True = Nodes.True

/**
 * Always false.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type False = Nodes.False

/**
 * Compares a field with a value. A missing field has the value `null`. `lt`,
 * `lte`, `gt` and `gte` are false when the two sides are not both numbers or
 * both strings.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Compare = Nodes.Compare

/**
 * True when a field is equal to one of the values.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type In = Nodes.In

/**
 * True when a field is not `null` and not missing.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Exists = Nodes.Exists

/**
 * True when the path of the resource starts with the prefix. A resource with
 * no path is never under a prefix.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Under = Nodes.Under

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type And = Nodes.And

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Or = Nodes.Or

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Not = Nodes.Not

/**
 * A test that runs an `Effect`. It can not become JSON or a query.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Predicate = Nodes.Predicate

/**
 * The nodes of a condition, without types. Each node is a class, and only the
 * builder, the functions of this module and the Schema make one. So a plain
 * object, or a spread of a node, is not a node.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Ast = Nodes.Node

/**
 * The mark of a condition with a predicate. `E` and `R` are the error type
 * and the service type of its predicates.
 *
 * @stability stable
 * @category models
 * @since 2.0.0
 */
export interface Opaque<out E = never, out R = never> {
	readonly "~Opaque": { readonly E: E; readonly R: R }
}

/**
 * The error type of the predicates of a mark `X`. A mark that is not an
 * {@link Opaque}, as `unknown` or `object`, may have any error.
 *
 * @stability stable
 * @category utility types
 * @since 2.0.0
 */
export type ErrorOf<X> = X extends Opaque<infer E, infer _R> ? E : unknown

/**
 * The service type of the predicates of a mark `X`. A mark that is not an
 * {@link Opaque}, as `unknown` or `object`, may need any service.
 *
 * @stability stable
 * @category utility types
 * @since 2.0.0
 */
export type ServicesOf<X> = X extends Opaque<infer _E, infer R> ? R : unknown

/**
 * The mark `X` with no services.
 *
 * @stability stable
 * @category utility types
 * @since 2.0.0
 */
export type Provided<X> =
	X extends Opaque<infer E, infer _R> ? Opaque<E> : Opaque<unknown>

/**
 * What the predicates of a condition read: a resource value of the type `V`
 * and a principal of the type `P`. It is only in the types.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export interface Reads<V, P> {
	readonly value: V
	readonly principal: P
}

/**
 * A condition. `I` is what its tests read: see {@link Reads}. `X` is
 * {@link Opaque} when the condition has a predicate, and `never` when it is
 * plain data. A plain condition can become JSON or a query.
 *
 * The two type fields are only in the types. `I` goes into a function as an
 * input, so a condition that reads a `Post` does not fit a rule for a
 * `Comment`. `X` comes out of a function, so a plain condition fits where a
 * condition with predicates may go.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Condition<I = unknown, X = never> = Ast & {
	readonly "~Reads": (reads: I) => void
	readonly "~Opaque": () => X
}

/**
 * Any condition.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Condition<any, any>

/**
 * What the tests of a condition read. For a union of conditions, it is what
 * all of them read.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type ReadsOf<C> = [C] extends [
	{ readonly "~Reads": (reads: infer I) => void },
]
	? I
	: unknown

/**
 * The mark of a condition: {@link Opaque} when it has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<C> = C extends { readonly "~Opaque": () => infer X }
	? X
	: never

type Leaf = string | number | boolean | bigint | symbol | null | undefined
/**
 * Values of a class that keeps its data inside. A path does not go into them,
 * as in the field paths of a resource, so a field with such a value is one
 * field. A condition can test only if it exists.
 */
type Whole =
	| ReadonlyMap<unknown, unknown>
	| ReadonlySet<unknown>
	| HashMap.HashMap<unknown, unknown>
	| HashSet.HashSet<unknown>
	| Date
	| URL
	| Uint8Array
	| Option.Option<unknown>
	| BigDecimal.BigDecimal
	| Duration.Duration
	| DateTime.DateTime
	| Redacted.Redacted<unknown>
	| Chunk.Chunk<unknown>
	| Cause.Cause<unknown>
	| Result.Result<unknown, unknown>
	| Exit.Exit<unknown, unknown>
	| File
	| FormData
	| RegExp
	| URLSearchParams
type PreviousDepth = [never, 0, 1, 2, 3]
type FieldPathInternal<
	T,
	Depth extends number,
	Arrays extends boolean,
	Parents extends boolean = false,
> = [Depth] extends [never]
	? never
	: {
			// A record with number keys has number keys, as `counts.1`.
			[K in keyof T & (string | number)]-?: PathsOf<
				`${K}`,
				NonNullable<T[K]>,
				Depth,
				Arrays,
				Parents
			>
		}[keyof T & (string | number)]

/**
 * The paths of one field `K` with the values `V`. Each kind of value in `V`
 * gives its own paths, so a field that holds a string or a struct is a field,
 * and the fields of the struct are fields too. A function is no field.
 */
type PathsOf<
	K extends string,
	V,
	Depth extends number,
	Arrays extends boolean,
	Parents extends boolean,
> =
	// A field that is only ever `null` or missing is a field too, and so is a
	// field that may hold any value, as one of `Schema.Unknown` may.
	| ([V] extends [never] ? K : {} extends V ? K : never)
	| ([Extract<V, Leaf | Whole>] extends [never] ? never : K)
	| ([Extract<V, ReadonlyArray<unknown>>] extends [never]
			? never
			: Arrays extends true
				? K
				: never)
	// A condition reads a field below `K` only when `K` holds plain data: a
	// list, a whole value such as a date, or a function may have a getter or a
	// method with the name, so the binding does not take such a read. A rule
	// or a request names a field and does not read it, so it may.
	| (Arrays extends true
			? ObjectPaths<
					K,
					Exclude<V, Leaf | Whole | Function | ReadonlyArray<unknown>>,
					Depth,
					Arrays,
					Parents
				>
			: [Extract<V, Whole | Function | ReadonlyArray<unknown>>] extends [never]
				? ObjectPaths<K, Exclude<V, Leaf>, Depth, Arrays, Parents>
				: never)

/** The paths of a field `K` that holds the objects `O`, and of the fields below. */
type ObjectPaths<
	K extends string,
	O,
	Depth extends number,
	Arrays extends boolean,
	Parents extends boolean,
> = [O] extends [never]
	? never
	: // A record is one field to a rule or a request, as `permittedFields`
		// lists it. So is a struct at the last part that a path may have, since
		// a path does not go below it.
		| (Parents extends true
				? K
				: Arrays extends true
					? string extends keyof O
						? K
						: number extends keyof O
							? K
							: [Depth] extends [0]
								? K
								: never
					: never)
		| `${K}.${FieldPathInternal<O, PreviousDepth[Depth], Arrays, Parents>}`

/**
 * The paths of the fields of `T` that hold one value, with dots for nested
 * fields. Arrays are left out. A map, a set, a date, a URL, a byte array, an
 * `Option` and the other value types of Effect, such as `BigDecimal` and
 * `Duration`, are one field, and a path does not go into them. A path does
 * not go into a field that may hold one of them or a list either. The type
 * goes down four levels, so type checking stays fast. For a union of types,
 * only the common fields are paths.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type FieldPath<T> = [T] extends [object]
	? FieldPathInternal<T, 4, false>
	: never

/**
 * The paths of the fields of `T` that a rule or a request may name, as in
 * `Rule.Options.fields`. They are the paths of {@link FieldPath}, and the
 * paths of arrays too: a rule may allow or deny a whole array field, and
 * `permittedFields` lists it.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type FieldSelector<T> = [T] extends [object]
	? FieldPathInternal<T, 4, true>
	: never

/**
 * The names that the `fields` of a rule may have: the paths of
 * {@link FieldSelector}, and the paths of the structs above them. A name of a
 * struct covers the fields below it.
 *
 * @stability stable
 * @category utility types
 * @since 2.0.0
 */
export type FieldName<T> = [T] extends [object]
	? FieldPathInternal<T, 4, true, true>
	: never

/**
 * The value type that fits every field in `F`. For one field, it is the type
 * of the field. For a union of fields, it is the values that each of them can
 * hold, so a value of a union type can not test a field of another type. For
 * a union of data types, as for a rule on two kinds, it is the values that
 * the field can hold in each of them.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type FieldValue<Data, F extends string> = (
	Data extends unknown
		? F extends unknown
			? (value: PathValue<Data, F>) => void
			: never
		: never
) extends (value: infer V) => void
	? V
	: never

type Normalize<A> = Exclude<A, undefined> | (undefined extends A ? null : never)

/**
 * The type of the field of `T` at `Path`. A field that may be missing may also
 * be `null`. Each type of a union gives its own value: a field below a value
 * that is not an object, as below a string, is `null`, as a read of it is.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type PathValue<T, Path extends string> = T extends unknown
	? PathValueIn<T, Path>
	: never

/** The type of the field at `Path` of `T`, which is not a union. */
type PathValueIn<T, Path extends string> = T extends object
	? Path extends `${infer Head}.${infer Rest}`
		? PathValue<ChildOf<T, Head>, Rest>
		: Normalize<ChildOf<T, Path>>
	: null

/**
 * The type of the part `Name` of `T`. A part of a path is text, so the part
 * `"1"` names the number key `1` too, as of a record with number keys.
 */
type ChildOf<T, Name extends string> = Name extends keyof T
	? T[Name]
	: Name extends `${infer N extends number}`
		? N extends keyof T
			? T[N]
			: number extends keyof T
				? T[number]
				: never
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
 * @since 1.0.0
 */
export type Test<Value, P = unknown> = Condition<Reads<Value, P>>

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
		const V extends OperandOf<FieldValue<Data, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	/** The field is not equal to the value. */
	readonly ne: <
		const F extends FieldPath<Data>,
		const V extends OperandOf<FieldValue<Data, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly lt: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly lte: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly gt: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	readonly gte: <
		const F extends OrderedPath<Data>,
		const V extends OperandOf<Exclude<FieldValue<Data, F>, null>, any>,
	>(
		field: F,
		value: V,
	) => Test<Value, PrincipalOf<V, P>>
	/** The field is equal to one of the values. */
	readonly in: <
		const F extends FieldPath<Data>,
		const Vs extends ReadonlyArray<OperandOf<FieldValue<Data, F>, any>>,
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
	) => Condition<ReadsOf<Cs[number]>, OpaqueOf<Cs[number]>>
	readonly or: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<ReadsOf<Cs[number]>, OpaqueOf<Cs[number]>>
	readonly not: <C extends Any>(
		condition: C,
	) => Condition<ReadsOf<C>, OpaqueOf<C>>
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
	) => Condition<Reads<Value, P>, Opaque<E, R>>
}

const isOperand = (u: unknown): u is Operand =>
	hasProperty(u, "_tag") && (u._tag === "Literal" || u._tag === "Principal")

const toOperand = (value: unknown): Operand =>
	isOperand(value) ? value : Nodes.literal(value as Scalar)

const compare =
	(op: CompareOperator) =>
	(field: string, value: unknown): Ast =>
		new Nodes.Compare({ op, field, value: toOperand(value) })

// A list of conditions goes in as an array, not as arguments: a call may take
// only so many arguments, and a decoded condition may have more children.
// The constructor copies the list, so a later change to the array of a caller
// does not change the condition.
const andOf = (conditions: ReadonlyArray<Ast>): Ast =>
	new Nodes.And(conditions as ReadonlyArray<Nodes.Node>)

const orOf = (conditions: ReadonlyArray<Ast>): Ast =>
	new Nodes.Or(conditions as ReadonlyArray<Nodes.Node>)

const makeNot = (condition: Ast): Ast => new Nodes.Not(condition as Nodes.Node)

const sharedBuilder: Builder<any, any, any> = {
	eq: compare("eq"),
	ne: compare("ne"),
	lt: compare("lt"),
	lte: compare("lte"),
	gt: compare("gt"),
	gte: compare("gte"),
	in: (field: string, values: ReadonlyArray<unknown>) =>
		new Nodes.In({ field, values: Arr.map(Array.from(values), toOperand) }),
	exists: (field: string) => new Nodes.Exists({ field }),
	under: (...prefix: ReadonlyArray<unknown>) =>
		new Nodes.Under({ prefix: Arr.map(prefix, toOperand) }),
	principal: (path: string) => Nodes.principalRef(path),
	and: (...conditions: ReadonlyArray<Ast>) => andOf(conditions),
	or: (...conditions: ReadonlyArray<Ast>) => orOf(conditions),
	not: makeNot,
	predicate: (
		name: string,
		test: (
			value: unknown,
			principal: unknown,
		) => boolean | Effect.Effect<boolean, unknown, unknown>,
	) =>
		new Nodes.Predicate({
			name,
			run: (value, principal) =>
				Effect.suspend(() => {
					const result = test(value, principal)
					return Effect.isEffect(result) ? result : Effect.succeed(result)
				}),
		}),
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
export const always: Condition = Nodes.always as never

/**
 * Always false.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const never: Condition = Nodes.never as never

/**
 * True when all the conditions are true. With no conditions, it is true.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const and: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<ReadsOf<Cs[number]>, OpaqueOf<Cs[number]>> = ((
	...conditions: ReadonlyArray<Ast>
) => andOf(conditions)) as never

/**
 * The same as {@link and}, for a list of conditions of one type. Use it for a
 * long list: a function call may take only so many arguments.
 *
 * @stability stable
 * @category combinators
 * @since 1.0.0
 */
export const andAll: <C extends Any>(
	conditions: ReadonlyArray<C>,
) => Condition<ReadsOf<C>, OpaqueOf<C>> = andOf as never

/**
 * The same as {@link or}, for a list of conditions of one type. Use it for a
 * long list: a function call may take only so many arguments.
 *
 * @stability stable
 * @category combinators
 * @since 1.0.0
 */
export const orAll: <C extends Any>(
	conditions: ReadonlyArray<C>,
) => Condition<ReadsOf<C>, OpaqueOf<C>> = orOf as never

/**
 * True when one of the conditions is true. With no conditions, it is false.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const or: <const Cs extends ReadonlyArray<Any>>(
	...conditions: Cs
) => Condition<ReadsOf<Cs[number]>, OpaqueOf<Cs[number]>> = ((
	...conditions: ReadonlyArray<Ast>
) => orOf(conditions)) as never

/**
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const not: <C extends Any>(
	condition: C,
) => Condition<ReadsOf<C>, OpaqueOf<C>> = makeNot as never

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

/** Gives a condition as a node. A value that no constructor made is a defect. */
const nodeOf = (condition: Ast): Nodes.Node => Nodes.toNode(condition)

/**
 * Gives the services in `context` to every predicate of a condition, so the
 * condition needs no services when it runs.
 *
 * @stability stable
 * @category services
 * @since 1.0.0
 */
export const provideContext: {
	<R>(
		context: Context.Context<R>,
	): <I, X>(
		condition: Condition<I, X> &
			([ServicesOf<X>] extends [R] ? unknown : never),
	) => Condition<I, Provided<X>>
	<I, X>(
		condition: Condition<I, X>,
		context: Context.Context<ServicesOf<X>>,
	): Condition<I, Provided<X>>
} = dual(2, (condition: Ast, context: Context.Context<never>): Ast =>
	Algebra.provide(nodeOf(condition), context),
) as never

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
 * Tests a condition on a value. A predicate may fail with its error. When the
 * condition has a predicate, the input must have the value and the principal
 * that the predicate reads. The test runs on the simple form of the condition
 * with the principal in it, so it reads only the fields that a residual reads.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluate: <I, X, In extends Input>(
	condition: Condition<I, X>,
	input: In & ReadsInput<I>,
) => Effect.Effect<boolean, ErrorOf<X>, ServicesOf<X>> = ((
	condition: Ast,
	input: Input,
): Effect.Effect<boolean, unknown, unknown> =>
	Effect.suspend(() => Algebra.evaluate(nodeOf(condition), input))) as never

/**
 * Tests a condition with no predicate on a value, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const evaluateSync: <I, In extends Input>(
	condition: Condition<I>,
	input: In & ReadsInput<I>,
) => boolean = (condition: Ast, input: Input): boolean =>
	Algebra.evaluateSync(nodeOf(condition), input)

/**
 * Makes a condition smaller without a change to its meaning. It removes `True`
 * and `False` from `And` and `Or`, joins nested `And` and `Or` nodes, and
 * removes double `Not` nodes and copies of a child.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const simplify: <I, X>(condition: Condition<I, X>) => Condition<I, X> =
	((condition: Ast) => condition.pipe(nodeOf, Algebra.simplify)) as never

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
export const partial: <I, X>(
	condition: Condition<I, X>,
	input: PartialInput & PrincipalInput<I>,
) => Condition<Bound<I>, X> = ((condition: Ast, input: PartialInput): Ast =>
	Algebra.partial(nodeOf(condition), input)) as never

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

/** Folds a condition. A shared child is folded again for each place. */
const foldNode = <A>(node: Nodes.Node, interpreter: Interpreter<A>): A => {
	switch (node._tag) {
		case "True":
			return interpreter.true()
		case "False":
			return interpreter.false()
		case "Compare":
			return interpreter.compare(
				node.op,
				node.field,
				literalValue(node.value, node.field),
			)
		case "In":
			return interpreter.in(
				node.field,
				Arr.map(node.values, (operand) => literalValue(operand, node.field)),
			)
		case "Exists":
			return interpreter.exists(node.field)
		case "Under":
			throw Untranslatable.make({
				reason:
					"An Under node needs the resource path. Call Condition.partial first.",
			})
		case "And":
			return interpreter.and(
				Arr.map(node.conditions, (child) => foldNode(child, interpreter)),
			)
		case "Or":
			return interpreter.or(
				Arr.map(node.conditions, (child) => foldNode(child, interpreter)),
			)
		case "Not":
			return interpreter.not(foldNode(node.condition, interpreter))
		case "Predicate":
			if (interpreter.predicate === undefined) {
				throw Untranslatable.make({
					reason: `The predicate "${node.name}" can not become a query`,
				})
			}
			return interpreter.predicate(node.name)
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
		condition: Ast,
		interpreter: Interpreter<A>,
	): Effect.Effect<A, Untranslatable> =>
		Effect.try({
			try: () => foldNode(nodeOf(condition), interpreter),
			catch: (cause) => {
				if (cause instanceof Untranslatable) {
					return cause
				}
				throw cause
			},
		}),
)

/**
 * The fields that a condition uses, in the order that they first come.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const fields = (condition: Ast): ReadonlyArray<string> =>
	condition.pipe(nodeOf, Algebra.fields)

// Satisfiability

/**
 * Values of fields, as a nested object. A field that is not in it may have any
 * value. A value with parts that the search does not look into, such as a
 * date, is an empty object.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export type Example = Search.Example

/**
 * The answer of {@link satisfiable}:
 * - `Satisfiable`: some value makes the condition true. `example` is one.
 * - `Unsatisfiable`: no value makes the condition true.
 * - `Unknown`: the search can not say. The condition has a predicate, or
 *   the search went past its budget.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export type Satisfiability = Search.Satisfiability

/**
 * The options of {@link satisfiable}.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export interface SatisfiableOptions {
	/**
	 * The Schema of the values. Its shape gives the kinds of values of each
	 * field. Without it, a field may have any value.
	 */
	readonly schema?: Schema.Top | undefined
	/** The most steps that the search may take. The default is 1000000. */
	readonly budget?: number | undefined
}

/**
 * Tests if some value makes a condition true, and gives such a value.
 *
 * Call {@link partial} first: the condition must have no principal fields and
 * no `Under` nodes. A condition with a predicate gives `Unknown`.
 *
 * Each test of a condition compares one field with constants, so the
 * constants cut the values of each field into a few cells. The search tries
 * one value from each cell, one field at a time. The values of a field come
 * from the shape of the Schema in `options.schema`: its literals, `null` for
 * a nullable or optional field, and finite or integer numbers.
 *
 * The search reads the shape of the Schema, not its other checks, such as a
 * minimum length. So `Unsatisfiable` holds for every value of the Schema. A
 * `Satisfiable` example fits the shape, but a check may still stop it.
 *
 * The problem is as hard as boolean satisfiability, so the search has a
 * budget. Past it, the answer is `Unknown`. A condition with more than 256
 * fields gives `Unknown` too.
 *
 * @stability stable
 * @category evaluation
 * @since 1.0.0
 */
export const satisfiable = (
	condition: Any,
	options: SatisfiableOptions = {},
): Satisfiability =>
	Search.satisfiable(
		nodeOf(condition),
		Search.kindsIn(
			options.schema === undefined
				? undefined
				: Catalog.catalogOf(options.schema.ast),
		),
		options.budget,
	)

/**
 * The JSON form of an operand.
 *
 * @stability stable
 * @category models
 * @since 2.0.0
 */
export type EncodedOperand =
	| { readonly _tag: "Literal"; readonly value: Scalar }
	| { readonly _tag: "Principal"; readonly path: string }

/**
 * The JSON form of a condition with no predicate.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Encoded =
	| { readonly _tag: "True" }
	| { readonly _tag: "False" }
	| {
			readonly _tag: "Compare"
			readonly op: CompareOperator
			readonly field: string
			readonly value: EncodedOperand
	  }
	| {
			readonly _tag: "In"
			readonly field: string
			readonly values: ReadonlyArray<EncodedOperand>
	  }
	| { readonly _tag: "Exists"; readonly field: string }
	| { readonly _tag: "Under"; readonly prefix: ReadonlyArray<EncodedOperand> }
	| {
			readonly _tag: "And" | "Or"
			readonly conditions: ReadonlyArray<Encoded>
	  }
	| { readonly _tag: "Not"; readonly condition: Encoded }

/**
 * A condition with no predicate, that may read any values. It is the type of
 * {@link schema}: a decoded condition reads nothing, so it fits any rule, and
 * any plain condition, such as one from a builder or a residual, may be
 * encoded.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
// `any` for what it reads: the field is contravariant, so no other type both
// takes every condition and fits every rule.
export type PlainCondition = Condition<any>

/**
 * The Schema of a condition with no predicate. It checks the shape only. Use
 * `Policy.schema` to check the field names against a domain too.
 *
 * The decoder takes at most 500 levels of conditions, and at most 1000000
 * objects and array items, with a shared object counted for each place. It
 * reads only the own data fields of the input.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema: Schema.Codec<PlainCondition, Encoded> =
	Schema.Unknown.pipe(
		Schema.decodeTo(
			Schema.declare(
				(input): input is PlainCondition =>
					Nodes.isNode(input) && !input.opaque,
			),
			SchemaTransformation.transformEffect({
				decode: (input: unknown, options) =>
					Result.match(Json.decode(input), {
						onSuccess: (node) => Effect.succeed(node as never),
						onFailure: (problem) =>
							Effect.fail(
								new SchemaIssue.Pointer(
									problem.path,
									new SchemaIssue.InvalidValue(
										{ message: problem.message },
										input,
										options,
									),
								),
							),
					}),
				encode: (condition: PlainCondition) =>
					Effect.sync(() => Json.toJson(condition as never)),
			}),
		),
	) as never
