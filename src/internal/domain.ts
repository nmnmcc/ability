/**
 * The values of domains. The types are in `Domain.ts`.
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import type * as Domain from "../Domain.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import * as ResourceData from "./resource.ts"

/** The class of every domain value. `isDomain` uses it to know a domain. */
class DomainData extends Data.Class<{
	readonly principal: Schema.Top
	readonly principalCatalog: Catalog.Catalog
	readonly resources: HashMap.HashMap<string, Resource.Descriptor>
	readonly meta: Schema.Top | undefined
	readonly limits: Limits.Limits
}> {}

/** Stops a catalog with more fields in its list than the domain takes. */
const checkCatalog = (
	catalog: Catalog.Catalog,
	limits: Limits.Limits,
	name: string,
): void => {
	const fields = Catalog.fieldsOf(catalog, limits.fieldPathParts).length
	if (fields > limits.catalogFields) {
		throw Limits.exceeded(
			name,
			"catalogFields",
			"fields",
			fields,
			limits.catalogFields,
		)
	}
}

/**
 * Makes a domain. Each resource must have its own kind name. The limits that
 * the domain does not set have their defaults.
 */
export const make = (options: {
	readonly principal: Schema.Top
	readonly resources: ReadonlyArray<Resource.Any>
	readonly meta?: Schema.Top
	readonly limits?: Partial<Limits.Limits>
}): DomainData => {
	const limits = Limits.make(options.limits)
	const descriptors = Arr.map(options.resources, ResourceData.descriptor)
	const kinds = Arr.map(descriptors, (descriptor) => descriptor.kind)
	// Two resources with one kind name is a mistake in the code, not in the
	// data, so it is a defect.
	const twice = Arr.findFirst(
		kinds,
		(kind, index) => kinds.indexOf(kind) !== index,
	)
	if (Option.isSome(twice)) {
		throw new Error(`Two resources have the kind name "${twice.value}"`)
	}
	if (kinds.includes("*")) {
		throw new Error(`A resource may not have the kind name "*"`)
	}
	const resources = HashMap.fromIterable(
		Arr.map(
			descriptors,
			(descriptor) => [descriptor.kind, descriptor] as const,
		),
	)
	// The catalog checks the field names of the principal, so a bad name is a
	// defect when the domain is made. A Schema with more fields than the
	// domain takes is a defect too.
	const principalCatalog = Catalog.catalogOf(options.principal.ast)
	checkCatalog(principalCatalog, limits, "The Schema of the principal")
	Arr.forEach(descriptors, (descriptor) =>
		checkCatalog(
			descriptor.catalog,
			limits,
			`The Schema of the resource "${descriptor.kind}"`,
		),
	)
	return new DomainData({
		principal: options.principal,
		principalCatalog,
		resources,
		meta: options.meta,
		limits,
	})
}

/** Gives the descriptor of the resource with a kind name. */
export const descriptorOf = (
	domain: Domain.Any,
	kind: string,
): Resource.Descriptor | undefined =>
	Option.getOrUndefined(HashMap.get(domain.resources, kind))

/** Tests if a value is a domain. */
export const isDomain = (u: unknown): u is Domain.Any => u instanceof DomainData
