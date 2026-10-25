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
import * as Arr from "effect/Array"
import { Class as DataClass } from "effect/Data"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import { hasProperty, isObject } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"

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
	/**
	 * The paths in {@link fieldPaths} of fields that hold more than one value,
	 * such as a record, a map or an array. The parts of such a field are not
	 * in `fieldPaths`, but a rule may name them.
	 */
	readonly openPaths: ReadonlyArray<string>
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

/** The prototypes from `prototype` up, below `Object.prototype`. */
const prototypesFrom = (prototype: unknown): ReadonlyArray<object> =>
	Arr.unfold(prototype, (current) =>
		typeof current === "object" &&
		current !== null &&
		current !== Object.prototype
			? Option.some([current, Object.getPrototypeOf(current)] as const)
			: Option.none(),
	)

/**
 * Gives the prototype of the class of a class node, or `undefined`. The node
 * does not keep the class: a class Schema with an annotation or a check, or
 * one inside `Schema.suspend`, is a new Schema with the same node. So the
 * walk asks the node to make a value with no check, and reads its prototype.
 *
 * This uses the `"~constructor"` annotation of Effect, which is not a public
 * API: it gives a link whose decode makes a value of the class from its
 * fields without a check. When that is not so, the walk gives `undefined`,
 * and the check of a policy says no to the getter.
 */
const classPrototype = (ast: SchemaAST.Declaration): object | undefined => {
	const make: unknown = ast.annotations?.["~constructor"]
	if (typeof make !== "function") {
		return undefined
	}
	try {
		const made: unknown = make(ast.typeParameters)
		const decode: unknown =
			hasProperty(made, "link") &&
			hasProperty(made.link, "transformation") &&
			hasProperty(made.link.transformation, "decode")
				? made.link.transformation.decode
				: undefined
		const value: unknown =
			hasProperty(decode, "transform") && typeof decode.transform === "function"
				? decode.transform({})
				: undefined
		return isObject(value) ? Object.getPrototypeOf(value) : undefined
	} catch {
		return undefined
	}
}

/**
 * Tests if a path names a getter of a class Schema, such as a getter of a
 * `Schema.Class` or a `Principal.Class`, at its root or in a nested field. A
 * condition reads such a field, and the types of a condition take it, so the
 * check of a policy takes it too. It goes into the fields of a struct, the
 * values of a record, the members of a union, `Schema.suspend`, and a class
 * with an annotation or a check.
 *
 * @stability stable
 * @category predicates
 * @since 0.5.0
 */
export const hasGetter = (schema: unknown, path: string): boolean =>
	!isTooLong(path) &&
	Schema.isSchema(schema) &&
	getterAt(
		schema.ast,
		path.split("."),
		0,
		(part, name) => part === name,
		new Map(),
	)

/**
 * The most parts that a field path may have. The walks below call themselves
 * for each part, and a path comes from the input of a policy. So a very long
 * path, as in a recursive Schema, could fill the stack.
 */
const maxPathParts = 256

/** Tests if a field path has more than {@link maxPathParts} parts. */
const isTooLong = (path: string): boolean =>
	path.split(".", maxPathParts + 1).length > maxPathParts

/**
 * Tests if a Schema has a getter of a class at a path whose parts fit
 * `parts`, as `hasGetter` does for one path. A part fits a name when `fits`
 * says so, as a part with `*` fits many names. A part `**` stands for any
 * number of parts, also none.
 *
 * @stability stable
 * @category predicates
 * @since 0.5.0
 */
export const hasMatchingGetter = (
	schema: unknown,
	parts: ReadonlyArray<string>,
	fits: (part: string, name: string) => boolean,
): boolean =>
	parts.length <= maxPathParts &&
	Schema.isSchema(schema) &&
	getterAt(schema.ast, parts, 0, fits, new Map())

/** The names of the getters of a prototype and the prototypes above it. */
const getterNames = (prototype: object | undefined): ReadonlyArray<string> =>
	Arr.flatMap(prototypesFrom(prototype), (current) =>
		Arr.filter(
			Object.getOwnPropertyNames(current),
			(name) =>
				Object.getOwnPropertyDescriptor(current, name)?.get !== undefined,
		),
	)

const getterAt = (
	ast: SchemaAST.AST,
	names: ReadonlyArray<string>,
	index: number,
	fits: (part: string, name: string) => boolean,
	memo: PathMemo<boolean>,
): boolean =>
	rememberAt(memo, ast, index, false, () => {
		const name = names[index]
		if (name === undefined) {
			return false
		}
		const last = index === names.length - 1
		const next = (type: SchemaAST.AST, at: number) =>
			getterAt(type, names, at, fits, memo)
		// A `**` may stand for no parts.
		if (name === "**" && !last && next(ast, index + 1)) {
			return true
		}
		switch (ast._tag) {
			case "Union":
				return Arr.some(ast.types, (type) => next(type, index))
			case "Suspend":
				return next(ast.thunk(), index)
			case "Declaration": {
				const inner = classStruct(ast)
				if (inner === undefined) {
					return false
				}
				// A path ends at a getter. The library can not see the type of
				// the value of a getter, so it can not check a path that goes
				// past it.
				return last
					? Arr.some(getterNames(classPrototype(ast)), (getter) =>
							fits(name, getter),
						)
					: next(inner, index)
			}
			case "Objects":
				return (
					!last &&
					(Arr.some(
						ast.propertySignatures,
						(property) =>
							typeof property.name === "string" &&
							// A `**` may stand for this part and more.
							((name === "**" && next(property.type, index)) ||
								(fits(name, property.name) && next(property.type, index + 1))),
					) ||
						// A record keeps the Schema of its keys and of its values.
						Arr.some(ast.indexSignatures, (signature) =>
							name === "**"
								? hasSomeKey(signature.parameter) &&
									(next(signature.type, index) ||
										next(signature.type, index + 1))
								: Arr.some(
										[name.replaceAll("*", ""), name.replaceAll("*", "a")],
										(key) =>
											fits(name, key) && keyFits(signature.parameter, key),
									) && next(signature.type, index + 1),
						))
				)
			default:
				return false
		}
	})

/**
 * Tests if a record takes a key. A key of an object is a string, also a key
 * that a number Schema takes: `{ 1: "a" }` has the key `"1"`. So a key that
 * is the text of a number is tried as that number too.
 */
const keyFits = (parameter: SchemaAST.AST, key: string): boolean => {
	const is = Schema.is(Schema.make(parameter))
	return (
		is(key) || (key !== "" && String(Number(key)) === key && is(Number(key)))
	)
}

/**
 * Gives the struct of a `Schema.Class`. A class is a declaration with one
 * struct as its type parameter, and Effect marks it with a `"~constructor"`
 * annotation, also through more codec steps, as in
 * `Schema.fromJsonString(User)`. Other declarations, such as
 * `Schema.OptionFromNullOr` or `Schema.ReadonlyMap`, have no such mark, and
 * the fields of their type parameter are not fields of the value.
 */
const classStruct = (
	ast: SchemaAST.Declaration,
): SchemaAST.Objects | undefined => {
	const [inner] = ast.typeParameters
	return ast.annotations?.["~constructor"] !== undefined &&
		ast.typeParameters.length === 1 &&
		inner?._tag === "Objects"
		? inner
		: undefined
}

/**
 * Gives the structs inside a Schema, with the `Schema.suspend` nodes that are
 * open on the way to each one. The open nodes are in a native `Set`, because
 * it must find a node by the node itself: `Equal` compares Schema nodes by
 * structure, and a recursive Schema has no end. It looks through optional keys, unions such as
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
			const inner = classStruct(ast)
			return inner === undefined ? [] : structsOf(inner, open)
		}
		default:
			return []
	}
}

/** Tests if a Schema holds one plain value, with no parts. */
/**
 * The kind of value that a field holds: one plain value, a record with keys
 * that the Schema does not name, or another value with parts, such as an
 * array or a map.
 */
type FieldShape = "scalar" | "record" | "other"

/** Gives the kind of value that a field holds. See {@link FieldShape}. */
const shapeOf = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST> = new Set(),
): FieldShape => {
	switch (ast._tag) {
		case "Objects":
			return ast.indexSignatures.length > 0 ? "record" : "other"
		case "Union": {
			const shapes = ast.types.map((type) => shapeOf(type, open))
			return shapes.every((shape) => shape === "scalar")
				? "scalar"
				: shapes.includes("record")
					? "record"
					: "other"
		}
		case "Suspend":
			return open.has(ast)
				? "other"
				: shapeOf(ast.thunk(), new Set([...open, ast]))
		default:
			return isScalar(ast) ? "scalar" : "other"
	}
}

const isScalar = (ast: SchemaAST.AST): boolean => {
	switch (ast._tag) {
		case "String":
		case "Number":
		case "Boolean":
		case "BigInt":
		case "Symbol":
		case "UniqueSymbol":
		case "Literal":
		case "Enum":
		case "TemplateLiteral":
		case "Null":
		case "Undefined":
			return true
		default:
			return false
	}
}

/**
 * Tests if a Schema holds, in some branch, a value that is not a struct: a
 * scalar, or a value such as a record or an array.
 */
const holdsValue = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): boolean => {
	switch (ast._tag) {
		case "Objects":
			// A struct with a record part, as from `Schema.StructWithRest`, holds
			// keys that are not named, so it holds more than one value.
			return (
				ast.propertySignatures.length === 0 || ast.indexSignatures.length > 0
			)
		case "Union":
			return ast.types.some((type) => holdsValue(type, open))
		case "Suspend":
			return !open.has(ast) && holdsValue(ast.thunk(), new Set([...open, ast]))
		case "Declaration":
			return classStruct(ast) === undefined
		default:
			return true
	}
}

/** One field that {@link walkFields} finds. */
interface FieldVisit {
	readonly path: string
	/**
	 * `true` for a field that holds a value that is not a struct, and `false`
	 * for a field that holds a struct.
	 */
	readonly leaf: boolean
	readonly type: SchemaAST.AST
}

/**
 * Gives the path of every field of a Schema, with a dot between the names of
 * nested fields. A field of a union may come two times: one time as a field
 * that holds a value, and one time as a field that holds a struct.
 */
const walkFields = (
	ast: SchemaAST.AST,
	prefix = "",
	open: ReadonlySet<SchemaAST.AST> = new Set(),
): ReadonlyArray<FieldVisit> =>
	Arr.flatMap(structsOf(ast, open), ([struct, inner]) =>
		Arr.flatMap(struct.propertySignatures, (property): Array<FieldVisit> => {
			const name = property.name
			if (typeof name !== "string") {
				return []
			}
			// A dot in a path is the step into a nested field. A field name with a
			// dot would make two fields have one path, so it is a defect.
			if (name.includes(".")) {
				throw new Error(`A field name may not have a dot: "${name}"`)
			}
			// An empty name would make an empty part in a path, such as `.secret`.
			if (name === "") {
				throw new Error("A field name may not be empty")
			}
			const path = prefix === "" ? name : `${prefix}.${name}`
			const type = property.type
			return [
				...(holdsValue(type, inner) ? [{ path, leaf: true, type }] : []),
				...(structsOf(type, inner).length > 0
					? [{ path, leaf: false, type }, ...walkFields(type, path, inner)]
					: []),
			]
		}),
	)

/**
 * Gives the paths of all the fields of a Schema, with dots for nested fields.
 * A nested struct gives its own path and the paths of its fields. Arrays are
 * left out. It throws when a field name has a dot or is empty, because such a
 * name would give two fields one path, or a path with an empty part.
 *
 * @stability stable
 * @category getters
 * @since 0.4.0
 */
export const fieldPaths = (schema: Schema.Top): ReadonlyArray<string> =>
	Arr.dedupe(Arr.map(walkFields(schema.ast), (visit) => visit.path))

/** Tests if a Schema holds only plain scalars: see {@link isPlainField}. */
/**
 * The ids of the checks that the search knows. `domainOf` reads them, so a
 * field with only these checks has an exact domain.
 */
const knownChecks = HashSet.make(
	"effect/schema/isInt",
	"effect/schema/isFinite",
)

/**
 * Tests if each check of a Schema node is a check that the search knows. A
 * check such as `isGreaterThan(0)` stops some values, and the search does not
 * see it, so it could find a value that the Schema does not take.
 */
const hasOnlyKnownChecks = (
	checks: ReadonlyArray<SchemaAST.Check<never>> | undefined,
): boolean =>
	Arr.every(checks ?? [], (check) =>
		check._tag === "FilterGroup"
			? hasOnlyKnownChecks(check.checks)
			: HashSet.has(knownChecks, check.annotations?.representation?.id),
	)

const isPlainScalar = (ast: SchemaAST.AST): boolean => {
	// `domainOf` reads the known checks only on a number node. A check on
	// another node, such as on a union of literals, is a check it can not see.
	if (
		ast._tag === "Number"
			? !hasOnlyKnownChecks(ast.checks)
			: (ast.checks ?? []).length > 0
	) {
		return false
	}
	switch (ast._tag) {
		case "String":
		case "Number":
		case "Boolean":
		case "Literal":
		case "Null":
		case "Undefined":
			return true
		case "Union":
			// A union in the mode "oneOf" stops a value that fits two members.
			// The search does not see that, so such a field is not plain.
			return (
				ast.options?.mode !== "oneOf" && Arr.every(ast.types, isPlainScalar)
			)
		default:
			return false
	}
}

/**
 * Tests if a path names a plain scalar field of a Schema: a string, a number,
 * a boolean, a literal, `null`, or an optional field or a union of these. Its
 * only checks may be integer and finite checks: another check, such as
 * `isGreaterThan(0)`, stops values that the search does not know about. On
 * the way, each part must be a required field of a plain struct with no
 * checks, with a name that is not a name of `Object.prototype`.
 *
 * `Policy.coverage` and `Condition.satisfiable` answer `All`, `None` or
 * `Some` only when each field of the condition is such a field. Their model of
 * the values of a field is exact for these Schemas. For other Schemas, such as
 * classes, records, unions of structs or declarations, a value may have data
 * that the Schema does not show, and the answer is `Unknown`.
 *
 * @stability stable
 * @category predicates
 * @since 0.5.0
 */
export const isPlainField = (schema: Schema.Top, path: string): boolean =>
	!isTooLong(path) && plainAt(schema.ast, path.split("."))

const plainAt = (ast: SchemaAST.AST, names: ReadonlyArray<string>): boolean => {
	const [name, ...rest] = names
	if (
		name === undefined ||
		ast._tag !== "Objects" ||
		ast.indexSignatures.length > 0 ||
		(ast.checks ?? []).length > 0 ||
		name in Object.prototype
	) {
		return false
	}
	const property = ast.propertySignatures.find(
		(signature) => signature.name === name,
	)
	if (property === undefined) {
		return false
	}
	return rest.length === 0
		? isPlainScalar(property.type)
		: !SchemaAST.isOptional(property.type) && plainAt(property.type, rest)
}

/**
 * Tests if a path names a field of a Schema that holds a value with no named
 * fields: a scalar, or a value such as a record or an array. It goes into
 * records by their keys, and into recursive Schemas as far as the path goes.
 * So it finds paths that {@link fieldPaths} does not list.
 *
 * @stability stable
 * @category predicates
 * @since 0.4.0
 */
export const hasPath = (schema: Schema.Top, path: string): boolean =>
	!isTooLong(path) && resolves(schema.ast, path.split("."), 0, new Map())

/**
 * The answers of a walk along a path, by Schema node and by place in the path.
 * Two branches of a union may come to one node at one place, as in a recursive
 * union, and the memo does that work one time. It is a native `Map`, because
 * it must find a Schema node by the node itself.
 */
type PathMemo<A> = Map<SchemaAST.AST, Map<number, A>>

/**
 * Gives the answer for a node at a place from the memo, or works it out and
 * keeps it. While the work runs, the memo holds `pending`, so a walk that
 * comes back to the node at the same place, with no step on the path, gets
 * `pending` and stops.
 */
const rememberAt = <A>(
	memo: PathMemo<A>,
	ast: SchemaAST.AST,
	index: number,
	pending: A,
	work: () => A,
): A => {
	const places = memo.get(ast) ?? new Map<number, A>()
	memo.set(ast, places)
	if (places.has(index)) {
		return places.get(index) as A
	}
	places.set(index, pending)
	const result = work()
	places.set(index, result)
	return result
}

const resolves = (
	ast: SchemaAST.AST,
	names: ReadonlyArray<string>,
	index: number,
	memo: PathMemo<boolean>,
): boolean =>
	rememberAt(memo, ast, index, false, () => {
		if (index === names.length) {
			return index > 0 && holdsValue(ast, new Set())
		}
		const name = names[index]!
		switch (ast._tag) {
			case "Objects": {
				const property = ast.propertySignatures.find(
					(signature) => signature.name === name,
				)
				if (property !== undefined) {
					return resolves(property.type, names, index + 1, memo)
				}
				// A key of a record must fit the Schema of the keys.
				return ast.indexSignatures.some(
					(signature) =>
						keyFits(signature.parameter, name) &&
						resolves(signature.type, names, index + 1, memo),
				)
			}
			case "Union":
				return ast.types.some((type) => resolves(type, names, index, memo))
			case "Suspend":
				return resolves(ast.thunk(), names, index, memo)
			case "Declaration": {
				const inner = classStruct(ast)
				return inner !== undefined && resolves(inner, names, index, memo)
			}
			default:
				return false
		}
	})

/**
 * Tests if a Schema has a field whose path fits a pattern. `parts` are the
 * parts of the pattern, split at the dots. A part `**` stands for any number
 * of parts, also none. Another part fits a name when `fits` says so, as a
 * part with `*` fits many names. For a record, the walk asks if the key
 * Schema takes a key that fits the part. For a template literal key Schema,
 * with parts that are literals and strings, the answer is exact. For another key Schema, the walk tries sample keys, so it may miss a
 * key, and then the answer is `false`.
 *
 * @stability stable
 * @category predicates
 * @since 0.5.0
 */
export const hasMatchingPath = (
	schema: Schema.Top,
	parts: ReadonlyArray<string>,
	fits: (part: string, name: string) => boolean,
): boolean =>
	parts.length <= maxPathParts &&
	matchesFrom(schema.ast, parts, 0, false, fits, new Map())

const matchesFrom = (
	ast: SchemaAST.AST,
	parts: ReadonlyArray<string>,
	index: number,
	stepped: boolean,
	fits: (part: string, name: string) => boolean,
	memo: PathMemo<boolean>,
): boolean =>
	// The memo keeps two answers for each place: before the first step, and
	// after it.
	rememberAt(memo, ast, index * 2 + (stepped ? 1 : 0), false, () => {
		const next = (type: SchemaAST.AST, at: number, step: boolean): boolean =>
			matchesFrom(type, parts, at, step, fits, memo)
		switch (ast._tag) {
			case "Union":
				return Arr.some(ast.types, (type) => next(type, index, stepped))
			case "Suspend":
				return next(ast.thunk(), index, stepped)
			case "Declaration": {
				const inner = classStruct(ast)
				if (inner !== undefined) {
					return next(inner, index, stepped)
				}
				break
			}
			default:
				break
		}
		// The path ends at a field that holds a value, as a field that a rule
		// may name does.
		if (index === parts.length) {
			return stepped && holdsValue(ast, new Set())
		}
		const part = parts[index]!
		if (part === "**" && next(ast, index + 1, stepped)) {
			return true
		}
		if (ast._tag !== "Objects") {
			return false
		}
		// Keys made from the part, and keys made from the key Schema. A key
		// Schema such as `TemplateLiteral(["x", String])` takes neither "" nor
		// "a", but it takes "x" and "xa".
		const fromPart = [part.replaceAll("*", ""), part.replaceAll("*", "a")]
		return (
			Arr.some(
				ast.propertySignatures,
				(property) =>
					typeof property.name === "string" &&
					(part === "**"
						? next(property.type, index, true)
						: fits(part, property.name) &&
							next(property.type, index + 1, true)),
			) ||
			Arr.some(ast.indexSignatures, (signature) =>
				part === "**"
					? // A step into a record needs a key that its key Schema takes.
						hasSomeKey(signature.parameter) && next(signature.type, index, true)
					: // A template literal key Schema gives an exact answer. Another
						// key Schema is tried with sample keys.
						(globMeetsKeys(part, signature.parameter) ??
							Arr.some(
								Arr.dedupe([...fromPart, ...sampleKeys(signature.parameter)]),
								(key) => keyFits(signature.parameter, key) && fits(part, key),
							)) &&
						next(signature.type, index + 1, true),
			)
		)
	})

/**
 * Tests if a key Schema takes some key: the exact search for a template
 * literal, or a sample key.
 */
const hasSomeKey = (parameter: SchemaAST.AST): boolean =>
	globMeetsKeys("*", parameter) ??
	Arr.some(Arr.dedupe(["", "a", ...sampleKeys(parameter)]), (key) =>
		keyFits(parameter, key),
	)

/** The longest key pattern that the exact search of keys takes. */
const maxExactKeyLength = 256

/** A part of a key pattern: one character, or `*` for any characters. */
type GlobToken =
	{ readonly _tag: "Char"; readonly char: string } | { readonly _tag: "Star" }

/** A part of a template literal: one character, or any characters. */
type TemplateToken =
	{ readonly _tag: "Char"; readonly char: string } | { readonly _tag: "Any" }

const charsOf = (text: string): ReadonlyArray<TemplateToken> =>
	Arr.map(Array.from(text), (char) => ({ _tag: "Char", char }) as const)

/**
 * Gives the token lists of a template literal, one for each choice of its
 * unions of literals, or `undefined` when the lists can not be exact: a part
 * that this walk does not know, such as a number, a part with checks, or
 * more than 64 lists.
 */
const templateTokens = (
	ast: SchemaAST.TemplateLiteral,
): ReadonlyArray<ReadonlyArray<TemplateToken>> | undefined => {
	const partTokens = (
		part: SchemaAST.AST,
	): ReadonlyArray<ReadonlyArray<TemplateToken>> | undefined => {
		if ((part.checks ?? []).length > 0) {
			return undefined
		}
		switch (part._tag) {
			case "Literal": {
				const text = String(part.literal)
				// A half of a pair of UTF-16 code units may join a half in the
				// next part, and the tokens of each part can not show that.
				return /[\uD800-\uDFFF]/.test(text) ? undefined : [charsOf(text)]
			}
			case "String":
				return [[{ _tag: "Any" }]]
			case "Number":
				// The tokens can not hold all numbers, such as `-1.5`, so the
				// search is not exact.
				return undefined
			case "Union": {
				// A union in the mode "oneOf" stops a key that fits two members,
				// and token lists can not show that.
				if (part.options?.mode === "oneOf") {
					return undefined
				}
				const choices = Arr.map(part.types, partTokens)
				return Arr.every(choices, (choice) => choice !== undefined)
					? Arr.flatten(
							choices as ReadonlyArray<
								ReadonlyArray<ReadonlyArray<TemplateToken>>
							>,
						)
					: undefined
			}
			default:
				return undefined
		}
	}
	return Arr.reduce(
		ast.parts,
		[[]] as ReadonlyArray<ReadonlyArray<TemplateToken>> | undefined,
		(lists, part) => {
			const choices = partTokens(part)
			if (lists === undefined || choices === undefined) {
				return undefined
			}
			// Each list so far, with each choice of this part. Past 64 lists the
			// search would not be exact, so it gives no answer.
			const all = Arr.flatMap(lists, (list) =>
				Arr.map(choices, (choice) => [...list, ...choice]),
			)
			// The search calls itself for each character, so a long list of
			// tokens gives no answer too.
			return all.length > 64 ||
				Arr.some(all, (list) => list.length > maxExactKeyLength)
				? undefined
				: all
		},
	)
}

/**
 * Tests if a key pattern and a list of template tokens share a key. It walks
 * the pairs of places in the two lists, with a few characters that stand for
 * all others, so the answer is exact for these tokens.
 */
const tokensMeet = (
	glob: ReadonlyArray<GlobToken>,
	template: ReadonlyArray<TemplateToken>,
): boolean => {
	const key = (t: number, g: number) => t * (glob.length + 1) + g
	// The places that a pair can reach with no character.
	const closeOf = (
		t: number,
		g: number,
	): ReadonlyArray<readonly [number, number]> => [
		[t, g],
		...(template[t]?._tag === "Any" ? closeOf(t + 1, g) : []),
		...(glob[g]?._tag === "Star" ? closeOf(t, g + 1) : []),
	]
	const alphabet = Arr.dedupe([
		"a",
		"0",
		...Arr.flatMap(glob, (token) =>
			token._tag === "Char" ? [token.char] : [],
		),
		...Arr.flatMap(template, (token) =>
			token._tag === "Char" ? [token.char] : [],
		),
	])
	const stepTemplate = (t: number, char: string): ReadonlyArray<number> => {
		const token = template[t]
		return token === undefined
			? []
			: token._tag === "Any"
				? [t]
				: token.char === char
					? [t + 1]
					: []
	}
	const stepGlob = (g: number, char: string): ReadonlyArray<number> => {
		const token = glob[g]
		return token === undefined
			? []
			: token._tag === "Char"
				? token.char === char
					? [g + 1]
					: []
				: char === "."
					? []
					: [g]
	}
	// A search over the pairs: each pair is seen one time.
	const search = (
		frontier: ReadonlyArray<readonly [number, number]>,
		seen: HashSet.HashSet<number>,
	): boolean => {
		// Each pair comes one time, also when many paths reach it, so the work
		// is at most the number of pairs.
		const fresh = Array.from(
			HashMap.values(
				HashMap.fromIterable(
					Arr.map(
						Arr.filter(
							Arr.flatMap(frontier, ([t, g]) => closeOf(t, g)),
							([t, g]) => !HashSet.has(seen, key(t, g)),
						),
						(pair) => [key(pair[0], pair[1]), pair] as const,
					),
				),
			),
		)
		if (fresh.length === 0) {
			return false
		}
		if (
			Arr.some(fresh, ([t, g]) => t === template.length && g === glob.length)
		) {
			return true
		}
		const next = HashSet.union(
			seen,
			HashSet.fromIterable(Arr.map(fresh, ([t, g]) => key(t, g))),
		)
		return search(
			Arr.flatMap(fresh, ([t, g]) =>
				Arr.flatMap(alphabet, (char) =>
					Arr.flatMap(stepTemplate(t, char), (t2) =>
						Arr.map(stepGlob(g, char), (g2) => [t2, g2] as const),
					),
				),
			),
			next,
		)
	}
	return search([[0, 0]], HashSet.empty())
}

/**
 * Tests if a key pattern fits a key of a template literal key Schema, or
 * `undefined` when the search is not exact for the Schema. The search calls
 * itself one time for each character of a key, so a very long part gives
 * `undefined` too.
 */
const globMeetsKeys = (
	part: string,
	ast: SchemaAST.AST,
): boolean | undefined => {
	if (
		ast._tag !== "TemplateLiteral" ||
		(ast.checks ?? []).length > 0 ||
		part.length > maxExactKeyLength
	) {
		return undefined
	}
	const lists = templateTokens(ast)
	if (lists === undefined) {
		return undefined
	}
	const glob = Arr.map(
		(part.match(/\*+|[^*]/gu) ?? []) as ReadonlyArray<string>,
		(token): GlobToken =>
			token.startsWith("*") ? { _tag: "Star" } : { _tag: "Char", char: token },
	)
	return Arr.some(lists, (list) => tokensMeet(glob, list))
}

/**
 * A few keys that a key Schema of a record takes: each part of a template
 * literal gives its literal, or a short text for a string or a number. These
 * are samples. A key that is not a sample may fit too, so a "no" from a test
 * with them is only "not found".
 */
const sampleKeys = (ast: SchemaAST.AST): ReadonlyArray<string> => {
	switch (ast._tag) {
		case "String":
			return ["", "a"]
		case "Number":
			return ["0", "1"]
		case "Literal":
			return [String(ast.literal)]
		case "Union":
			return Arr.flatMap(ast.types, sampleKeys)
		case "TemplateLiteral":
			// Each key of the parts before, with each key of this part. Two
			// samples for each part keep the list short.
			return Arr.reduce(ast.parts, [""], (keys: ReadonlyArray<string>, part) =>
				Arr.take(
					Arr.flatMap(keys, (key) =>
						Arr.map(Arr.take(sampleKeys(part), 2), (end) => key + end),
					),
					64,
				),
			)
		default:
			return []
	}
}

/**
 * Tests if a Schema surely has a value: each required field, at each depth,
 * has a type that has values, with no checks other than integer and finite
 * checks on numbers. A check such as a minimum length may stop every value,
 * and the library can not see that, so such a Schema gives `false`. So does a
 * required field that holds the struct itself again.
 *
 * @stability stable
 * @category predicates
 * @since 0.5.0
 */
export const hasValue = (schema: Schema.Top): boolean =>
	isSurelyInhabited(schema.ast, new Set())

const isSurelyInhabited = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): boolean => {
	if (
		ast._tag === "Number"
			? !hasOnlyKnownChecks(ast.checks)
			: (ast.checks ?? []).length > 0
	) {
		return false
	}
	switch (ast._tag) {
		case "Never":
			return false
		case "Objects":
			// A named field must fit the record part too, as in
			// `Schema.StructWithRest`, and the two types may share no value. That
			// is not easy to know, so such a struct is not sure.
			return (
				(ast.propertySignatures.length === 0 ||
					ast.indexSignatures.length === 0) &&
				Arr.every(
					ast.propertySignatures,
					(property) =>
						SchemaAST.isOptional(property.type) ||
						isSurelyInhabited(property.type, open),
				)
			)
		case "Union":
			// A union in the mode "oneOf" may stop every value of its members.
			return (
				ast.options?.mode !== "oneOf" &&
				Arr.some(ast.types, (type) => isSurelyInhabited(type, open))
			)
		case "Suspend":
			return (
				!open.has(ast) &&
				isSurelyInhabited(ast.thunk(), new Set([...open, ast]))
			)
		case "Arrays":
			// The elements that a tuple needs, and the elements after its rest.
			// The rest itself may be empty.
			return Arr.every(
				[
					...Arr.filter(
						ast.elements,
						(element) => !SchemaAST.isOptional(element),
					),
					...ast.rest.slice(1),
				],
				(element) => isSurelyInhabited(element, open),
			)
		case "Declaration": {
			const inner = classStruct(ast)
			if (inner !== undefined) {
				return isSurelyInhabited(inner, open)
			}
			const id = declarationId(ast)
			// A value of these holds a value of one of its type parameters.
			if (HashSet.has(wrapperDeclarations, id)) {
				return Arr.some(ast.typeParameters, (type) =>
					isSurelyInhabited(type, open),
				)
			}
			// These have a value for any type parameters, such as an empty map
			// or `Option.none()`. Another declaration may take no value.
			return HashSet.has(inhabitedDeclarations, id)
		}
		case "Enum":
			return ast.enums.length > 0
		case "TemplateLiteral":
			return Arr.every(ast.parts, (part) => isSurelyInhabited(part, open))
		case "String":
		case "Number":
		case "Boolean":
		case "BigInt":
		case "Symbol":
		case "UniqueSymbol":
		case "Literal":
		case "Null":
		case "Undefined":
		case "Void":
		case "Unknown":
		case "Any":
		case "ObjectKeyword":
			return true
		default:
			// A node that this walk does not know may take no value.
			return false
	}
}

/** Declarations of Effect that hold a value of a type parameter. */
const wrapperDeclarations = HashSet.make(
	"effect/schema/Redacted",
	"effect/schema/Result",
)

/** Declarations of Effect that have a value for any type parameters. */
const inhabitedDeclarations = HashSet.make(
	"effect/schema/Date",
	"effect/schema/URL",
	"effect/schema/Uint8Array",
	"effect/schema/Duration",
	"effect/schema/DateTimeUtc",
	"effect/schema/BigDecimal",
	"effect/schema/Cause",
	"effect/schema/Chunk",
	"effect/schema/HashMap",
	"effect/schema/HashSet",
	"effect/schema/ReadonlyMap",
	"effect/schema/ReadonlySet",
	"effect/schema/Option",
	"effect/schema/File",
	"effect/schema/FormData",
	"effect/schema/RegExp",
	"effect/schema/Json",
	"effect/schema/ByteSize",
	"effect/schema/DateTimeZoned",
	"effect/schema/Error",
	"effect/schema/Exit",
	"effect/schema/CauseReason",
	"effect/schema/Graph",
	"effect/schema/SemVer",
	"effect/schema/SemVerRange",
	"effect/schema/TimeZone",
	"effect/schema/TimeZoneNamed",
	"effect/schema/TimeZoneOffset",
	"effect/schema/URLSearchParams",
)

/**
 * Tests if a Schema has no value at all: a required field of it, at some
 * depth, has no value, as `Schema.Never` has none. A required field that
 * holds the struct itself again, with no way to stop, has no finite value
 * either. Other checks, such as a minimum and a maximum that do not meet, are
 * not seen, so a "no" does not prove that the Schema has a value.
 *
 * @stability stable
 * @category predicates
 * @since 0.5.0
 */
export const hasNoValue = (schema: Schema.Top): boolean =>
	isEmptyType(schema.ast, new Set())

const isEmptyType = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): boolean => {
	switch (ast._tag) {
		case "Never":
			return true
		case "Objects":
			return Arr.some(
				ast.propertySignatures,
				(property) =>
					!SchemaAST.isOptional(property.type) &&
					isEmptyType(property.type, open),
			)
		case "Union":
			return Arr.every(ast.types, (type) => isEmptyType(type, open))
		case "Suspend":
			// A walk that comes back to a suspend node on required fields only
			// never stops, so such a value can not be made.
			return open.has(ast) || isEmptyType(ast.thunk(), new Set([...open, ast]))
		case "Declaration": {
			const inner = classStruct(ast)
			return inner !== undefined && isEmptyType(inner, open)
		}
		default:
			return false
	}
}

/**
 * The values that one field of a resource may hold, as a condition sees them.
 * A missing field and `undefined` are `null`. The domain may be larger than
 * the real set of values: Schema checks other than finite and integer checks
 * are left out. A larger domain only makes a check say "no" more often.
 *
 * @stability stable
 * @category models
 * @since 0.5.0
 */
export interface FieldDomain {
	/** The field may be `null` or missing. */
	readonly null: boolean
	/** The field may hold a value with parts, or a value that is not a scalar. */
	readonly object: boolean
	/** The field may hold `true` and `false`. */
	readonly boolean: boolean
	/** The field may hold any string. */
	readonly string: boolean
	/** The numbers that the field may hold. */
	readonly number: "none" | "integer" | "finite" | "any"
	/** Single values that the field may hold, other than the ones above. */
	readonly literals: ReadonlyArray<string | number | boolean>
}

const numberOrder = ["none", "integer", "finite", "any"] as const

const emptyDomain: FieldDomain = {
	null: false,
	object: false,
	boolean: false,
	string: false,
	number: "none",
	literals: [],
}

const nullDomain: FieldDomain = { ...emptyDomain, null: true }

const objectDomain: FieldDomain = { ...emptyDomain, object: true }

/**
 * The domain of a field with no Schema: any value.
 *
 * @stability stable
 * @category constants
 * @since 0.5.0
 */
export const anyDomain: FieldDomain = {
	null: true,
	object: true,
	boolean: true,
	string: true,
	number: "any",
	literals: [],
}

const joinDomains = (domains: ReadonlyArray<FieldDomain>): FieldDomain =>
	domains.reduce(
		(left, right) => ({
			null: left.null || right.null,
			object: left.object || right.object,
			boolean: left.boolean || right.boolean,
			string: left.string || right.string,
			number:
				numberOrder.indexOf(left.number) >= numberOrder.indexOf(right.number)
					? left.number
					: right.number,
			literals: [...left.literals, ...right.literals],
		}),
		emptyDomain,
	)

const hasCheck = (
	checks: ReadonlyArray<SchemaAST.Check<never>>,
	id: string,
): boolean =>
	checks.some(
		(check) =>
			check.annotations?.representation?.id === id ||
			(check._tag === "FilterGroup" && hasCheck(check.checks, id)),
	)

/**
 * The ids of the declarations of Effect that hold only values with parts.
 * Effect puts the id in the `representation` annotation. A declaration that
 * is not in this list may hold a scalar, as `Schema.Json` may.
 */
const objectDeclarations = HashSet.make(
	"effect/schema/Date",
	"effect/schema/URL",
	"effect/schema/Uint8Array",
	"effect/schema/Duration",
	"effect/schema/DateTimeUtc",
	"effect/schema/BigDecimal",
	"effect/schema/Redacted",
	"effect/schema/Cause",
	"effect/schema/Chunk",
	"effect/schema/HashMap",
	"effect/schema/HashSet",
	"effect/schema/ReadonlyMap",
	"effect/schema/ReadonlySet",
	"effect/schema/Option",
	"effect/schema/Result",
	"effect/schema/File",
	"effect/schema/FormData",
	"effect/schema/RegExp",
)

const declarationId = (ast: SchemaAST.Declaration): string | undefined => {
	const representation: unknown = ast.annotations?.["representation"]
	return hasProperty(representation, "id") &&
		typeof representation.id === "string"
		? representation.id
		: undefined
}

/** The domain of the values of a Schema node. */
const domainOfType = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): FieldDomain => {
	switch (ast._tag) {
		case "Null":
		case "Undefined":
			return nullDomain
		case "Never":
			return emptyDomain
		// `Schema.Void` takes any value, as `Schema.Unknown` does.
		case "Void":
		case "Unknown":
		case "Any":
			return anyDomain
		case "String":
		case "TemplateLiteral":
			return { ...emptyDomain, string: true }
		case "Number": {
			const checks = ast.checks ?? []
			return {
				...emptyDomain,
				number: hasCheck(checks, "effect/schema/isInt")
					? "integer"
					: hasCheck(checks, "effect/schema/isFinite")
						? "finite"
						: "any",
			}
		}
		case "Boolean":
			return { ...emptyDomain, boolean: true }
		case "Literal":
			return typeof ast.literal === "bigint"
				? objectDomain
				: { ...emptyDomain, literals: [ast.literal] }
		case "Enum":
			return { ...emptyDomain, literals: ast.enums.map(([, value]) => value) }
		case "Union":
			return joinDomains(ast.types.map((type) => domainOfType(type, open)))
		case "Suspend":
			return open.has(ast)
				? anyDomain
				: domainOfType(ast.thunk(), new Set([...open, ast]))
		case "Objects":
			// A struct with no fields holds any value: Effect's
			// `Schema.Struct({})` takes a string too.
			return ast.propertySignatures.length === 0 &&
				ast.indexSignatures.length === 0
				? anyDomain
				: objectDomain
		case "Declaration":
			// A class, and a declaration of Effect in `objectDeclarations`, holds
			// a value with parts. Another declaration may hold any value, as
			// `Schema.Json` or one from `Schema.declare` may, so its domain is all
			// values: a smaller domain could hide a value that a deny rule names.
			return classStruct(ast) !== undefined ||
				HashSet.has(objectDeclarations, declarationId(ast))
				? objectDomain
				: anyDomain
		default:
			return objectDomain
	}
}

const domainAt = (
	ast: SchemaAST.AST,
	names: ReadonlyArray<string>,
	index: number,
	memo: PathMemo<FieldDomain>,
): FieldDomain =>
	// A walk that comes back to a node at the same place may hold any value.
	rememberAt(memo, ast, index, anyDomain, () => {
		if (index === names.length) {
			return domainOfType(ast, new Set())
		}
		const name = names[index]!
		switch (ast._tag) {
			case "Objects": {
				const property = ast.propertySignatures.find(
					(signature) => signature.name === name,
				)
				if (property !== undefined) {
					const inner = domainAt(property.type, names, index + 1, memo)
					// A field that may be missing may be `null`. So may a field with
					// a name of `Object.prototype`: a condition reads it only when a
					// value gives it another value.
					return SchemaAST.isOptional(property.type) || name in Object.prototype
						? joinDomains([nullDomain, inner])
						: inner
				}
				// A name that the struct does not have may still be a field of a
				// value: a condition reads a field that a value has from its
				// class, such as a getter, and the Schema does not stop such a
				// field. A key of a record is not safe either: the Schema of a
				// record checks only the keys that a loop over the keys sees, and
				// a condition reads the others too. So such a field may hold any
				// value.
				return anyDomain
			}
			case "Union":
				return joinDomains(
					ast.types.map((type) => domainAt(type, names, index, memo)),
				)
			case "Suspend":
				return domainAt(ast.thunk(), names, index, memo)
			case "Declaration": {
				const inner = classStruct(ast)
				return inner === undefined
					? anyDomain
					: domainAt(inner, names, index, memo)
			}
			case "Arrays":
			case "ObjectKeyword":
			case "Unknown":
			case "Any":
				// A path may go into these values, and the Schema does not say
				// what is there.
				return anyDomain
			default:
				// A path does not go into a scalar, so the field is `null`.
				return nullDomain
		}
	})

/**
 * Gives the domain of a field of a Schema, by its path with dots. A path that
 * the Schema does not name gives `null`, as a condition reads such a field.
 *
 * @stability stable
 * @category getters
 * @since 0.5.0
 */
export const domainOf = (schema: Schema.Top, path: string): FieldDomain =>
	// No cache here: a search keeps the cells of each field for itself. A path
	// that is too long to walk may hold any value.
	isTooLong(path)
		? anyDomain
		: domainAt(schema.ast, path.split("."), 0, new Map())

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
	const visits = walkFields(Schema.Struct(options.fields).ast)
	const leaves = Arr.filter(visits, (visit) => visit.leaf)
	// In a union, one path may hold a scalar in one branch and a struct in
	// another. Such a path holds more than one value, so it is open too.
	const structs = HashSet.fromIterable(
		Arr.map(
			Arr.filter(visits, (visit) => !visit.leaf),
			(visit) => visit.path,
		),
	)
	const open = Arr.filter(
		leaves,
		(visit) =>
			shapeOf(visit.type) !== "scalar" || HashSet.has(structs, visit.path),
	)
	return new ResourceDescriptor({
		kind,
		actions: [...options.actions],
		path:
			options.path === undefined
				? undefined
				: checkPath(kind, options.fields, options.path(refs)),
		fieldPaths: Arr.dedupe(Arr.map(leaves, (visit) => visit.path)),
		openPaths: Arr.dedupe(Arr.map(open, (visit) => visit.path)),
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
 * @since 0.4.0
 */
export const kindOf = (value: unknown): string | undefined =>
	hasProperty(value, "_tag") && typeof value._tag === "string"
		? value._tag
		: undefined
