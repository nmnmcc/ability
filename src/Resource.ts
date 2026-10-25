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
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import { hasProperty } from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as SchemaAST from "effect/SchemaAST"
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
	/** The paths of the data fields, with dots for nested fields. */
	readonly fieldPaths: ReadonlyArray<string>
	/**
	 * The paths in {@link fieldPaths} of fields that hold more than one value,
	 * such as a record, a map or an array. The parts of such a field are not
	 * in `fieldPaths`, but a rule may name them.
	 */
	readonly openPaths: ReadonlyArray<string>
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
 * The most parts that a field path may have. The walks below call themselves
 * for each part, and a path comes from the input of a policy. So a very long
 * path, as in a recursive Schema, could fill the stack.
 */
const maxPathParts = 256

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
 * @since 1.0.0
 */
export const fieldPaths = (schema: Schema.Top): ReadonlyArray<string> =>
	Arr.dedupe(Arr.map(walkFields(schema.ast), (visit) => visit.path))

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
 * @since 1.0.0
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
	const visits = walkFields(struct.ast)
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
