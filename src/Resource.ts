/**
 * A resource is a kind of thing that a person may act on, such as a Bot or a
 * document. Each resource has a kind name, a list of actions, a Schema for its
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
 * `["org", organizationId, "user", ownerUserId, "bot", id]`. A condition can
 * then ask if a value is under a part of the tree. See `Condition.under`.
 *
 * @stability stable
 * @since 0.3.0
 */
import { Class as DataClass } from "effect/Data"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as SchemaAST from "effect/SchemaAST"

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
	/** The paths of the data fields, with dots for nested fields. */
	readonly fieldPaths: ReadonlyArray<string>
	/** The Schema of the values, with the `_tag` field. */
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
	}) => ReadonlyArray<PathSegment>
}

/**
 * The class of the runtime data of a resource. {@link isResource} uses it to
 * know a resource.
 */
class ResourceDescriptor extends DataClass<Descriptor> {}

/**
 * Gives the structs inside a Schema, with the `Schema.suspend` nodes that are
 * open on the way to each one. It looks through optional keys, unions such as
 * `Schema.NullOr`, `Schema.suspend`, and `Schema.Class`. A suspend node that
 * is already open is not opened again, so a recursive Schema has an end.
 */
const structsOf = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): ReadonlyArray<readonly [SchemaAST.Objects, ReadonlySet<SchemaAST.AST>]> => {
	switch (ast._tag) {
		case "Objects":
			return ast.propertySignatures.length === 0 ? [] : [[ast, open]]
		case "Union":
			return ast.types.flatMap((type) => structsOf(type, open))
		case "Suspend":
			return open.has(ast)
				? []
				: structsOf(ast.thunk(), new Set([...open, ast]))
		case "Declaration": {
			// A `Schema.Class` is a declaration with one struct as its type
			// parameter, and it is encoded as that struct. Other declarations,
			// such as `Schema.Option` or `Schema.ReadonlyMap`, are not.
			const [inner] = ast.typeParameters
			return ast.encoding?.length === 1 &&
				ast.typeParameters.length === 1 &&
				inner?._tag === "Objects"
				? structsOf(inner, open)
				: []
		}
		default:
			return []
	}
}

/**
 * Visits the path of every field of a Schema, with a dot between the names of
 * nested fields. `leaf` is `false` for a field that is a struct.
 */
const walkFields = (
	ast: SchemaAST.AST,
	visit: (path: string, leaf: boolean) => void,
	prefix = "",
	open: ReadonlySet<SchemaAST.AST> = new Set(),
): void => {
	for (const [struct, inner] of structsOf(ast, open)) {
		for (const property of struct.propertySignatures) {
			if (typeof property.name !== "string") continue
			const path = prefix === "" ? property.name : `${prefix}.${property.name}`
			const leaf = structsOf(property.type, inner).length === 0
			visit(path, leaf)
			if (!leaf) walkFields(property.type, visit, path, inner)
		}
	}
}

/**
 * Gives the paths of all the fields of a Schema, with dots for nested fields.
 * A nested struct gives its own path and the paths of its fields. Arrays are
 * left out.
 *
 * @stability stable
 * @category getters
 * @since 0.4.0
 */
export const fieldPaths = (schema: Schema.Top): ReadonlyArray<string> => {
	const output = new Set<string>()
	walkFields(schema.ast, (path) => {
		output.add(path)
	})
	return Array.from(output)
}

const makeDescriptor = (
	kind: string,
	options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	schema: Schema.Top,
): Descriptor => {
	// The kind of a value comes from its `_tag`. A field with this name could
	// give a value another kind, so it is a defect.
	if (Object.hasOwn(options.fields, "_tag")) {
		throw new Error(`The resource "${kind}" may not have a field "_tag"`)
	}
	const refs: Record<string, FieldRef<string>> = {}
	for (const key of Object.keys(options.fields)) {
		refs[key] = { _tag: "Field", field: key }
	}
	const paths = new Set<string>()
	walkFields(Schema.Struct(options.fields).ast, (path, leaf) => {
		if (leaf) paths.add(path)
	})
	return new ResourceDescriptor({
		kind,
		actions: [...options.actions],
		path: options.path === undefined ? undefined : [...options.path(refs)],
		fieldPaths: Array.from(paths),
		schema,
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
 * class Bot extends Resource.Class<Bot>()("Bot", {
 *   actions: ["read", "update"],
 *   fields: {
 *     id: Schema.String,
 *     ownerUserId: Schema.NullOr(Schema.String),
 *   },
 *   path: (f) => ["user", f.ownerUserId, "bot", f.id],
 * }) {}
 *
 * const bot = new Bot({ id: "b1", ownerUserId: "u1" })
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
		options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
	) => {
		const Base = Schema.TaggedClass<any>(identifier)(kind, options.fields)
		const descriptor = makeDescriptor(kind, options, Base)
		return class extends Base {
			static readonly descriptor = descriptor
			static readonly kind = kind
			static readonly actions = descriptor.actions
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
	options: Options<ReadonlyArray<string>, Schema.Struct.Fields>,
) => {
	const schema = Schema.TaggedStruct(kind, options.fields)
	const descriptor = makeDescriptor(kind, options, schema)
	return {
		descriptor,
		kind,
		actions: descriptor.actions,
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
 * @since 0.4.0
 */
export const kindOf = (value: unknown): string | undefined =>
	hasProperty(value, "_tag") && typeof value._tag === "string"
		? value._tag
		: undefined
