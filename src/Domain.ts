/** A domain keeps the Schema of the principal and the resources of an app. */
import type * as HashMap from "effect/HashMap"
import type * as Schema from "effect/Schema"
import type * as Catalog from "./internal/catalog.ts"
import * as Internal from "./internal/domain.ts"
import type * as Resource from "./Resource.ts"

/** A Struct or Schema.Class with known data fields. */
export type PrincipalSchema = Schema.Top & {
	readonly Type: object
	readonly fields: Schema.Struct.Fields
}

/** The Schema and resources that give all the types of a policy. */
export interface Domain<P extends PrincipalSchema, R extends Resource.Any> {
	readonly principal: P
	readonly principalCatalog: Catalog.Catalog
	readonly resources: HashMap.HashMap<string, Resource.Descriptor>
	readonly "~Domain"?: { readonly Principal: P; readonly Resources: R }
}

/** Any domain. */
export type Any = Domain<any, any>
/** The full value type of the principal. */
export type Principal<D> = D extends Domain<infer P, any> ? P["Type"] : never
/** The data fields of the principal Schema. */
export type PrincipalFields<D> =
	D extends Domain<infer P, any> ? P["fields"] : never
/** The resources of the domain. */
export type Resources<D> = D extends Domain<any, infer R> ? R : never
/** The kind names of the domain. */
export type Kind<D> = Resource.Kind<Resources<D>>
/** The resource with kind K. */
export type ResourceOf<D, K extends string> =
	Resources<D> extends infer R
		? R extends Resource.Resource<K, any, any, any>
			? R
			: never
		: never
/** The actions of one kind. */
export type ActionOf<D, K extends string> = Resource.Action<ResourceOf<D, K>>
/** The actions shared by all kinds in K. */
export type CommonAction<D, K extends string> = (
	K extends unknown ? (action: ActionOf<D, K>) => void : never
) extends (action: infer A) => void
	? A
	: never
/** All actions of the domain. */
export type AnyAction<D> = Resource.Action<Resources<D>>
/** The field Schema definitions of one kind. */
export type FieldsOf<D, K extends string> = Resource.Fields<ResourceOf<D, K>>
/** The data type of one kind. */
export type DataOf<D, K extends string> = Resource.Data<ResourceOf<D, K>>
/** The full value type of one kind. */
export type ValueOf<D, K extends string> = Resource.Value<ResourceOf<D, K>>
/** All resource value types of the domain. */
export type AnyValue<D> = Resource.Value<Resources<D>>

/** Makes a domain. Each resource must have its own kind name. */
export const make: <
	P extends PrincipalSchema,
	const R extends ReadonlyArray<Resource.Any>,
>(options: {
	readonly principal: P
	readonly resources: R
}) => Domain<P, R[number]> = Internal.make as never
