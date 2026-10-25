/**
 * The values of resources: their descriptors, and the constructors of
 * `Resource.Class` and `Resource.make`. The types are in `Resource.ts`.
 */
import * as Arr from "effect/Array"
import { Class as DataClass } from "effect/Data"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import type {
	Any,
	Descriptor,
	FieldRef,
	Options,
	PathSegment,
} from "../Resource.ts"
import * as Catalog from "./catalog.ts"

/**
 * The class of the runtime data of a resource. `isResource` uses it to
 * know a resource.
 */
class ResourceDescriptor extends DataClass<Descriptor> {}

/**
 * Checks the names of the top fields of a resource at once, when it is made.
 * The names of nested fields are checked when the descriptor is made.
 */
const checkFields = (
	kind: string,
	options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
): void => {
	// The kind of a value comes from its `_tag`. A field with this name could
	// give a value another kind, so it is a defect.
	if (Object.hasOwn(options.fields, "_tag")) {
		throw new Error(`The resource "${kind}" may not have a field "_tag"`)
	}
	Arr.map(Object.keys(options.fields), (name) => {
		if (name.includes(".")) {
			throw new Error(`A field name may not have a dot: "${name}"`)
		}
		if (name === "") {
			throw new Error("A field name may not be empty")
		}
	})
}

/**
 * Gives a value that is made on first use, and then kept. The descriptor of a
 * resource reads its Schema, and a recursive Schema refers to the resource
 * class, so it can not be read while the class is made. The cell belongs to
 * one resource.
 */
const lazy = <A>(make: () => A): (() => A) => {
	const cell: { value?: A } = {}
	return () => {
		if (!("value" in cell)) {
			cell.value = make()
		}
		return cell.value as A
	}
}

/**
 * Checks each part of the path of a resource: a string, or a reference to a
 * top-level field of the resource. A reference to another field would read
 * nothing, and a rule on the path could then match a value by mistake.
 */
const checkPath = (
	kind: string,
	fields: Schema.Struct.Fields,
	path: ReadonlyArray<unknown>,
): ReadonlyArray<PathSegment> =>
	// `Array.from` gives `undefined` for a hole of a sparse array, so the check
	// sees each place.
	Arr.map(Array.from(path), (segment): PathSegment => {
		if (typeof segment === "string") {
			return segment
		}
		if (
			hasProperty(segment, "_tag") &&
			segment._tag === "Field" &&
			hasProperty(segment, "field") &&
			typeof segment.field === "string" &&
			Object.hasOwn(fields, segment.field)
		) {
			return { _tag: "Field", field: segment.field }
		}
		throw new globalThis.Error(
			`A part of the path of "${kind}" is not a string or a field of the resource`,
		)
	})

/**
 * Copies the options of a resource. The descriptor is made later, when it is
 * first read, so a change to the objects of the caller before then must not
 * change it: the Schema of the values and the descriptor must agree.
 */
const snapshot = (
	options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
): Options<ReadonlyArray<string>, Schema.Struct.Fields> => ({
	...options,
	actions: [...options.actions],
	fields: { ...options.fields },
})

const makeDescriptor = (
	kind: string,
	options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
): Descriptor => {
	const refs: Record<string, FieldRef<string>> = Object.fromEntries(
		Arr.map(Object.keys(options.fields), (key) => [
			key,
			{ _tag: "Field", field: key },
		]),
	)
	const struct = Schema.Struct(options.fields)
	return new ResourceDescriptor({
		kind,
		actions: [...options.actions],
		path:
			options.path === undefined
				? undefined
				: checkPath(kind, options.fields, options.path(refs)),
		catalog: Catalog.catalogOf(struct.ast),
		schema: Schema.TaggedStruct(kind, options.fields),
	})
}

/** Makes the class of `Resource.Class`. */
export const makeClass =
	(identifier?: string) =>
	(
		kind: string,
		input: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	) => {
		const options = snapshot(input)
		checkFields(kind, options)
		const Base = Schema.TaggedClass<any>(identifier)(kind, options.fields)
		const descriptor = lazy(() => makeDescriptor(kind, options))
		return class extends Base {
			static get descriptor() {
				return descriptor()
			}
			static readonly kind = kind
			static readonly actions = [...options.actions]
		}
	}

/** Makes a resource of `Resource.make`. */
export const makeStruct = (
	kind: string,
	input: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
) => {
	const options = snapshot(input)
	checkFields(kind, options)
	const schema = Schema.TaggedStruct(kind, options.fields)
	const descriptor = lazy(() => makeDescriptor(kind, options))
	return {
		get descriptor() {
			return descriptor()
		},
		kind,
		actions: [...options.actions],
		schema,
		make: (input: object) => schema.make(input as never),
	}
}

/** Tests if a value is a resource. */
export const isResource = (u: unknown): u is Any =>
	hasProperty(u, "descriptor") && u.descriptor instanceof ResourceDescriptor

/** Gets the runtime data of a resource. */
export const descriptor = (resource: Any): Descriptor => resource.descriptor

/** Gives the kind name of a resource value, from its `_tag` field. */
export const kindOf = (value: unknown): string | undefined =>
	hasProperty(value, "_tag") && typeof value._tag === "string"
		? value._tag
		: undefined
