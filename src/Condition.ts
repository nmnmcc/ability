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
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Schema from "effect/Schema"
import * as Algebra from "./internal/algebra.ts"
import * as Catalog from "./internal/catalog.ts"
import * as Nodes from "./internal/nodes.ts"
import * as Search from "./internal/search.ts"
import * as Resource from "./Resource.ts"
import type * as Domain from "./Domain.ts"
import * as Codec from "./internal/condition-codec.ts"
import * as BuilderData from "./internal/condition-builder.ts"

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
 * all of them read. A condition that may read any values, as a decoded one,
 * has `any` here: it fits any rule, so it adds nothing to what the others
 * read. It must not take away what they read, as `any` in an intersection
 * would.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type ReadsOf<C> = (
	C extends { readonly "~Reads": (reads: infer I) => void }
		? (reads: 0 extends 1 & I ? unknown : I) => void
		: never
) extends (reads: infer I) => void
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

/** The next smaller path depth. A path has at most five parts. */
type PreviousDepth = [never, 0, 1, 2, 3, 4]

/** Optional keys keep their field Schema in `schema`. */
type Unwrap<S> = S extends { readonly schema: infer Inner } ? Inner : S

/** Only a nullable or optional union may expose a fixed object shape. */
type FixedSchema<S> =
	Unwrap<S> extends infer U
		? U extends { readonly members: readonly [infer A, infer B] }
			? A extends { readonly Type: null | undefined }
				? Unwrap<B>
				: B extends { readonly Type: null | undefined }
					? Unwrap<A>
					: never
			: U
		: never

type NestedFields<S> =
	FixedSchema<S> extends {
		readonly fields: infer F extends Schema.Struct.Fields
	}
		? F
		: never

type Paths<Fields, Depth extends number> = [Depth] extends [never]
	? never
	: string extends keyof Fields
		? never
		: {
				[K in keyof Fields & string]:
					| K
					| ([NestedFields<Fields[K]>] extends [never]
							? never
							: `${K}.${Paths<NestedFields<Fields[K]>, PreviousDepth[Depth]>}`)
			}[keyof Fields & string]

/** Real Schema field paths, with at most five parts. */
export type FieldPath<Fields> = (
	Fields extends unknown ? (path: Paths<Fields, 4>) => void : never
) extends (path: infer P) => void
	? P & string
	: never
/** Real fields and their parent paths that a request may name. */
export type FieldSelector<Fields> = FieldPath<Fields>
/** Real fields and their parent paths that a rule may name. */
export type FieldName<Fields> = FieldPath<Fields>

type Normalize<A> = Exclude<A, undefined> | (undefined extends A ? null : never)
type ValueAt<T, Path extends string> = T extends unknown
	? T extends object
		? Path extends `${infer Head}.${infer Tail}`
			? Head extends keyof T
				? ValueAt<T[Head], Tail>
				: never
			: Path extends keyof T
				? Normalize<T[Path]>
				: never
		: null
	: never

/** The value at a field path. Missing data has the value `null`. */
export type PathValue<T, Path extends string> = ValueAt<T, Path>

/** Values shared by all fields in a union of paths. */
export type FieldValue<
	Fields extends Schema.Struct.Fields,
	F extends string,
> = (
	Fields extends unknown
		? F extends unknown
			? (value: PathValue<Schema.Struct.Type<Fields>, F>) => void
			: never
		: never
) extends (value: infer V) => void
	? V
	: never

type SchemaAt<
	Fields,
	Path extends string,
> = Path extends `${infer Head}.${infer Tail}`
	? Head extends keyof Fields
		? SchemaAt<NestedFields<Fields[Head]>, Tail>
		: never
	: Path extends keyof Fields
		? Unwrap<Fields[Path]>
		: never

type ScalarSchema<S, Depth extends number = 4> = [Depth] extends [never]
	? false
	: S extends { readonly from: unknown }
		? false
		: S extends { readonly members: ReadonlyArray<infer M> }
			? false extends ScalarSchema<M, PreviousDepth[Depth]>
				? false
				: true
			: S extends {
						readonly ast: {
							readonly _tag:
								| "Null"
								| "Undefined"
								| "Never"
								| "String"
								| "Boolean"
								| "Number"
								| "Literal"
								| "Enum"
						}
				  }
				? true
				: S extends { readonly literals: ReadonlyArray<unknown> }
					? true
					: false

type ScalarPath<Fields extends Schema.Struct.Fields> = {
	[F in FieldPath<Fields>]: ScalarSchema<SchemaAt<Fields, F>> extends true
		? FieldValue<Fields, F> extends Scalar
			? F
			: never
		: never
}[FieldPath<Fields>]
type OrderedPath<Fields extends Schema.Struct.Fields> = {
	[F in ScalarPath<Fields>]: Exclude<FieldValue<Fields, F>, null> extends
		string | number
		? F
		: never
}[ScalarPath<Fields>]

type FieldsFor<D, K extends string> = "*" extends K ? {} : Domain.FieldsOf<D, K>
type ValueFor<D, K extends string> = "*" extends K
	? Domain.AnyValue<D>
	: Domain.ValueOf<D, K>

/**
 * A value for a field of type `A`: a fixed value, or a field of the principal
 * with the same type.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type OperandOf<A, P = never> = Extract<A, Scalar> | Ref<A, P>

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
 * Makes conditions for kind `K` of domain `D`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Builder<D, K extends string> {
	/** The field is equal to the value. */
	readonly eq: <
		const F extends ScalarPath<FieldsFor<D, K>>,
		const V extends OperandOf<FieldValue<FieldsFor<D, K>, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<ValueFor<D, K>, PrincipalOf<V, Domain.Principal<D>>>
	/** The field is not equal to the value. */
	readonly ne: <
		const F extends ScalarPath<FieldsFor<D, K>>,
		const V extends OperandOf<FieldValue<FieldsFor<D, K>, F>, any>,
	>(
		field: F,
		value: V,
	) => Test<ValueFor<D, K>, PrincipalOf<V, Domain.Principal<D>>>
	readonly lt: <
		const F extends OrderedPath<FieldsFor<D, K>>,
		const V extends OperandOf<
			Exclude<FieldValue<FieldsFor<D, K>, F>, null>,
			any
		>,
	>(
		field: F,
		value: V,
	) => Test<ValueFor<D, K>, PrincipalOf<V, Domain.Principal<D>>>
	readonly lte: <
		const F extends OrderedPath<FieldsFor<D, K>>,
		const V extends OperandOf<
			Exclude<FieldValue<FieldsFor<D, K>, F>, null>,
			any
		>,
	>(
		field: F,
		value: V,
	) => Test<ValueFor<D, K>, PrincipalOf<V, Domain.Principal<D>>>
	readonly gt: <
		const F extends OrderedPath<FieldsFor<D, K>>,
		const V extends OperandOf<
			Exclude<FieldValue<FieldsFor<D, K>, F>, null>,
			any
		>,
	>(
		field: F,
		value: V,
	) => Test<ValueFor<D, K>, PrincipalOf<V, Domain.Principal<D>>>
	readonly gte: <
		const F extends OrderedPath<FieldsFor<D, K>>,
		const V extends OperandOf<
			Exclude<FieldValue<FieldsFor<D, K>, F>, null>,
			any
		>,
	>(
		field: F,
		value: V,
	) => Test<ValueFor<D, K>, PrincipalOf<V, Domain.Principal<D>>>
	readonly in: <
		const F extends ScalarPath<FieldsFor<D, K>>,
		const Vs extends ReadonlyArray<
			OperandOf<FieldValue<FieldsFor<D, K>, F>, any>
		>,
	>(
		field: F,
		values: Vs,
	) => Test<ValueFor<D, K>, PrincipalOf<Vs[number], Domain.Principal<D>>>
	readonly exists: (field: FieldPath<FieldsFor<D, K>>) => Test<ValueFor<D, K>>
	readonly under: <const Ps extends ReadonlyArray<Scalar | Ref<Scalar, any>>>(
		...prefix: Ps
	) => Test<ValueFor<D, K>, PrincipalOf<Ps[number], Domain.Principal<D>>>
	readonly principal: <const F extends ScalarPath<Domain.PrincipalFields<D>>>(
		field: F,
	) => Ref<FieldValue<Domain.PrincipalFields<D>, F>, Domain.Principal<D>>
	readonly and: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<ReadsOf<Cs[number]>, OpaqueOf<Cs[number]>>
	readonly or: <const Cs extends ReadonlyArray<Any>>(
		...conditions: Cs
	) => Condition<ReadsOf<Cs[number]>, OpaqueOf<Cs[number]>>
	readonly not: <C extends Any>(
		condition: C,
	) => Condition<ReadsOf<C>, OpaqueOf<C>>
	/** A predicate may use the full class values, with their methods. */
	readonly predicate: <E = never, R = never>(
		name: string,
		test: (
			value: ValueFor<D, K>,
			principal: Domain.Principal<D>,
		) => boolean | Effect.Effect<boolean, E, R>,
	) => Condition<Reads<ValueFor<D, K>, Domain.Principal<D>>, Opaque<E, R>>
}

// A list of conditions goes in as an array, not as arguments: a call may take
// only so many arguments, and a decoded condition may have more children.
// The constructor copies the list, so a later change to the array of a caller
// does not change the condition.
const andOf = (conditions: ReadonlyArray<Ast>): Ast =>
	new Nodes.And(conditions as ReadonlyArray<Nodes.Node>)

const orOf = (conditions: ReadonlyArray<Ast>): Ast =>
	new Nodes.Or(conditions as ReadonlyArray<Nodes.Node>)

const makeNot = (condition: Ast): Ast => new Nodes.Not(condition as Nodes.Node)

/** Makes conditions with the fields of one kind in a domain. */
export const builder: <D extends Domain.Any, K extends Domain.Kind<D>>(
	domain: D,
	kind: K,
) => Builder<D, K> = BuilderData.make as never

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
 * that the predicate reads. The test reads the stable own data fields of the
 * values. A predicate may use the full class value.
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
export class Untranslatable extends Schema.TaggedError<
	Untranslatable,
	{ readonly brand: unique symbol }
>("@nmnmcc/ability/Condition/Untranslatable")("Untranslatable", {
	reason: Schema.String,
}) {}

const literalValue = (operand: Operand, field: string): Scalar => {
	if (operand._tag !== "Literal") {
		throw Untranslatable.make({
			reason: `The field "${field}" uses a principal field. Call Condition.partial first.`,
		})
	}
	return operand.value
}

/**
 * Folds a condition. A shared child is folded again for each place. The fixed depth limit keeps this walk small.
 */
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
		case "Predicate": {
			if (interpreter.predicate === undefined)
				throw Untranslatable.make({
					reason: `The predicate "${node.name}" can not become a query`,
				})
			return interpreter.predicate(node.name)
		}
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
	/** The Schema of the values to search. */
	readonly schema: Schema.Top
}

/** Tests whether some value makes a condition true within the fixed search limit. */
export const satisfiable = (
	condition: Any,
	options: SatisfiableOptions,
): Satisfiability =>
	Search.satisfiable(nodeOf(condition), Catalog.catalogOf(options.schema.ast))

/** A JSON text Codec for plain conditions bound to one kind of a domain. */
export const schema: <D extends Domain.Any, K extends Domain.Kind<D>>(
	domain: D,
	kind: K,
) => Schema.Codec<
	Condition<Reads<Domain.ValueOf<D, K>, Domain.Principal<D>>>,
	string
> = Codec.schema as never
