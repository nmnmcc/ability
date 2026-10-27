/** Domain-bound rules and exact field access. */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import type * as Schema from "effect/Schema"
import type * as Condition from "../Condition.ts"
import * as ConditionBuilder from "./condition-builder.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as Json from "./json.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as ResourceData from "./resource.ts"

/** The data of a rule. The domain is not part of its JSON text. */
export interface Shape {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Ast
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: Schema.Json
	readonly domain: Domain.Any
}

/** A rule has its own type and works in a policy generator. */
export class Rule<D = never, I = never, X = unknown> extends Data.Class<
	Policy.RuleShape<I, X>
> {
	declare readonly "~Opaque": () => X
	declare readonly "~Domain": (domain: D) => D
	readonly #weight: number

	constructor(data: Shape) {
		const base =
			1 +
			data.actions.length +
			data.resources.length +
			(data.fields?.length ?? 0) +
			(data.when?.weight ?? 0)
		if (base > Limits.policyNodes) {
			throw Limits.exceeded(
				"A rule",
				"policyNodes",
				"units",
				base,
				Limits.policyNodes,
			)
		}
		if (data.when !== undefined && !Nodes.isNode(data.when)) {
			throw new Error("A rule needs a whole condition tree")
		}
		const when =
			data.when === undefined
				? undefined
				: Nodes.bind(
						data.when,
						data.domain,
						data.resources.length === 1 ? data.resources[0]! : "*",
					)
		const meta = data.meta === undefined ? undefined : Json.copyMeta(data.meta)
		const weight = base + (meta?.size ?? 0)
		if (weight > Limits.policyNodes) {
			throw Limits.exceeded(
				"A rule",
				"policyNodes",
				"units",
				weight,
				Limits.policyNodes,
			)
		}
		super({
			_tag: data._tag,
			actions: [...data.actions],
			resources: [...data.resources],
			...(when === undefined ? {} : { when }),
			...(data.fields === undefined ? {} : { fields: [...data.fields] }),
			...(data.reason === undefined ? {} : { reason: data.reason }),
			...(data.id === undefined ? {} : { id: data.id }),
			...(meta === undefined ? {} : { meta: meta.value }),
			domain: data.domain,
		} as never)
		this.#weight = weight
	}

	get weight(): number {
		return this.#weight
	}

	*[Symbol.iterator](): Generator<Rule<D, I, X>, Rule<D, I, X>, unknown> {
		yield this
		return this
	}
}

/** Makes a rule. Policy construction checks its names against its domain. */
export const make = (data: Shape): Rule => new Rule(data)

/** Tests a rule by its class. */
export const isRule = (value: unknown): value is Rule => value instanceof Rule

const toArray = <A>(value: A | ReadonlyArray<A>): ReadonlyArray<A> =>
	Array.isArray(value) ? value : [value as A]

const kindName = (target: unknown): string =>
	ResourceData.isResource(target)
		? ResourceData.descriptor(target).kind
		: (target as string)

interface Options {
	readonly when?: (builder: never) => Condition.Ast
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: Schema.Json
}

const fromOptions =
	(tag: "Allow" | "Deny", domain: Domain.Any) =>
	(
		action: string | ReadonlyArray<string>,
		resource: unknown,
		options?: Options,
	): Rule => {
		const resources = Arr.map(toArray(resource), kindName)
		return make({
			_tag: tag,
			actions: toArray(action),
			resources,
			...(options?.when === undefined
				? {}
				: {
						when: options.when(
							ConditionBuilder.make(
								domain,
								resources.length === 1 ? resources[0]! : "*",
							) as never,
						),
					}),
			...(options?.fields === undefined ? {} : { fields: options.fields }),
			...(options?.reason === undefined ? {} : { reason: options.reason }),
			...(options?.id === undefined ? {} : { id: options.id }),
			...(options?.meta === undefined ? {} : { meta: options.meta }),
			domain,
		})
	}

/** Makes the rule builder of a domain. */
export const builder = (domain: Domain.Any) => ({
	allow: fromOptions("Allow", domain),
	deny: fromOptions("Deny", domain),
})

/** A parent selector includes its child fields. */
export const matchesField = (selector: string, field: string): boolean =>
	selector === "*" || selector === field || field.startsWith(`${selector}.`)

/** A child selector stops whole access to its parent. */
export const matchesInside = (selector: string, field: string): boolean =>
	selector.startsWith(`${field}.`)

export interface FieldTest {
	readonly open: boolean
	readonly matches: (selector: string) => boolean
	readonly inside: (selector: string) => boolean
}

/** Makes the exact and parent tests for one request field. */
export const fieldTestOf = (
	field: string,
	descriptor: Resource.Descriptor | undefined,
): FieldTest => ({
	open:
		descriptor === undefined ||
		(Catalog.lookup(descriptor.catalog, field)?.open ?? false),
	matches: (selector) => matchesField(selector, field),
	inside: (selector) => matchesInside(selector, field),
})

/** A selector must name a field. A star covers the full directory. */
export const fitsOf =
	(catalog: Catalog.Catalog): ((selector: string) => boolean) =>
	(selector) =>
		selector === "*"
			? catalog.fields.length > 0
			: Catalog.lookup(catalog, selector) !== undefined

/** Tests the action, kind and fields of a rule. */
export const matchesTarget = (
	rule: Pick<Shape, "_tag" | "actions" | "resources" | "fields">,
	target: {
		readonly action: string
		readonly kind: string
		readonly field?: string | undefined
		readonly descriptor?: Resource.Descriptor | undefined
		readonly fits?: ((selector: string) => boolean) | undefined
		readonly fieldTest?: FieldTest | undefined
	},
): boolean => {
	if (!rule.actions.includes("*") && !rule.actions.includes(target.action))
		return false
	if (!rule.resources.includes("*") && !rule.resources.includes(target.kind))
		return false
	if (rule.fields === undefined) return true
	if (rule.fields.length === 0) return false
	if (target.field === undefined) {
		return (
			rule._tag === "Allow" &&
			(target.descriptor === undefined ||
				Arr.some(rule.fields, target.fits ?? fitsOf(target.descriptor.catalog)))
		)
	}
	const test = target.fieldTest ?? fieldTestOf(target.field, target.descriptor)
	return Arr.some(
		rule.fields,
		(selector) =>
			test.matches(selector) ||
			(rule._tag === "Deny" && test.open && test.inside(selector)),
	)
}
