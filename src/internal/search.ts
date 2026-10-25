/**
 * The search for a value that makes a condition true. Each test of a
 * condition compares one field with constants, so the constants cut the
 * values of each field into a few cells, and every test gives the same answer
 * for all the values of one cell. The search tries one value from each cell,
 * one field at a time.
 *
 * The values of a field come from its kinds in a catalog. The kinds hold every
 * real value, so a "no" holds for the real values too. A "yes" holds for the
 * kinds: a check of the Schema may still stop the example.
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import { isObject } from "effect/Predicate"
import * as Algebra from "./algebra.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"

type Node = Nodes.Node

/**
 * Values of fields, as a nested object. A field that is not in it may have any
 * value. A value with parts that the search does not look into, such as a
 * date, is an empty object.
 */
export interface Example {
	readonly [field: string]: unknown
}

/** The answer of a search. */
export type Satisfiability = Data.TaggedEnum<{
	Satisfiable: { readonly example: Example }
	Unsatisfiable: {}
	Unknown: { readonly reason: "predicate" | "budget" }
}>

const satisfiability = Data.taggedEnum<Satisfiability>()

/** Stands for a value with parts, such as a struct or a date. */
const opaque: object = Object.freeze({})

/** Marks a field that a step of the search did not fix. */
const free: unique symbol = Symbol("free")

/** The least number that is greater than `value`. */
const nextUp = (value: number): number => {
	if (Number.isNaN(value) || value === Infinity) {
		return value
	}
	if (value === 0) {
		return Number.MIN_VALUE
	}
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, value)
	const bits = view.getBigUint64(0)
	view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n)
	return view.getFloat64(0)
}

/**
 * Gives one number from each part of the number line that the constants
 * make: each constant, and one number between each two neighbours when there
 * is one. The ends of the domain are in the list too.
 */
const numberCells = (
	kind: "integer" | "finite" | "any",
	constants: ReadonlyArray<number>,
): ReadonlyArray<number> => {
	const integer = kind === "integer"
	const low = integer
		? Number.MIN_SAFE_INTEGER
		: kind === "finite"
			? -Number.MAX_VALUE
			: -Infinity
	const high = integer
		? Number.MAX_SAFE_INTEGER
		: kind === "finite"
			? Number.MAX_VALUE
			: Infinity
	const known: ReadonlyArray<number> = Arr.filter(
		constants,
		(value: number) => !Number.isNaN(value),
	)
	const points = Arr.filter(
		Arr.flatMap(known, (value: number) =>
			integer && Number.isFinite(value)
				? [Math.floor(value), Math.ceil(value)]
				: [value],
		),
		(value: number) => value >= low && value <= high,
	)
	// `0` and `-0` are one point: every test gives the same answer for both,
	// and `===` calls them equal.
	const ordered: Array<number> = [low, high, ...points].sort((a, b) => a - b)
	const sorted = Arr.dedupeAdjacentWith(
		ordered,
		(a: number, b: number) => a === b,
	)
	const cells = Arr.flatMap(sorted, (value, index) => {
		const after = sorted[index + 1]
		const between = integer ? value + 1 : nextUp(value)
		return after !== undefined && between < after ? [value, between] : [value]
	})
	return kind === "any" ? Arr.append(cells, Number.NaN) : cells
}

/**
 * Gives one string from each part that the constants make. Strings are in the
 * order of their UTF-16 code units, as `<` sees them. The least string after
 * `a` is `a + "\0"`, so there is a string between `a` and `b` exactly when
 * `b` is not `a + "\0"`.
 */
const stringCells = (
	constants: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const ordered: Array<string> = [...constants].sort()
	const sorted = Arr.dedupeAdjacentWith(
		ordered,
		(a: string, b: string) => a === b,
	)
	if (sorted.length === 0) {
		return [""]
	}
	return [
		...(sorted[0] === "" ? [] : [""]),
		...Arr.flatMap(sorted, (value, index) => {
			const next = `${value}\0`
			return next === sorted[index + 1] ? [value] : [value, next]
		}),
	]
}

/**
 * A text for a cell. Two cells get one text when every test gives the same
 * answer for them: `0` and `-0` are one, and `NaN` is one.
 */
const cellText = (cell: unknown): string =>
	cell === opaque
		? "opaque"
		: typeof cell === "number"
			? `number:${Object.is(cell, -0) ? "0" : String(cell)}`
			: `${typeof cell}:${String(cell)}`

/** Keeps the first cell of each text, in order. */
const dedupeCells = (cells: ReadonlyArray<unknown>): ReadonlyArray<unknown> =>
	Arr.flatten(
		Arr.mapAccum(cells, HashSet.empty<string>(), (seen, cell) => {
			const text = cellText(cell)
			return [HashSet.add(seen, text), HashSet.has(seen, text) ? [] : [cell]]
		})[1],
	)

/** Gives one value from each cell of a field. */
const cellsOf = (
	kinds: Catalog.Kinds,
	constants: ReadonlyArray<Nodes.Scalar>,
): ReadonlyArray<unknown> =>
	dedupeCells([
		...(kinds.null ? [null] : []),
		...(kinds.object ? [opaque] : []),
		...(kinds.boolean ? [true, false] : []),
		...(kinds.string
			? stringCells(Arr.filter(constants, (value) => typeof value === "string"))
			: []),
		...(kinds.number === "none"
			? []
			: numberCells(
					kinds.number,
					Arr.filter(constants, (value) => typeof value === "number"),
				)),
		...kinds.literals,
	])

class OutOfBudget extends Data.Error {}

/** What one search keeps for all its steps. It lives only as long as the search. */
interface Search {
	readonly cells: (field: string) => ReadonlyArray<unknown>
	/**
	 * The texts of the values of each `In` test, so one test of a value does
	 * not read every value of the test. It is a native `Map`, because it must
	 * find a node by the node itself: a hash of a node reads all its values.
	 */
	readonly members: Map<Nodes.In, HashSet.HashSet<string>>
	readonly budget: number
}

/** What a search has done up to now. Each step gives a new one. */
interface SearchState {
	readonly steps: number
	/** The conditions that the search found to be unsatisfiable. */
	readonly failed: HashSet.HashSet<Node>
}

interface Found {
	readonly assignment: Option.Option<ReadonlyArray<readonly [string, unknown]>>
	readonly state: SearchState
}

const literalOf = (operand: Nodes.Operand): Nodes.Scalar => {
	if (operand._tag !== "Literal") {
		throw new Error(
			"Condition.satisfiable needs a condition with no principal fields. Call Condition.partial first.",
		)
	}
	return operand.value
}

/**
 * The value of the field `name` after `field` gets `value`. A field below
 * `field` is `null` when `value` is not a value with parts.
 */
const fixedValue = (
	name: string,
	field: string,
	value: unknown,
): unknown | typeof free =>
	name === field
		? value
		: name.startsWith(`${field}.`)
			? value === opaque
				? free
				: null
			: free

const membersOf = (node: Nodes.In, search: Search): HashSet.HashSet<string> => {
	const known = search.members.get(node)
	if (known !== undefined) {
		return known
	}
	// `===` finds no `NaN`, so the set has none, and `NaN` is in no test.
	const members = HashSet.fromIterable(
		Arr.map(
			Arr.filter(
				Arr.map(node.values, literalOf),
				(literal) => !Number.isNaN(literal),
			),
			cellText,
		),
	)
	search.members.set(node, members)
	return members
}

const testFixed = (
	node: Nodes.Compare | Nodes.In | Nodes.Exists,
	value: unknown,
	search: Search,
): boolean => {
	switch (node._tag) {
		case "Compare":
			return Algebra.testCompare(node.op, value, literalOf(node.value))
		case "In":
			return (
				!Number.isNaN(value) &&
				HashSet.has(membersOf(node, search), cellText(value))
			)
		case "Exists":
			return value !== null
	}
}

/** Puts one value into a field, and into the fields below it. */
const fix = (
	node: Node,
	field: string,
	value: unknown,
	search: Search,
): Node => {
	const fixChild = (child: Node) => fix(child, field, value, search)
	switch (node._tag) {
		case "Compare":
		case "In":
		case "Exists": {
			const known = fixedValue(node.field, field, value)
			return known === free
				? node
				: testFixed(node, known, search)
					? Nodes.always
					: Nodes.never
		}
		case "And":
			return Algebra.and(Arr.map(node.conditions, fixChild))
		case "Or":
			return Algebra.or(Arr.map(node.conditions, fixChild))
		case "Not":
			return node.condition.pipe(fixChild, Algebra.not)
		default:
			return node
	}
}

/** The fields of the tests of a condition, once for each test. */
const testedFields = (node: Node): ReadonlyArray<string> => {
	switch (node._tag) {
		case "Compare":
		case "In":
		case "Exists":
			return [node.field]
		case "And":
		case "Or":
			return Arr.flatMap(node.conditions, testedFields)
		case "Not":
			return testedFields(node.condition)
		default:
			return []
	}
}

/**
 * Picks the next field to split on. A field comes before the fields below it,
 * so a value of a field can fix them. Then a field in more tests comes first,
 * and then the first name in order, so the choice is the same each time.
 */
const nextField = (node: Node): string => {
	const counts = MutableHashMap.empty<string, number>()
	Arr.forEach(testedFields(node), (field) =>
		MutableHashMap.set(
			counts,
			field,
			Option.getOrElse(MutableHashMap.get(counts, field), () => 0) + 1,
		),
	)
	const depth = (field: string) => field.split(".").length
	const [first, ...rest] = Array.from(counts)
	return Arr.reduce(rest, first!, (best, next) =>
		depth(next[0]) < depth(best[0]) ||
		(depth(next[0]) === depth(best[0]) &&
			(next[1] > best[1] || (next[1] === best[1] && next[0] < best[0])))
			? next
			: best,
	)[0]
}

/**
 * Finds values of the fields that make a simple condition true. It splits on
 * one field at a time, and tries one value from each cell of the field. Each
 * step reads the whole condition, so the budget counts its size.
 */
const searchNode = (
	node: Node,
	search: Search,
	state: SearchState,
	assignment: ReadonlyArray<readonly [string, unknown]>,
): Found => {
	if (node._tag === "True") {
		return { assignment: Option.some(assignment), state }
	}
	if (node._tag === "False" || HashSet.has(state.failed, node)) {
		return { assignment: Option.none(), state }
	}
	if (state.steps + node.size > search.budget) {
		throw new OutOfBudget()
	}
	const field = nextField(node)
	// The cells are tried in order, until one gives values. A fold over the
	// cells does no work after a found answer, and it does not grow the stack
	// with the number of cells.
	const result = Arr.reduce(
		search.cells(field),
		{
			assignment: Option.none(),
			state: { ...state, steps: state.steps + node.size },
		} as Found,
		(before, cell): Found => {
			if (Option.isSome(before.assignment)) {
				return before
			}
			const steps = before.state.steps + node.size
			if (steps > search.budget) {
				throw new OutOfBudget()
			}
			return searchNode(
				fix(node, field, cell, search),
				search,
				{ ...before.state, steps },
				[...assignment, [field, cell]],
			)
		},
	)
	return Option.isSome(result.assignment)
		? result
		: {
				assignment: Option.none(),
				state: {
					...result.state,
					// A condition with the same structure has the same free fields,
					// so its answer is the same.
					failed: HashSet.add(result.state.failed, node),
				},
			}
}

/**
 * Puts a value at a path in an object, and gives a new object. A value with
 * parts (`opaque`) becomes an empty object, and it keeps an object that is
 * there.
 */
const setPath = (
	root: Readonly<Record<string, unknown>>,
	names: ReadonlyArray<string>,
	value: unknown,
): Readonly<Record<string, unknown>> => {
	const [name, ...rest] = names
	if (name === undefined) {
		return root
	}
	// Only an own field counts, as a condition reads it. An inherited one,
	// such as `__proto__`, is not a field of the example.
	const inner = Object.hasOwn(root, name) ? root[name] : undefined
	if (rest.length === 0) {
		return value === opaque && isObject(inner)
			? root
			: { ...root, [name]: value === opaque ? {} : value }
	}
	const base =
		isObject(inner) && inner !== opaque
			? (inner as Readonly<Record<string, unknown>>)
			: {}
	return { ...root, [name]: setPath(base, rest, value) }
}

const exampleOf = (
	assignment: ReadonlyArray<readonly [string, unknown]>,
): Example =>
	Arr.reduce(
		assignment,
		{} as Readonly<Record<string, unknown>>,
		(root, [field, value]) => setPath(root, field.split("."), value),
	)

/** The constants that the tests of each field use. */
const constantsOf = (
	node: Node,
): HashMap.HashMap<string, HashSet.HashSet<Nodes.Scalar>> => {
	const pairs = (
		current: Node,
	): ReadonlyArray<readonly [string, ReadonlyArray<Nodes.Scalar>]> => {
		switch (current._tag) {
			case "Compare":
				return [[current.field, [literalOf(current.value)]]]
			case "In":
				return [[current.field, Arr.map(current.values, literalOf)]]
			case "Exists":
				return [[current.field, []]]
			case "Under":
				throw new Error(
					"Condition.satisfiable needs a condition with no Under nodes. Call Condition.partial first.",
				)
			case "And":
			case "Or":
				return Arr.flatMap(current.conditions, pairs)
			case "Not":
				return pairs(current.condition)
			default:
				return []
		}
	}
	return Arr.reduce(pairs(node), HashMap.empty(), (all, [field, values]) =>
		HashMap.set(
			all,
			field,
			HashSet.union(
				Option.getOrElse(HashMap.get(all, field), HashSet.empty),
				HashSet.fromIterable(values),
			),
		),
	)
}

/** Gives the kinds of each field of a catalog. A field that it does not have may hold any value. */
export const kindsIn =
	(catalog: Catalog.Catalog | undefined) =>
	(field: string): Catalog.Kinds =>
		(catalog === undefined ? undefined : Catalog.lookup(catalog, field))
			?.kinds ?? Catalog.anyKinds

/**
 * Searches for values that make a condition true. `kindsOf` gives the kinds
 * of values of each field. The condition must have no principal fields and no
 * `Under` nodes.
 */
export const satisfiable = (
	node: Node,
	kindsOf: (field: string) => Catalog.Kinds,
	budget: number = Limits.searchSteps,
): Satisfiability => {
	if (node.opaque) {
		return satisfiability.Unknown({ reason: "predicate" })
	}
	const constants = constantsOf(node)
	// The search calls itself one time for each field that it fixes.
	if (HashMap.size(constants) > Limits.searchFields) {
		return satisfiability.Unknown({ reason: "budget" })
	}
	// The cells of each field. A field name is a string, so an Effect map
	// finds it.
	const cells = MutableHashMap.empty<string, ReadonlyArray<unknown>>()
	const search: Search = {
		members: new Map(),
		cells: (field) =>
			Option.getOrElse(MutableHashMap.get(cells, field), () => {
				// The cells come from the constants, so many constants are work
				// that the budget must count before the cells are made.
				const known = Option.getOrElse(
					HashMap.get(constants, field),
					HashSet.empty,
				)
				if (HashSet.size(known) > budget) {
					throw new OutOfBudget()
				}
				const found = cellsOf(kindsOf(field), Array.from(known))
				MutableHashMap.set(cells, field, found)
				return found
			}),
		budget,
	}
	try {
		const found = searchNode(
			Algebra.simplify(node),
			search,
			{ steps: 0, failed: HashSet.empty() },
			[],
		)
		return Option.match(found.assignment, {
			onNone: () => satisfiability.Unsatisfiable(),
			onSome: (assignment) =>
				satisfiability.Satisfiable({ example: exampleOf(assignment) }),
		})
	} catch (error) {
		if (error instanceof OutOfBudget) {
			return satisfiability.Unknown({ reason: "budget" })
		}
		throw error
	}
}
