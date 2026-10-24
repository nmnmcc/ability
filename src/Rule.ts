/**
 * A rule says that a principal may (`Allow`) or may not (`Deny`) do some
 * actions on some resources. A rule may have:
 * - a condition, which must be true for the rule to apply;
 * - a list of fields, for rules about parts of a resource;
 * - a reason, an id, and extra data (`meta`).
 *
 * Rules do not change, and two rules with the same data are equal. A rule
 * works in a generator, so you can write `yield* _.allow(...)` inside
 * `Policy.define`.
 *
 * The action `"*"` means every action. The resource `"*"` means every
 * resource.
 *
 * Field names in a rule may have patterns. `*` stands for any part of one
 * field name, and `**` stands for any number of parts. So `address.*` covers
 * `address.city`, and `**` covers every field.
 *
 * @stability stable
 * @since 0.3.0
 */
import * as Data from "effect/Data"
import type * as Pipeable from "effect/Pipeable"
import * as Condition from "./Condition.ts"
import type * as Domain from "./Domain.ts"
import * as Resource from "./Resource.ts"

/**
 * A rule. `E`, `R` and `O` come from its condition. See
 * `Condition.Condition`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Rule<E = never, R = never, O = never>
	extends Shape<E, R, O>, Pipeable.Pipeable {
	readonly "~Rule"?: Condition.Variance<E, R, O>
	[Symbol.iterator](): Generator<Rule<E, R, O>, Rule<E, R, O>, unknown>
}

/**
 * The data of a rule.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Shape<E = never, R = never, O = never> {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Condition<E, R, O>
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
}

/**
 * Any rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Rule<any, any, any>

/**
 * The error type of a rule.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Error<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a rule.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Services<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * `Condition.Opaque` when a rule has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer _E, infer _R, infer O>
}
	? O
	: never

/**
 * A resource in a rule: a kind name, a resource of the domain, or `"*"`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Target<D> = Domain.Kind<D> | Domain.Resources<D> | "*"

/**
 * The kind name of a target.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type KindOf<T> = T extends string ? T : Resource.Kind<T>

/**
 * The actions that a rule may use for the kinds `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ActionFor<D, K> =
	| "*"
	| ("*" extends K
			? Domain.AnyAction<D>
			: Domain.ActionOf<D, Extract<K, string>>)

/**
 * The data type of the kinds `K`. For `"*"` it has no fields.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DataFor<D, K> = "*" extends K
	? {}
	: Domain.DataOf<D, Extract<K, string>>

/**
 * The value type of the kinds `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ValueFor<D, K> = "*" extends K
	? Domain.AnyValue<D>
	: Domain.ValueOf<D, Extract<K, string>>

/**
 * A field name or a field pattern of the kinds `K`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FieldFor<D, K> =
	Condition.FieldPath<DataFor<D, K>> | `${string}*${string}`

/**
 * The options of a rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options<D, K, C extends Condition.Any> {
	/** The condition. It gets a builder with the types of the resource. */
	readonly when?: (
		builder: Condition.Builder<
			DataFor<D, K>,
			ValueFor<D, K>,
			Domain.Principal<D>
		>,
	) => C
	readonly fields?: ReadonlyArray<FieldFor<D, K>>
	readonly reason?: string
	readonly id?: string
	readonly meta?: Domain.Meta<D>
}

type SingleOrArray<A> = A | ReadonlyArray<A>

/**
 * Makes rules with the types of a domain.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Builder<D> {
	readonly allow: <
		const T extends Target<D>,
		const A extends ActionFor<D, KindOf<T>>,
		const C extends Condition.Any = Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: SingleOrArray<T>,
		options?: Options<D, KindOf<T>, C>,
	) => Rule<Condition.Error<C>, Condition.Services<C>, Condition.OpaqueOf<C>>
	readonly deny: <
		const T extends Target<D>,
		const A extends ActionFor<D, KindOf<T>>,
		const C extends Condition.Any = Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: SingleOrArray<T>,
		options?: Options<D, KindOf<T>, C>,
	) => Rule<Condition.Error<C>, Condition.Services<C>, Condition.OpaqueOf<C>>
}

/**
 * The class of every rule value. A rule works in a generator: it gives
 * itself, so `yield* _.allow(...)` gives the rule to `Policy.define`.
 */
class RuleData extends Data.Class<Shape<unknown, unknown, unknown>> {
	*[Symbol.iterator](): Generator<this, this, unknown> {
		yield this
		return this
	}
}

/**
 * Makes a rule from its data. It does not check the data against a domain.
 * Use {@link builder} for rules with types, or `Policy.schema` for rules from
 * JSON.
 *
 * @stability stable
 * @category constructors
 * @since 0.4.0
 */
export const make = <E = never, R = never, O = never>(
	data: Shape<E, R, O>,
): Rule<E, R, O> => {
	// A missing option is left out, so two rules with the same data are equal.
	const shape: { -readonly [K in keyof Shape<E, R, O>]: Shape<E, R, O>[K] } = {
		_tag: data._tag,
		actions: [...data.actions],
		resources: [...data.resources],
	}
	if (data.when !== undefined) shape.when = data.when
	if (data.fields !== undefined) shape.fields = [...data.fields]
	if (data.reason !== undefined) shape.reason = data.reason
	if (data.id !== undefined) shape.id = data.id
	if (data.meta !== undefined) shape.meta = data.meta
	return new RuleData(shape) as never
}

const toArray = <A>(value: A | ReadonlyArray<A>): ReadonlyArray<A> =>
	Array.isArray(value) ? value : [value as A]

const kindName = (target: unknown): string =>
	Resource.isResource(target)
		? Resource.descriptor(target).kind
		: (target as string)

const makeFromOptions =
	(tag: "Allow" | "Deny") =>
	(
		action: string | ReadonlyArray<string>,
		resource: unknown,
		options?: {
			readonly when?: (builder: never) => Condition.Any
			readonly fields?: ReadonlyArray<string>
			readonly reason?: string
			readonly id?: string
			readonly meta?: unknown
		},
	): Any =>
		make({
			_tag: tag,
			actions: toArray(action),
			resources: toArray(resource).map(kindName),
			...(options?.when === undefined
				? {}
				: { when: options.when(Condition.builder() as never) }),
			...(options?.fields === undefined ? {} : { fields: options.fields }),
			...(options?.reason === undefined ? {} : { reason: options.reason }),
			...(options?.id === undefined ? {} : { id: options.id }),
			...(options?.meta === undefined ? {} : { meta: options.meta }),
		})

const sharedBuilder = {
	allow: makeFromOptions("Allow"),
	deny: makeFromOptions("Deny"),
}

/**
 * Makes a rule builder for a domain.
 *
 * @example
 * ```ts
 * const _ = Rule.builder(App)
 * const rule = _.allow("read", Bot, {
 *   when: ($) => $.eq("ownerUserId", $.principal("userId")),
 * })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const builder = <D extends Domain.Any>(_domain: D): Builder<D> =>
	sharedBuilder as never

/**
 * Tests if a value is a rule.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isRule = (u: unknown): u is Any => u instanceof RuleData

const patternCache = new Map<string, RegExp>()

const compilePattern = (pattern: string): RegExp => {
	const cached = patternCache.get(pattern)
	if (cached !== undefined) {
		return cached
	}
	let source = ""
	let index = 0
	while (index < pattern.length) {
		const char = pattern[index]!
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*"
				index = index + 2
				continue
			}
			source += "[^.]*"
		} else {
			source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		}
		index = index + 1
	}
	const regex = new RegExp(`^${source}$`)
	patternCache.set(pattern, regex)
	return regex
}

/**
 * Tests if a field name matches a field name or a field pattern of a rule.
 *
 * @stability stable
 * @category predicates
 * @since 0.3.0
 */
export const matchesField = (pattern: string, field: string): boolean =>
	pattern.includes("*")
		? compilePattern(pattern).test(field)
		: pattern === field

/**
 * Tests the parts of a rule that do not need the resource value: the action,
 * the kind and the field.
 *
 * A rule with fields covers a request with no field only when it is an allow
 * rule. So "may update some fields" is a yes. A deny rule for some fields does
 * not stop a request for the whole value.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const matchesTarget = (
	rule: Any,
	target: {
		readonly action: string
		readonly kind: string
		readonly field?: string | undefined
	},
): boolean => {
	if (!rule.actions.includes("*") && !rule.actions.includes(target.action)) {
		return false
	}
	if (!rule.resources.includes("*") && !rule.resources.includes(target.kind)) {
		return false
	}
	if (rule.fields === undefined) {
		return true
	}
	if (target.field === undefined) {
		return rule._tag === "Allow"
	}
	const field = target.field
	return rule.fields.some((pattern) => matchesField(pattern, field))
}
