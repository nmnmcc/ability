/**
 * The values of rules, with no types. The types are in `Policy.ts`.
 *
 * Rules do not change, and two rules with the same data are equal. A rule
 * works in a generator: it gives itself, so `yield* _.allow(...)` gives the
 * rule to `Policy.define`.
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import * as Condition from "../Condition.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as ResourceData from "./resource.ts"
import * as Patterns from "./patterns.ts"
import * as Structure from "./structure.ts"

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

/**
 * The class of every rule value. The types are those of `Policy.Rule`: `D` is
 * the domain, `I` is what the tests of the condition read, and `X` is the
 * mark of the condition. With no types, as in the nodes of a policy, a rule
 * fits no domain, its condition fits no other rule, and it may have a
 * predicate.
 */
export class Rule<D = never, I = never, X = unknown> extends Data.Class<
	Policy.RuleShape<I, X>
> {
	/** Only in the types. */
	declare readonly "~Opaque": () => X
	/** Only in the types. */
	declare readonly "~Domain": (domain: D) => D
	// A private field makes the type of a rule its own, as for a policy: a
	// spread of a rule, or an object made by hand, is not a rule. `Equal` does
	// not read it. It comes last, so its `;` stays: the generator method below
	// needs one after a field. Node.js takes the `declare` fields out of the
	// code, and a `;` after one of them would go with it.
	readonly #rule = true;

	*[Symbol.iterator](): Generator<Rule<D, I, X>, Rule<D, I, X>, unknown> {
		yield this
		return this
	}

	// The `meta` of a rule may have very many levels, and the walk of
	// `Data.Class` calls itself for each level. So the equality is the one of
	// `Structure`, which does not fill the stack. The hash reads the parts
	// of the rule that are small, and the hash that the condition keeps, but
	// not the domain, which has the Schemas, or the `meta`. Two equal rules
	// still have one hash, since the equality reads every part.
	[Hash.symbol](): number {
		return Hash.structureKeys(
			this,
			Arr.filter(
				Object.keys(this),
				(key) => key !== "domain" && key !== "meta",
			),
		)
	}

	[Equal.symbol](that: unknown): boolean {
		return Structure.equals(kind, this, that)
	}

	/** Tests if a value is a rule, by its private field. */
	static is(u: unknown): u is Rule {
		return typeof u === "object" && u !== null && #rule in u
	}
}

const kind: Structure.Kind = {
	isNode: Nodes.isNode,
	isRecord: (u) => u instanceof Rule,
}

/** Makes a rule from its data. It does not check the data against a domain. */
export const make = (data: Shape): Rule =>
	// A missing option is left out, so two rules with the same data are equal.
	// The data has no types here, as the code below works with no types.
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
	} as never)

/**
 * Makes a rule from its data, as `Policy.rule` does. A condition with a
 * predicate is a defect: the types of the predicate tie it to the kinds of
 * the rule of a builder, and the binding can not check it.
 */
export const makePlain = (data: Shape): Rule => {
	if (data.when !== undefined && Nodes.isNode(data.when) && data.when.opaque) {
		throw new Error(
			"Policy.rule takes no condition with a predicate. Make the rule with Policy.builder.",
		)
	}
	return make(data)
}

/** Tests if a value is a rule. */
export const isRule = (u: unknown): u is Rule => Rule.is(u)

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

/** The tests of the field patterns of rules on the field of one request. */
export interface FieldTest {
	/**
	 * Tells if the field holds parts, as a record does. A deny rule for a part
	 * inside it covers a request for the whole field.
	 */
	readonly open: boolean
	/** The test of {@link matchesField} on the field. */
	readonly matches: (pattern: string) => boolean
	/** The test of {@link matchesInside} on the field. */
	readonly inside: (pattern: string) => boolean
}

/**
 * Makes the tests of field patterns on the field of a request for one walk,
 * such as one decision. A policy may name one pattern very many times, and
 * a test of a long field is slow, so each test keeps its answers by the text
 * of the pattern. The memos go away when the walk ends.
 */
export const fieldTestOf = (
	field: string,
	descriptor: Resource.Descriptor | undefined,
	parts: number,
): FieldTest => {
	const path = field.split(".")
	// Native maps: the hash of a string in Effect has no random seed, and a
	// policy could hold very many patterns with one hash. The engine hashes a
	// string with a random seed.
	const remember = (
		test: (pattern: Patterns.Pattern, path: ReadonlyArray<string>) => boolean,
	): ((pattern: string) => boolean) => {
		const memo = new Map<string, boolean>()
		return (pattern) => {
			const known = memo.get(pattern)
			if (known !== undefined) {
				return known
			}
			const found = test(Patterns.parseBound(pattern), path)
			memo.set(pattern, found)
			return found
		}
	}
	return {
		open:
			descriptor !== undefined &&
			(Catalog.lookup(descriptor.catalog, field, parts)?.open ?? false),
		matches: remember(Patterns.matches),
		inside: remember(Patterns.matchesBelow),
	}
}

/**
 * Makes the test "a field pattern matches some field of the catalog" for one
 * walk, such as one decision. A policy may name one pattern very many times,
 * so the test keeps each answer by the text of the pattern, and the memo goes
 * away when the walk ends. The binding puts a limit on the work of the
 * patterns of a policy on each kind, so one walk does at most that work.
 */
export const fitsOf = (
	catalog: Catalog.Catalog,
	parts: number,
): ((pattern: string) => boolean) => {
	// A native `Map`: the hash of a string in Effect has no random seed, and a
	// policy could hold very many patterns with one hash. The engine hashes a
	// string with a random seed.
	const memo = new Map<string, boolean>()
	return (pattern) => {
		const known = memo.get(pattern)
		if (known !== undefined) {
			return known
		}
		const found = Patterns.fitsCatalog(
			Patterns.parseBound(pattern),
			catalog,
			parts,
		)
		memo.set(pattern, found)
		return found
	}
}

/**
 * Tests the parts of a rule that do not need the resource value: the action,
 * the kind and the field.
 *
 * A rule with an empty list of fields covers no request. A rule with fields
 * covers a request with no field only when it is an allow rule. So "may
 * update some fields" is a yes. A deny rule for some fields does not stop a
 * request for the whole value. With the `descriptor` of the kind, such an
 * allow rule covers the request only when one of its patterns matches a field
 * of the kind, and a deny rule for a part of a field that holds parts covers
 * a request for the whole field. A grant of fields that the kind does not have is not a grant of
 * some fields.
 */
export const matchesTarget = (
	rule: Shape,
	target: {
		readonly action: string
		readonly kind: string
		readonly field?: string | undefined
		readonly descriptor?: Resource.Descriptor | undefined
		/** The test of {@link fitsOf} for the catalog of the descriptor. */
		readonly fits?: ((pattern: string) => boolean) | undefined
		/** The most parts of a field path in the domain. */
		readonly parts?: number | undefined
		/** The tests of {@link fieldTestOf} for the field, for this walk. */
		readonly fieldTest?: FieldTest | undefined
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
				Arr.some(
					rule.fields,
					target.fits ??
						fitsOf(descriptor.catalog, target.parts ?? Limits.fieldPathParts),
				))
		)
	}
	// A deny rule for a part inside a field that holds parts, as
	// `data.secret` inside `data`, also covers a request for the whole field.
	const test =
		target.fieldTest ??
		fieldTestOf(
			target.field,
			target.descriptor,
			target.parts ?? Limits.fieldPathParts,
		)
	const inside = rule._tag === "Deny" && test.open
	return rule.fields.some(
		(pattern) => test.matches(pattern) || (inside && test.inside(pattern)),
	)
}
