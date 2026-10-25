/**
 * The values of rules, with no types. The types are in `Policy.ts`.
 *
 * Rules do not change, and two rules with the same data are equal. A rule
 * works in a generator: it gives itself, so `yield* _.allow(...)` gives the
 * rule to `Policy.define`.
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Condition from "../Condition.ts"
import type * as Domain from "../Domain.ts"
import type * as Resource from "../Resource.ts"
import * as ResourceData from "./resource.ts"
import * as Patterns from "./patterns.ts"

/** The data of a rule. */
export interface Shape {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Ast
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
	/**
	 * The domain of the builder that made the rule. Two domains may have the
	 * same types but other paths, so the types can not tell them apart. It is
	 * not in the JSON form of a rule.
	 */
	readonly domain?: Domain.Any
}

/** The class of every rule value. */
export class Rule extends Data.Class<Shape> {
	*[Symbol.iterator](): Generator<this, this, unknown> {
		yield this
		return this
	}
}

/** Makes a rule from its data. It does not check the data against a domain. */
export const make = (data: Shape): Rule =>
	// A missing option is left out, so two rules with the same data are equal.
	new Rule({
		_tag: data._tag,
		actions: [...data.actions],
		resources: [...data.resources],
		...(data.when === undefined ? {} : { when: data.when }),
		...(data.fields === undefined ? {} : { fields: [...data.fields] }),
		...(data.reason === undefined ? {} : { reason: data.reason }),
		...(data.id === undefined ? {} : { id: data.id }),
		...(data.meta === undefined ? {} : { meta: data.meta }),
		...(data.domain === undefined ? {} : { domain: data.domain }),
	})

/** Tests if a value is a rule. */
export const isRule = (u: unknown): u is Rule => u instanceof Rule

const toArray = <A>(value: A | ReadonlyArray<A>): ReadonlyArray<A> =>
	Array.isArray(value) ? value : [value as A]

const kindName = (target: unknown): string =>
	ResourceData.isResource(target)
		? ResourceData.descriptor(target).kind
		: (target as string)

/** The options of a rule from a builder, with no types. */
interface Options {
	readonly when?: (builder: never) => Condition.Ast
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
}

const fromOptions =
	(tag: "Allow" | "Deny", domain: Domain.Any) =>
	(
		action: string | ReadonlyArray<string>,
		resource: unknown,
		options?: Options,
	): Rule =>
		make({
			_tag: tag,
			actions: toArray(action),
			resources: Arr.map(toArray(resource), kindName),
			...(options?.when === undefined
				? {}
				: { when: options.when(Condition.builder() as never) }),
			...(options?.fields === undefined ? {} : { fields: options.fields }),
			...(options?.reason === undefined ? {} : { reason: options.reason }),
			...(options?.id === undefined ? {} : { id: options.id }),
			...(options?.meta === undefined ? {} : { meta: options.meta }),
			domain,
		})

/** Makes the rule builder of a domain. */
export const builder = (domain: Domain.Any) => ({
	allow: fromOptions("Allow", domain),
	deny: fromOptions("Deny", domain),
})

/**
 * Tests if a field name matches a field name or a field pattern of a rule. A
 * pattern matches the fields below a field that it matches too, so `settings`
 * matches `settings.model`.
 */
export const matchesField = (pattern: string, field: string): boolean =>
	Patterns.matches(Patterns.parseBound(pattern), field.split("."))

/**
 * Tests if a field pattern may match a field inside `field`, such as
 * `settings.secret` inside `settings`.
 */
export const matchesInside = (pattern: string, field: string): boolean =>
	Patterns.matchesBelow(Patterns.parseBound(pattern), field.split("."))

/**
 * Tests the parts of a rule that do not need the resource value: the action,
 * the kind and the field.
 *
 * A rule with an empty list of fields covers no request. A rule with fields
 * covers a request with no field only when it is an allow rule. So "may
 * update some fields" is a yes. A deny rule for some fields does not stop a
 * request for the whole value. With the `descriptor` of the kind, such an
 * allow rule covers the request only when one of its patterns matches a field
 * of the kind. A grant of fields that the kind does not have is not a grant of
 * some fields.
 */
export const matchesTarget = (
	rule: Shape,
	target: {
		readonly action: string
		readonly kind: string
		readonly field?: string | undefined
		readonly descriptor?: Resource.Descriptor | undefined
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
	// A rule for no fields is a rule for nothing. A grant with its last field
	// taken away must not cover the whole value.
	if (rule.fields.length === 0) {
		return false
	}
	if (target.field === undefined) {
		const descriptor = target.descriptor
		return (
			rule._tag === "Allow" &&
			(descriptor === undefined ||
				Arr.some(rule.fields, (pattern) =>
					Patterns.fitsCatalog(
						Patterns.parseBound(pattern),
						descriptor.catalog,
					),
				))
		)
	}
	const field = target.field
	return rule.fields.some((pattern) => matchesField(pattern, field))
}
