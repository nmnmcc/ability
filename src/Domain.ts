/**
 * A domain puts together the principal and all the resources of an
 * application. All other modules get their types from the domain. A rule may
 * only use the actions of its resource. A condition may only use the fields of
 * its resource and of the principal.
 *
 * @example
 * ```ts
 * import { Domain } from "@nmnmcc/ability"
 *
 * const App = Domain.make({ principal: Member, resources: [Document, Comment] })
 * ```
 *
 * @stability stable
 * @since 0.3.0
 */
import type * as HashMap from "effect/HashMap"
import type * as Schema from "effect/Schema"
import type * as Catalog from "./internal/catalog.ts"
import * as Internal from "./internal/domain.ts"
import type * as Limits from "./Limits.ts"
import type * as Resource from "./Resource.ts"

/** The Schema of a principal: a Schema of objects, such as a `Schema.Class`. */
type PrincipalSchema = Schema.Top & { readonly Type: object }

/**
 * A domain. `P` is the type of the principal, `Resources` is the union of the
 * resources, and `Meta` is the type of the extra data that a rule may keep.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Domain<
	P extends object,
	Resources extends Resource.Any,
	Meta,
> {
	readonly principal: PrincipalSchema
	/** The catalog of the data fields of the principal. */
	readonly principalCatalog: Catalog.Catalog
	/** The descriptor of each resource, by its kind name. */
	readonly resources: HashMap.HashMap<string, Resource.Descriptor>
	readonly meta: Schema.Top | undefined
	/** The limits of the domain: see `Limits`. */
	readonly limits: Limits.Limits
	readonly "~Domain"?: {
		readonly Principal: P
		readonly Resources: Resources
		readonly Meta: Meta
	}
}

/**
 * Any domain.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Domain<any, any, any>

/**
 * The type of the principal of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Principal<D> = D extends Domain<infer P, any, any> ? P : never

/**
 * The union of the resources of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Resources<D> = D extends Domain<any, infer R, any> ? R : never

/**
 * The type of the extra data that a rule of the domain may keep.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Meta<D> = D extends Domain<any, any, infer M> ? M : never

/**
 * The kind names of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Kind<D> = Resource.Kind<Resources<D>>

/**
 * The resource of a domain with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ResourceOf<D, K extends string> =
	Resources<D> extends infer R
		? R extends Resource.Resource<K, any, any, any>
			? R
			: never
		: never

/**
 * The actions of the resource with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ActionOf<D, K extends string> = Resource.Action<ResourceOf<D, K>>

/**
 * The actions that every kind in `K` has. For one kind, they are its actions.
 * For a union of kinds, an action of only some of them is left out, so a
 * value of the union type can not get an action that its kind does not have.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type CommonAction<D, K extends string> = (
	K extends unknown ? (action: ActionOf<D, K>) => void : never
) extends (action: infer A) => void
	? A
	: never

/**
 * All the actions of all the resources of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type AnyAction<D> = Resource.Action<Resources<D>>

/**
 * The data type of the resource with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DataOf<D, K extends string> = Resource.Data<ResourceOf<D, K>>

/**
 * The value type of the resource with the kind `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ValueOf<D, K extends string> = Resource.Value<ResourceOf<D, K>>

/**
 * The union of the value types of all the resources of a domain.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type AnyValue<D> = Resource.Value<Resources<D>>

/**
 * Makes a domain. Each resource must have its own kind name. Give `meta` when
 * rules must keep extra data, such as the scope of a grant. The `meta` Schema
 * may not need services, because `Policy.schema` gives a Schema that needs
 * none. The test of equality of rules walks the plain objects and lists of a
 * `meta` with any number of levels, and it gives any other value, as a class
 * or an `Option`, to `Equal`, which may fill the stack for a value with very
 * many levels.
 *
 * Give `limits` to set the limits of the domain, as
 * `{ limits: { fieldPathParts: 2000 } }`. Each one is a whole number from 1
 * up to its ceiling in `Limits.ceilings`, and a limit that you leave out has
 * its default. A wrong value is a defect.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make: <
	P extends PrincipalSchema,
	const Resources extends ReadonlyArray<Resource.Any>,
	M extends Schema.Codec<any, any, never, never> = Schema.Never,
>(options: {
	readonly principal: P
	readonly resources: Resources
	readonly meta?: M
	readonly limits?: Partial<Limits.Limits>
}) => Domain<P["Type"], Resources[number], M["Type"]> = Internal.make as never
