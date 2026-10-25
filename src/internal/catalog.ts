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
import * as Trampoline from "./trampoline.ts"

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
	// A native `Set` finds copies about ten times as fast as `Arr.dedupe`. It
	// takes `0` and `-0` as one, as `includes` does when a test reads them.
	literals: Array.from(new Set([...left.literals, ...right.literals])),
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
	 * A struct of a union without the field makes it not plain too, since a
	 * value made by hand may have it with any value.
	 */
	readonly plain: boolean
}

/**
 * A place in the graph of a catalog. A path of a field leads to a place, and
 * many paths may lead to one place, as in a recursive Schema: `next` and
 * `next.next` of a list of links are one place. A place keeps the ids of the
 * places below it, so the graph has no loop of objects.
 */
export interface Branch {
	readonly id: number
	/** The kinds of the values of the field at this place. */
	readonly kinds: Kinds
	/** The field holds a scalar, a record or a list: see `Field.listed`. */
	readonly values: boolean
	/** The field may hold a struct. */
	readonly structs: boolean
	readonly open: boolean
	readonly plain: boolean
	/** The ids of the places below, by name, in the order of the Schema. */
	readonly children: ReadonlyArray<readonly [string, number]>
	/**
	 * The places below, by name. A lookup gets each name from `split`, as a
	 * new string, and a `HashMap` finds a new string about 20% faster than a
	 * native `Map`. The names come from the Schema, so a name from a policy
	 * can not make a long list of names with one hash here.
	 */
	readonly names: HashMap.HashMap<string, number>
	/** The place for the keys of a record, when the value may be a record. */
	readonly key: Key | undefined
	readonly keyBranch: number | undefined
}

/** The catalog of the fields of a Schema. */
export interface Catalog {
	/**
	 * The fields that a list shows, a field before the fields below it. For a
	 * recursive Schema, the list goes into each recursive place one time on
	 * each path, so it is finite.
	 */
	readonly fields: ReadonlyArray<Field>
	/** The places, by id. The root is the place with the id 0. */
	readonly branches: ReadonlyArray<Branch>
	/**
	 * The number of steps from a place to a place below it. A search of the
	 * catalog, as for a field pattern, reads each one, so this is its work.
	 */
	readonly edges: number
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
): ReadonlyArray<SchemaAST.AST> => alternativesOf({ ast, open })

/**
 * The walk of {@link alternatives}. A union may hold a union, very many
 * levels down, so it is a walk of the trampoline for an input of an unknown
 * depth.
 */
const alternativesOf = Trampoline.adaptive<
	{ readonly ast: SchemaAST.AST; readonly open: ReadonlySet<SchemaAST.AST> },
	ReadonlyArray<SchemaAST.AST>
>((R, child) => ({ ast, open }, depth) => {
	switch (ast._tag) {
		case "Union":
			return R.map(
				R.forEach(ast.types, (type) => child({ ast: type, open }, depth + 1)),
				Arr.flatten,
			)
		case "Suspend":
			return open.has(ast)
				? R.succeed([])
				: child({ ast: ast.thunk(), open: new Set([...open, ast]) }, depth + 1)
		default:
			return R.succeed([ast])
	}
})

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

/** The things that the walk of a catalog knows at one place. */
interface Place {
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

/**
 * The properties of a struct by name. A walk makes it one time for each
 * struct of a place, so a struct with very many fields does not take a
 * search for each name. It is a native `Map`, as `Branch.names` is.
 */
const propertiesOf = (
	struct: SchemaAST.Objects,
): ReadonlyMap<string, SchemaAST.PropertySignature> =>
	new Map(
		Arr.flatMap(struct.propertySignatures, (signature) => {
			const name = nameOf(signature)
			return name === undefined ? [] : [[name, signature] as const]
		}),
	)

/** The names of the fields of the structs, in the order that they first come. */
const namesOf = (
	structs: ReadonlyArray<SchemaAST.Objects>,
): ReadonlyArray<string> =>
	// A native `Set` keeps the first copy of each name, in order, about ten
	// times as fast as `Arr.dedupe`.
	Array.from(
		new Set(
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
		),
	)

/** A place of the walk, and the places below it, before they have ids. */
interface Made {
	readonly branch: Omit<Branch, "id" | "children" | "names" | "keyBranch">
	readonly children: ReadonlyArray<readonly [string, Place]>
	readonly keyPlace: Place | undefined
}

/** Works out the facts of a place, and the places below it. */
const placeOf = (place: Place): Made => {
	const structs = Arr.filter(Arr.map(place.schemas, structOf), isStruct)
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
	const structProperties = Arr.map(structs, propertiesOf)
	const children = Arr.map(namesOf(structs), (name) => {
		const properties = Arr.flatMap(structProperties, (named) => {
			const property = named.get(name)
			return property === undefined ? [] : [property]
		})
		// A struct without the name may still have it as an extra field, with
		// any value: only a decode or a `make` takes extra fields away, and a
		// decision may get a value made by hand. A value that may be any
		// object, as one of `Schema.Unknown` may, may have the name with any
		// value too.
		const top =
			place.top || valueKinds.object || properties.length < structs.length
		const below: Place = {
			schemas: Arr.flatMap(properties, (property) =>
				alternatives(property.type, new Set()),
			),
			// A field below a value that is not a struct reads `null`, and so
			// does a field that may be missing.
			missing:
				place.missing ||
				values.length > 0 ||
				Arr.some(properties, (property) => SchemaAST.isOptional(property.type)),
			top,
			// A value that may be anything may be a list, or have a getter, so
			// a read below it may not find plain data.
			plain: place.plain && !top,
		}
		return [name, below] as const
	})
	const signatures = Arr.flatMap(records, (struct) => struct.indexSignatures)
	const keyTop =
		place.top || valueKinds.object || records.length < structs.length
	return {
		branch: {
			kinds,
			values: values.length > 0 || records.length > 0,
			structs: structs.length > 0,
			// A field that is a scalar in one branch of a union and a struct in
			// another holds parts too.
			open:
				records.length > 0 ||
				structs.length > 0 ||
				valueKinds.object ||
				place.top,
			plain: place.plain,
			key:
				signatures.length === 0
					? undefined
					: {
							_tag: "Key",
							parameters: Arr.map(
								signatures,
								(signature) => signature.parameter,
							),
						},
		},
		children,
		keyPlace:
			signatures.length === 0
				? undefined
				: {
						schemas: Arr.flatMap(signatures, (signature) =>
							alternatives(signature.type, new Set()),
						),
						// A record may not have a given key.
						missing: true,
						top: keyTop,
						plain: place.plain && !keyTop,
					},
	}
}

/**
 * Makes the places of a Schema. Each place comes one time: two paths with the
 * same Schemas and the same marks lead to one place. The walk keeps a queue
 * of the places that it has found, and it makes them in order, so a deep
 * Schema does not fill the stack.
 */
const branchesOf = (root: Place): ReadonlyArray<Branch> => {
	// The id of each Schema node, and of each place, for this walk. The ids
	// are in native maps, because the walk must find a Schema node by the node
	// itself: `Equal` compares Schema nodes by structure, and a recursive
	// Schema has no end. The maps and the queue belong to this walk.
	const astIds = new Map<SchemaAST.AST, number>()
	const placeIds = new Map<string, number>()
	const queue: Array<Place> = []
	const idOf = (place: Place): number => {
		const ids = Arr.map(place.schemas, (schema) => {
			const known = astIds.get(schema)
			if (known !== undefined) {
				return known
			}
			astIds.set(schema, astIds.size)
			return astIds.size - 1
		})
		const key = `${Array.from(new Set(ids))
			.sort((a, b) => a - b)
			.join(
				",",
			)}|${String(place.missing)}|${String(place.top)}|${String(place.plain)}`
		const known = placeIds.get(key)
		if (known !== undefined) {
			return known
		}
		if (queue.length >= Limits.ceilings.catalogFields) {
			throw Limits.exceeded(
				"A Schema",
				"catalogFields",
				"places",
				queue.length + 1,
				Limits.ceilings.catalogFields,
			)
		}
		placeIds.set(key, queue.length)
		queue.push(place)
		return queue.length - 1
	}
	idOf(root)
	return Arr.unfold(0, (id) => {
		const place = queue[id]
		if (place === undefined) {
			return Option.none()
		}
		const made = placeOf(place)
		const children = Arr.map(
			made.children,
			([name, below]) => [name, idOf(below)] as const,
		)
		const branch: Branch = {
			...made.branch,
			id,
			children,
			names: HashMap.fromIterable(children),
			keyBranch: made.keyPlace === undefined ? undefined : idOf(made.keyPlace),
		}
		return Option.some([branch, id + 1] as const)
	})
}

/** The field at a place, for a path. */
const fieldAt = (
	branch: Branch,
	path: ReadonlyArray<Segment>,
	parts: number,
): Field => ({
	path,
	text: textOf(path),
	kinds: branch.kinds,
	// A struct at the last part that a path may have is one field, since a
	// path does not go below it.
	listed: branch.values || (path.length === parts && branch.structs),
	open: branch.open,
	plain: branch.plain,
})

/**
 * The fields that a list shows, a field before the fields below it, down to
 * `parts` parts. A path goes into a place that is on it already one time
 * only, so the list of a recursive Schema is finite. The walk keeps a stack
 * of the places to visit, so a deep Schema does not fill the stack. The
 * stack belongs to this walk.
 */
const listOf = (
	branches: ReadonlyArray<Branch>,
	parts: number,
): ReadonlyArray<Field> => {
	interface Visit {
		readonly branch: Branch
		readonly path: ReadonlyArray<Segment>
		/** The ids of the places on the path, as a set of Effect that shares its parts. */
		readonly above: HashSet.HashSet<number>
	}
	const below = (visit: Visit): ReadonlyArray<Visit> => {
		const { branch, path } = visit
		if (
			path.length === parts ||
			(path.length > 0 && HashSet.has(visit.above, branch.id))
		) {
			return []
		}
		const above = HashSet.add(visit.above, branch.id)
		const named = Arr.map(branch.children, ([name, id]) => ({
			branch: branches[id]!,
			path: [...path, name],
			above,
		}))
		return branch.key === undefined || branch.keyBranch === undefined
			? named
			: [
					...named,
					{
						branch: branches[branch.keyBranch]!,
						path: [...path, branch.key],
						above,
					},
				]
	}
	const stack: Array<Visit> = [
		{ branch: branches[0]!, path: [], above: HashSet.empty() },
	]
	return Arr.flatten(
		Arr.unfold(stack, (rest) => {
			const visit = rest.pop()
			if (visit === undefined) {
				return Option.none()
			}
			// The visits go onto the stack one at a time: a spread into a call
			// would pass one argument for each field, past the most arguments
			// of a call.
			Arr.forEach(Arr.reverse(below(visit)), (next) => {
				rest.push(next)
			})
			const field =
				visit.path.length === 0
					? []
					: [fieldAt(visit.branch, visit.path, parts)]
			if (field.length > 0 && rest.length + 1 > Limits.ceilings.catalogFields) {
				throw Limits.exceeded(
					"A Schema",
					"catalogFields",
					"fields",
					rest.length + 1,
					Limits.ceilings.catalogFields,
				)
			}
			return Option.some([field, rest] as const)
		}),
	)
}

/**
 * The fields that a list shows for paths of at most `parts` parts, as for a
 * domain with that limit. See `Catalog.fields`.
 */
export const fieldsOf = (
	catalog: Catalog,
	parts: number,
): ReadonlyArray<Field> =>
	parts === Limits.fieldPathParts
		? catalog.fields
		: listOf(catalog.branches, parts)

/**
 * Makes the catalog of a Schema, with the list of its fields for the default
 * limit of the parts of a path. It throws when a field name has a dot or is
 * empty, and when the Schema has more places or fields than the ceiling of
 * `catalogFields`. A domain checks the size of the list with its own limit.
 */
export const catalogOf = (ast: SchemaAST.AST): Catalog => {
	const branches = branchesOf({
		schemas: alternatives(ast, new Set()),
		missing: false,
		top: false,
		plain: true,
	})
	return {
		fields: listOf(branches, Limits.fieldPathParts),
		branches,
		edges: Arr.reduce(
			branches,
			0,
			(total, branch) =>
				total +
				branch.children.length +
				(branch.keyBranch === undefined ? 0 : 1),
		),
		root: branches[0]!,
	}
}

/**
 * Gives the field of a catalog at a path with dots, if the catalog has it.
 * A path has at most `parts` parts. The lookup follows one place for each
 * part, in a loop.
 */
export const lookup = (
	catalog: Catalog,
	path: string,
	parts: number = Limits.fieldPathParts,
): Field | undefined => {
	const names = path.split(".", parts + 1)
	if (names.length > parts) {
		return undefined
	}
	const found = Arr.reduce(
		names,
		{ branch: catalog.root, path: [] } as
			| { readonly branch: Branch; readonly path: ReadonlyArray<Segment> }
			| undefined,
		(current, name) => {
			if (current === undefined) {
				return undefined
			}
			const named = HashMap.get(current.branch.names, name)
			if (Option.isSome(named)) {
				return {
					branch: catalog.branches[named.value]!,
					path: [...current.path, name],
				}
			}
			const key = current.branch.key
			const keyBranch = current.branch.keyBranch
			return key !== undefined && keyBranch !== undefined && keyFits(key, name)
				? { branch: catalog.branches[keyBranch]!, path: [...current.path, key] }
				: undefined
		},
	)
	return found === undefined
		? undefined
		: fieldAt(found.branch, found.path, parts)
}
