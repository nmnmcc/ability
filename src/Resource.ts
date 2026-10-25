/**
 * A resource is a kind of thing that a person may act on, such as a document
 * or an invoice. Each resource has a kind name, a list of actions, a Schema for its
 * data, and an optional path.
 *
 * Make a resource in one of two ways:
 * - {@link Class} makes a Schema class, in the same way as
 *   `Schema.TaggedClass`. The class is a Schema, a constructor, and a resource
 *   at the same time.
 * - {@link make} makes a resource from plain fields. Its values are plain
 *   objects with a `_tag` field.
 *
 * Every value of a resource has a `_tag` field with the kind name. The library
 * uses this field to find the resource of a value. It does not guess from the
 * constructor name.
 *
 * A path puts a resource inside a tree, such as
 * `["org", organizationId, "team", teamId, "doc", id]`. A condition can
 * then ask if a value is under a part of the tree. See `Condition.under`.
 *
 * @stability stable
 * @since 0.3.0
 */
import * as Arr from "effect/Array"
import { Class as DataClass } from "effect/Data"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Catalog from "./internal/catalog.ts"

/**
 * One part of a resource path. A string is a fixed part. A field reference
 * takes the part from a field of the value.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type PathSegment = string | FieldRef<string>

/**
 * A reference to a top-level field of a resource, used in a path.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface FieldRef<Name extends string> {
	readonly _tag: "Field"
	readonly field: Name
}

/**
 * The runtime data of a resource.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Descriptor {
	readonly kind: string
	readonly actions: ReadonlyArray<string>
	readonly path: ReadonlyArray<PathSegment> | undefined
	/** The catalog of the data fields of the values. */
	readonly catalog: Catalog.Catalog
	/**
	 * A struct Schema of the data of the values, with the `_tag` field. It is a
	 * struct also for a `Resource.Class`. The class Schema must not be read
	 * before the class is made, because Effect then binds the class Schema to
	 * the base class, and the values lose the getters of the class.
	 */
	readonly schema: Schema.Top
}

/**
 * A resource. `Kind` is its name, `Action` is the union of its actions, `Data`
 * is the type of its Schema fields, and `Value` is the type of its values.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Resource<
	Kind extends string,
	Action extends string,
	Data extends object,
	Value extends { readonly _tag: Kind },
> {
	readonly descriptor: Descriptor
	readonly "~Resource"?: {
		readonly Kind: Kind
		readonly Action: Action
		readonly Data: Data
		readonly Value: Value
	}
}

/**
 * Any resource.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Resource<string, string, object, { readonly _tag: string }>

/**
 * The kind name of a resource.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Kind<R> = R extends Resource<infer K, any, any, any> ? K : never

/**
 * The actions of a resource.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Action<R> = R extends Resource<any, infer A, any, any> ? A : never

/**
 * The type of the Schema fields of a resource, without `_tag`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Data<R> = R extends Resource<any, any, infer D, any> ? D : never

/**
 * The type of the values of a resource.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Value<R> = R extends Resource<any, any, any, infer V> ? V : never

/**
 * The options of a resource.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options<
	Actions extends ReadonlyArray<string>,
	Fields extends Schema.Struct.Fields,
> {
	readonly actions: Actions
	readonly fields: Fields
	/**
	 * Gives the path of the resource. The function gets one reference for each
	 * top-level field.
	 */
	readonly path?: (fields: {
		readonly [K in keyof Fields & string]: FieldRef<K>
	}) => ReadonlyArray<string | FieldRef<keyof Fields & string>>
}

/**
 * The class of the runtime data of a resource. {@link isResource} uses it to
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

/**
 * The type of a class made by {@link Class}.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Class<
	Self,
	Kind extends string,
	Actions extends ReadonlyArray<string>,
	Fields extends Schema.Struct.Fields,
> = Schema.Class<Self, Schema.TaggedStruct<Kind, Fields>, {}> &
	Resource<
		Kind,
		Actions[number],
		Schema.Struct.Type<Fields>,
		Self & { readonly _tag: Kind }
	> & {
		readonly kind: Kind
		readonly actions: Actions
	}

/**
 * Makes a resource as a Schema class. Use it in the same way as
 * `Schema.TaggedClass`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@nmnmcc/ability"
 *
 * class Document extends Resource.Class<Document>()("Document", {
 *   actions: ["read", "update"],
 *   fields: {
 *     id: Schema.String,
 *     teamId: Schema.NullOr(Schema.String),
 *   },
 *   path: (f) => ["team", f.teamId, "doc", f.id],
 * }) {}
 *
 * const document = new Document({ id: "d1", teamId: "t1" })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const Class: <Self = never>(
	identifier?: string,
) => <
	const Kind extends string,
	const Actions extends ReadonlyArray<string>,
	const Fields extends Schema.Struct.Fields,
>(
	kind: Kind,
	options: Options<Actions, Fields>,
) => [Self] extends [never]
	? "Missing `Self` type: use Resource.Class<Self>()(...)"
	: Class<Self, Kind, Actions, Fields> = ((identifier?: string) =>
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
	}) as never

/**
 * A resource made by {@link make}. Its values are plain objects.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Struct<
	Kind extends string,
	Actions extends ReadonlyArray<string>,
	Fields extends Schema.Struct.Fields,
> extends Resource<
	Kind,
	Actions[number],
	Schema.Struct.Type<Fields>,
	Schema.Struct.Type<Fields> & { readonly _tag: Kind }
> {
	readonly kind: Kind
	readonly actions: Actions
	readonly schema: Schema.TaggedStruct<Kind, Fields>
	/** Makes a value. It puts the `_tag` field on the value for you. */
	readonly make: (
		input: Schema.Struct.Type<Fields>,
	) => Schema.Struct.Type<Fields> & { readonly _tag: Kind }
}

/**
 * Makes a resource from plain fields. Its values are plain objects with a
 * `_tag` field.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make: <
	const Kind extends string,
	const Actions extends ReadonlyArray<string>,
	const Fields extends Schema.Struct.Fields,
>(
	kind: Kind,
	options: Options<Actions, Fields>,
) => Struct<Kind, Actions, Fields> = ((
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
}) as never

/**
 * Tests if a value is a resource.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isResource = (u: unknown): u is Any =>
	hasProperty(u, "descriptor") && u.descriptor instanceof ResourceDescriptor

/**
 * Gets the runtime data of a resource.
 *
 * @stability stable
 * @category getters
 * @since 0.3.0
 */
export const descriptor = (resource: Any): Descriptor => resource.descriptor

/**
 * Gives the kind name of a resource value, from its `_tag` field.
 *
 * @stability stable
 * @category getters
 * @since 1.0.0
 */
export const kindOf = (value: unknown): string | undefined =>
	hasProperty(value, "_tag") && typeof value._tag === "string"
		? value._tag
		: undefined
