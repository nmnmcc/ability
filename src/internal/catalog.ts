/**
 * The catalog of the fields of a Schema. One walk over the Schema makes it,
 * and every question about the fields of a resource or of the principal reads
 * it: which names a rule may use, which values a field may hold, which fields
 * a pattern fits, and which fields a list of permitted fields shows.
 *
 * The catalog describes the shape of the values, not the checks of the
 * Schema. A check, such as a minimum length, only keeps some values out, so a
 * catalog that leaves the checks out holds every real value and more. An
 * answer that holds for all of these values, as `All` and `None` of a
 * coverage do, then holds for the real values too.
 */
import * as Arr from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
import * as Limits from "./limits.ts"

/** The kinds of values that a field may hold. */
export interface Kinds {
	/** The field may be `null`, `undefined` or missing. */
	readonly null: boolean
	readonly boolean: boolean
	/** The field may hold any string. */
	readonly string: boolean
	/** The numbers that the field may hold. */
	readonly number: "none" | "integer" | "finite" | "any"
	/** The field may hold an object, or a value that is not a scalar. */
	readonly object: boolean
	/** Single values that the field may hold, other than the ones above. */
	readonly literals: ReadonlyArray<string | number | boolean>
}

/** No value: the kinds of a field of `Schema.Never`. */
export const noKinds: Kinds = {
	null: false,
	boolean: false,
	string: false,
	number: "none",
	object: false,
	literals: [],
}

/** Any value. */
export const anyKinds: Kinds = {
	null: true,
	boolean: true,
	string: true,
	number: "any",
	object: true,
	literals: [],
}

const nullKinds: Kinds = { ...noKinds, null: true }
const objectKinds: Kinds = { ...noKinds, object: true }

const numberOrder = ["none", "integer", "finite", "any"] as const

/** The kinds of a field that may hold a value of `left` or of `right`. */
export const joinKinds = (left: Kinds, right: Kinds): Kinds => ({
	null: left.null || right.null,
	boolean: left.boolean || right.boolean,
	string: left.string || right.string,
	number:
		numberOrder.indexOf(left.number) >= numberOrder.indexOf(right.number)
			? left.number
			: right.number,
	object: left.object || right.object,
	literals: Arr.dedupe([...left.literals, ...right.literals]),
})

/** Tests if a number fits the numbers of a field. */
export const fitsNumber = (number: Kinds["number"], value: number): boolean => {
	switch (number) {
		case "none":
			return false
		case "integer":
			return Number.isInteger(value)
		case "finite":
			return Number.isFinite(value)
		case "any":
			return true
	}
}

/**
 * Tests if a field with these kinds may hold a value. A missing value and
 * `undefined` are `null`.
 */
export const accepts = (kinds: Kinds, value: unknown): boolean => {
	if (value === null || value === undefined) {
		return kinds.null
	}
	switch (typeof value) {
		case "boolean":
			return kinds.boolean || kinds.literals.includes(value)
		case "string":
			return kinds.string || kinds.literals.includes(value)
		case "number":
			return fitsNumber(kinds.number, value) || kinds.literals.includes(value)
		default:
			return kinds.object
	}
}

/** A part of a field path that stands for any key of a record. */
export interface Key {
	readonly _tag: "Key"
	/** The Schemas of the keys. A key must fit one of them. */
	readonly parameters: ReadonlyArray<SchemaAST.AST>
}

/** One part of a field path: a name, or any key of a record. */
export type Segment = string | Key

/** One field of a catalog. */
export interface Field {
	readonly path: ReadonlyArray<Segment>
	/** The path with dots, and `*` for a key of a record. */
	readonly text: string
	readonly kinds: Kinds
	/**
	 * The field holds a value that a list of fields shows as one field: a
	 * scalar, a record, an array, or a struct at the last part a path may have.
	 */
	readonly listed: boolean
	/** The field may hold parts that the Schema does not name, as a record may. */
	readonly open: boolean
	/**
	 * A read of the field finds only plain data. It is `false` when a value
	 * above the field may be an object that does not have it as a data field:
	 * a class without the field, which may have a getter of that name, a
	 * value such as a date or a list, or any object, as of `Schema.Unknown`.
	 * A decode or a `make` copies a struct or a record into a plain object,
	 * so a struct without the field gives `null` for it.
	 */
	readonly plain: boolean
}

/** A place in the tree of a catalog, with the places below it. */
export interface Branch {
	/** The field at this place. The root has none. */
	readonly field: Field | undefined
	/** The places below, by name, in the order of the Schema. */
	readonly children: ReadonlyArray<readonly [string, Branch]>
	readonly names: HashMap.HashMap<string, Branch>
	/** The place for the keys of a record, when the value may be a record. */
	readonly key: Key | undefined
	readonly keyBranch: Branch | undefined
}

/** The catalog of the fields of a Schema. */
export interface Catalog {
	/** Every field, a field before the fields below it. */
	readonly fields: ReadonlyArray<Field>
	readonly root: Branch
}

/**
 * Tests if a key of an object fits the Schemas of the keys of a record. A key
 * of an object is a string, also a key that a number Schema takes: `{ 1: "a" }`
 * has the key `"1"`. So a key that is the text of a number is tried as that
 * number too.
 */
export const keyFits = (key: Key, name: string): boolean =>
	Arr.some(key.parameters, (parameter) => {
		const is = Schema.is(Schema.make(parameter))
		return (
			is(name) ||
			(name !== "" && String(Number(name)) === name && is(Number(name)))
		)
	})

/**
 * Gives the struct of a `Schema.Class`. A class is a declaration with one
 * struct as its type parameter, and Effect marks it with a `"~constructor"`
 * annotation, also through more codec steps, as in
 * `Schema.fromJsonString(User)`. Other declarations, such as `Schema.Option`
 * or `Schema.ReadonlyMap`, have no such mark, and the fields of their type
 * parameter are not fields of the value.
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
 * Gives the Schemas that a value at one place may fit: it opens unions and
 * `Schema.suspend`. A class stays a class: see {@link structOf}. The open suspend nodes are in a native `Set`,
 * because the walk must find a node by the node itself: `Equal` compares
 * Schema nodes by structure, and a recursive Schema has no end. A suspend
 * node that gives itself again, with no step on the path, gives nothing.
 */
const alternatives = (
	ast: SchemaAST.AST,
	open: ReadonlySet<SchemaAST.AST>,
): ReadonlyArray<SchemaAST.AST> => {
	switch (ast._tag) {
		case "Union":
			return Arr.flatMap(ast.types, (type) => alternatives(type, open))
		case "Suspend":
			return open.has(ast)
				? []
				: alternatives(ast.thunk(), new Set([...open, ast]))
		default:
			return [ast]
	}
}

/** The struct of a Schema: a struct, or the struct of a class. */
const structOf = (ast: SchemaAST.AST): SchemaAST.Objects | undefined =>
	ast._tag === "Objects"
		? ast
		: ast._tag === "Declaration"
			? classStruct(ast)
			: undefined

const hasCheck = (
	checks: ReadonlyArray<SchemaAST.Check<never>>,
	id: string,
): boolean =>
	Arr.some(
		checks,
		(check) =>
			check.annotations?.representation?.id === id ||
			(check._tag === "FilterGroup" && hasCheck(check.checks, id)),
	)

/** A struct with named fields, or with the keys of a record. */
const isStruct = (
	ast: SchemaAST.Objects | undefined,
): ast is SchemaAST.Objects =>
	ast !== undefined &&
	(ast.propertySignatures.length > 0 || ast.indexSignatures.length > 0)

/** The kinds of the values of a Schema that is not a struct. */
const kindsOf = (ast: SchemaAST.AST): Kinds => {
	switch (ast._tag) {
		case "Null":
		case "Undefined":
			return nullKinds
		case "Never":
			return noKinds
		case "String":
		case "TemplateLiteral":
			return { ...noKinds, string: true }
		case "Boolean":
			return { ...noKinds, boolean: true }
		case "Number": {
			// The two checks that a search uses. Effect names a number with
			// them, as `Schema.Int` and `Schema.Finite`; other checks are left
			// out, as all checks are.
			const checks = ast.checks ?? []
			return {
				...noKinds,
				number: hasCheck(checks, "effect/schema/isInt")
					? "integer"
					: hasCheck(checks, "effect/schema/isFinite")
						? "finite"
						: "any",
			}
		}
		case "Literal":
			return typeof ast.literal === "bigint"
				? objectKinds
				: { ...noKinds, literals: [ast.literal] }
		case "Enum":
			return { ...noKinds, literals: Arr.map(ast.enums, ([, value]) => value) }
		case "Arrays":
		case "ObjectKeyword":
		case "BigInt":
		case "Symbol":
		case "UniqueSymbol":
			return objectKinds
		case "Declaration":
			// A declaration of Effect in `objectDeclarations` holds an object,
			// such as a `Date`. Another declaration may hold any value, as
			// `Schema.Json` or one from `Schema.declare` may.
			return HashSet.has(objectDeclarations, declarationId(ast))
				? objectKinds
				: anyKinds
		default:
			// `Schema.Unknown`, `Schema.Void`, and `Struct({})`, which takes a
			// string too: these may hold any value.
			return anyKinds
	}
}

/**
 * The ids of the declarations of Effect that hold only objects. Effect puts
 * the id in the `representation` annotation. A declaration that is not in
 * this list may hold a scalar, as `Schema.Json` may, so its kinds are any
 * value.
 */
const objectDeclarations = HashSet.make(
	"effect/schema/Date",
	"effect/schema/URL",
	"effect/schema/Uint8Array",
	"effect/schema/Duration",
	"effect/schema/DateTimeUtc",
	"effect/schema/DateTimeZoned",
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
	"effect/schema/Exit",
	"effect/schema/File",
	"effect/schema/FormData",
	"effect/schema/RegExp",
	"effect/schema/URLSearchParams",
)

const declarationId = (ast: SchemaAST.Declaration): string | undefined => {
	const representation: unknown = ast.annotations?.["representation"]
	return hasProperty(representation, "id") &&
		typeof representation.id === "string"
		? representation.id
		: undefined
}

/** The things that a walk of the catalog knows at one place. */
interface Place {
	readonly path: ReadonlyArray<Segment>
	readonly schemas: ReadonlyArray<SchemaAST.AST>
	/** The value may be missing. */
	readonly missing: boolean
	/** The value may be anything, as an extra field of a struct may be. */
	readonly top: boolean
	/** A read here finds only plain data: see {@link Field.plain}. */
	readonly plain: boolean
}

const textOf = (path: ReadonlyArray<Segment>): string =>
	Arr.map(path, (segment) =>
		typeof segment === "string" ? segment : "*",
	).join(".")

/**
 * The name of a property as a part of a path. A key of an object is a string,
 * so a number key, as from `Schema.Record(Schema.Literal(1), ...)`, has the
 * name `"1"`. A symbol key is not a field.
 */
const nameOf = (signature: SchemaAST.PropertySignature): string | undefined =>
	typeof signature.name === "symbol" ? undefined : String(signature.name)

/** Gives the property of a struct with a name, if it has one. */
const propertyOf = (
	struct: SchemaAST.Objects,
	name: string,
): SchemaAST.PropertySignature | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(
			struct.propertySignatures,
			(signature) => nameOf(signature) === name,
		),
	)

/** The names of the fields of the structs, in the order that they first come. */
const namesOf = (
	structs: ReadonlyArray<SchemaAST.Objects>,
): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(structs, (struct) =>
			Arr.flatMap(struct.propertySignatures, (signature) => {
				const name = nameOf(signature)
				if (name === undefined) {
					return []
				}
				// A dot in a path is the step into a nested field. A field name with
				// a dot would make two fields have one path, so it is a defect.
				if (name.includes(".")) {
					throw new Error(`A field name may not have a dot: "${name}"`)
				}
				// An empty name would make an empty part in a path, such as
				// `.secret`.
				if (name === "") {
					throw new Error("A field name may not be empty")
				}
				return [name]
			}),
		),
	)

/**
 * Makes the branch of a place, with the branches below it. `count` is the
 * number of fields so far. It belongs to one walk, and it stops a Schema with
 * very many fields before the walk is done.
 */
const branchOf = (place: Place, count: { size: number }): Branch => {
	const structs = Arr.filter(Arr.map(place.schemas, structOf), isStruct)
	// The structs of classes. A value of a class is not copied into a plain
	// object, so it keeps its getters and methods.
	const classes = Arr.filter(
		Arr.map(
			Arr.filter(place.schemas, (schema) => schema._tag === "Declaration"),
			structOf,
		),
		isStruct,
	)
	const values = Arr.filter(
		place.schemas,
		(schema) => !isStruct(structOf(schema)),
	)
	const valueKinds = Arr.reduce(values, noKinds, (kinds, schema) =>
		joinKinds(kinds, kindsOf(structOf(schema) ?? schema)),
	)
	const kinds = place.top
		? anyKinds
		: joinKinds(
				joinKinds(valueKinds, structs.length > 0 ? objectKinds : noKinds),
				place.missing ? nullKinds : noKinds,
			)
	const records = Arr.filter(
		structs,
		(struct) => struct.indexSignatures.length > 0,
	)
	// The last part that a path may have: the walk does not go below it.
	const last = place.path.length === Limits.fieldPathParts
	const field: Field | undefined =
		place.path.length === 0
			? undefined
			: {
					path: place.path,
					text: textOf(place.path),
					kinds,
					listed:
						values.length > 0 ||
						records.length > 0 ||
						(last && structs.length > 0),
					// A field that is a scalar in one branch of a union and a struct
					// in another holds parts too.
					open:
						records.length > 0 ||
						structs.length > 0 ||
						valueKinds.object ||
						place.top,
					plain: place.plain,
				}
	if (field !== undefined) {
		count.size += 1
		if (count.size > Limits.catalogFields) {
			throw Limits.exceeded(
				"A Schema",
				"catalogFields",
				"fields",
				count.size,
				Limits.catalogFields,
			)
		}
	}
	if (last) {
		return {
			field,
			children: [],
			names: HashMap.empty(),
			key: undefined,
			keyBranch: undefined,
		}
	}
	const children = Arr.map(namesOf(structs), (name) => {
		const properties = Arr.flatMap(structs, (struct) => {
			const property = propertyOf(struct, name)
			return property === undefined ? [] : [property]
		})
		const below: Place = {
			path: [...place.path, name],
			schemas: Arr.flatMap(properties, (property) =>
				alternatives(property.type, new Set()),
			),
			// A field below a value that is not a struct reads `null`, and so
			// does a field that may be missing.
			missing:
				place.missing ||
				values.length > 0 ||
				Arr.some(properties, (property) => SchemaAST.isOptional(property.type)),
			// A struct without the name may still have it as an extra field,
			// with any value: only a decode takes extra fields away. A value
			// that may be any object, as one of `Schema.Unknown` may, may have
			// the name with any value too.
			top:
				place.top ||
				valueKinds.object ||
				Arr.some(structs, (struct) => propertyOf(struct, name) === undefined),
			plain:
				place.plain &&
				!valueKinds.object &&
				Arr.every(classes, (struct) => propertyOf(struct, name) !== undefined),
		}
		return [name, branchOf(below, count)] as const
	})
	const names = HashMap.fromIterable(children)
	const signatures = Arr.flatMap(records, (struct) => struct.indexSignatures)
	if (signatures.length === 0) {
		return { field, children, names, key: undefined, keyBranch: undefined }
	}
	const key: Key = {
		_tag: "Key",
		parameters: Arr.map(signatures, (signature) => signature.parameter),
	}
	const keyBranch = branchOf(
		{
			path: [...place.path, key],
			schemas: Arr.flatMap(signatures, (signature) =>
				alternatives(signature.type, new Set()),
			),
			// A record may not have a given key.
			missing: true,
			top: place.top || valueKinds.object || records.length < structs.length,
			plain:
				place.plain &&
				!valueKinds.object &&
				Arr.every(classes, (struct) => struct.indexSignatures.length > 0),
		},
		count,
	)
	return { field, children, names, key, keyBranch }
}

const fieldsOf = (branch: Branch): ReadonlyArray<Field> => [
	...(branch.field === undefined ? [] : [branch.field]),
	...Arr.flatMap(branch.children, ([, child]) => fieldsOf(child)),
	...(branch.keyBranch === undefined ? [] : fieldsOf(branch.keyBranch)),
]

/**
 * Makes the catalog of a Schema. It throws when a field name has a dot or is
 * empty, and when the Schema has more fields than `catalogFields`.
 */
export const catalogOf = (ast: SchemaAST.AST): Catalog => {
	const root = branchOf(
		{
			path: [],
			schemas: alternatives(ast, new Set()),
			missing: false,
			top: false,
			plain: true,
		},
		{ size: 0 },
	)
	return { fields: fieldsOf(root), root }
}

/** Gives the field of a catalog at a path with dots, if the catalog has it. */
export const lookup = (catalog: Catalog, path: string): Field | undefined => {
	const names = path.split(".", Limits.fieldPathParts + 1)
	if (names.length > Limits.fieldPathParts) {
		return undefined
	}
	const branch = Arr.reduce(
		names,
		catalog.root as Branch | undefined,
		(current, name) => {
			if (current === undefined) {
				return undefined
			}
			const named = HashMap.get(current.names, name)
			if (Option.isSome(named)) {
				return named.value
			}
			return current.key !== undefined && keyFits(current.key, name)
				? current.keyBranch
				: undefined
		},
	)
	return branch?.field
}
