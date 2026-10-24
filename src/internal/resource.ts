import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Resource from "../Resource.ts"

/** @internal */
export const TypeId = "~@nmnmcc/ability/Resource" as const

const fieldRefs = (fields: Schema.Struct.Fields) => {
	const refs: Record<string, Resource.FieldRef<string>> = {}
	for (const key of Object.keys(fields)) {
		refs[key] = Object.freeze({ _tag: "Field", field: key })
	}
	return Object.freeze(refs)
}

/**
 * Gives the struct fields inside a Schema. It looks through the wrappers of
 * `Schema.optionalKey` and `Schema.optional`, and through the members of a
 * union, such as `Schema.NullOr`. A union of structs gives the fields of each
 * struct.
 *
 * @internal
 */
export const structFields = (
	schema: unknown,
): ReadonlyArray<Schema.Struct.Fields> => {
	if (
		Predicate.hasProperty(schema, "fields") &&
		Predicate.isObject(schema.fields)
	) {
		return [schema.fields as Schema.Struct.Fields]
	}
	if (
		Predicate.hasProperty(schema, "members") &&
		Array.isArray(schema.members)
	) {
		return schema.members.flatMap(structFields)
	}
	if (Predicate.hasProperty(schema, "schema")) {
		return structFields(schema.schema)
	}
	return []
}

/**
 * Gives the paths of all data fields. A nested struct gives one path for each
 * of its own fields, with a dot between the names.
 */
const collectFieldPaths = (
	fields: Schema.Struct.Fields,
	prefix: string,
	output: Set<string>,
): void => {
	for (const key of Object.keys(fields)) {
		const path = prefix === "" ? key : `${prefix}.${key}`
		const nested = structFields(fields[key])
		if (nested.length > 0) {
			for (const inner of nested) collectFieldPaths(inner, path, output)
		} else {
			output.add(path)
		}
	}
}

const makeDescriptor = (
	kind: string,
	options: Resource.Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	schema: Schema.Top,
): Resource.Descriptor => {
	const fieldPaths = new Set<string>()
	collectFieldPaths(options.fields, "", fieldPaths)
	return Object.freeze({
		kind,
		actions: Object.freeze([...options.actions]),
		path:
			options.path === undefined
				? undefined
				: Object.freeze([...options.path(fieldRefs(options.fields))]),
		fieldPaths: Object.freeze(Array.from(fieldPaths)),
		schema,
	})
}

/** @internal */
export const Class =
	(identifier?: string) =>
	(
		kind: string,
		options: Resource.Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	) => {
		const Base = Schema.TaggedClass<any>(identifier)(kind, options.fields)
		const descriptor = makeDescriptor(kind, options, Base)
		return class extends Base {
			static readonly [TypeId] = descriptor
			static readonly kind = kind
			static readonly actions = descriptor.actions
		}
	}

/** @internal */
export const make = (
	kind: string,
	options: Resource.Options<ReadonlyArray<string>, Schema.Struct.Fields>,
) => {
	const schema = Schema.TaggedStruct(kind, options.fields)
	const descriptor = makeDescriptor(kind, options, schema)
	return Object.freeze({
		[TypeId]: descriptor,
		kind,
		actions: descriptor.actions,
		schema,
		make: (input: object) => schema.make(input as never),
	})
}

/** @internal */
export const isResource = (u: unknown): u is Resource.Any =>
	Predicate.hasProperty(u, TypeId)

/** @internal */
export const descriptor = (resource: Resource.Any): Resource.Descriptor =>
	resource[TypeId]
