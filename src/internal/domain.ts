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
import * as ResourceData from "./resource.ts"

/** The class of every domain value. `isDomain` uses it to know a domain. */
class DomainData extends Data.Class<{
	readonly principal: Schema.Top
	readonly principalCatalog: Catalog.Catalog
	readonly resources: HashMap.HashMap<string, Resource.Descriptor>
}> {}

/**
 * Makes a domain. Each resource must have its own kind name.
 */
export const make = (options: {
	readonly principal: Schema.Top
	readonly resources: ReadonlyArray<Resource.Any>
}): DomainData => {
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
	// The fixed catalog checks field names and size when the domain is made.
	const principalCatalog = Catalog.catalogOf(options.principal.ast)
	return new DomainData({
		principal: options.principal,
		principalCatalog,
		resources,
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
