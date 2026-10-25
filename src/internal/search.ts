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
import * as Option from "effect/Option"
import { isObject } from "effect/Predicate"
import * as Algebra from "./algebra.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as Trampoline from "./trampoline.ts"

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

/**
 * Keeps the first cell of each text, in order. The texts come from the
 * values of a policy, so they go into a native `Set`: the hash of a string in
 * Effect has no random seed, and a policy could hold very many strings with
 * one hash. The engine hashes a string with a random seed.
 */
const dedupeCells = (cells: ReadonlyArray<unknown>): ReadonlyArray<unknown> => {
	// The set belongs to this call.
	const seen = new Set<string>()
	return Arr.filter(cells, (cell) => {
		const text = cellText(cell)
		if (seen.has(text)) {
			return false
		}
		seen.add(text)
		return true
	})
}

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
	 * The texts are in a native `Set`, as in {@link dedupeCells}.
	 */
	readonly members: Map<Nodes.In, Set<string>>
	/**
	 * The keys of the conditions that the search found to be unsatisfiable:
	 * see `Algebra.keyOf`. A condition with the same structure has the same
	 * free fields, so its answer is the same. The set only grows, so the steps
	 * of a search may share it. It is a native `Set`, as in
	 * {@link dedupeCells}.
	 */
	readonly failed: Set<string | Node>
	readonly budget: number
}

/** What a search has done up to now. Each step gives a new one. */
interface SearchState {
	readonly steps: number
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

const membersOf = (node: Nodes.In, search: Search): Set<string> => {
	const known = search.members.get(node)
	if (known !== undefined) {
		return known
	}
	// `===` finds no `NaN`, so the set has none, and `NaN` is in no test.
	const members = new Set(
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
				!Number.isNaN(value) && membersOf(node, search).has(cellText(value))
			)
		case "Exists":
			return value !== null
	}
}

/** Puts one value into a field, and into the fields below it. */
const fix = (root: Node, field: string, value: unknown, search: Search): Node =>
	// The walks of a condition take the steps of a trampoline, so a deep
	// condition does not fill the stack.
	Trampoline.run(root.depth, (R) => {
		const go = (node: Node): Trampoline.Step<Node> => {
			const children = (nodes: ReadonlyArray<Node>) =>
				R.forEach(nodes, (child) => R.suspend(() => go(child)))
			switch (node._tag) {
				case "Compare":
				case "In":
				case "Exists": {
					const known = fixedValue(node.field, field, value)
					return R.succeed(
						known === free
							? node
							: testFixed(node, known, search)
								? Nodes.always
								: Nodes.never,
					)
				}
				case "And":
					return R.map(children(node.conditions), Algebra.and)
				case "Or":
					return R.map(children(node.conditions), Algebra.or)
				case "Not":
					return R.map(
						R.suspend(() => go(node.condition)),
						Algebra.not,
					)
				default:
					return R.succeed(node)
			}
		}
		return go(root)
	})

/** The fields of the tests of a condition, once for each test. */
const testedFields = (root: Node): ReadonlyArray<string> => {
	// The fields go into one list, in order. A walk that joined the lists of
	// the children would copy the list of a deep condition at each level. The
	// list belongs to this walk.
	const fields: Array<string> = []
	Trampoline.run(root.depth, (R) => {
		const go = (node: Node): Trampoline.Step<undefined> => {
			switch (node._tag) {
				case "Compare":
				case "In":
				case "Exists":
					fields.push(node.field)
					return R.succeed(undefined)
				case "And":
				case "Or":
					return R.map(
						R.forEach(node.conditions, (child) => R.suspend(() => go(child))),
						() => undefined,
					)
				case "Not":
					return R.suspend(() => go(node.condition))
				default:
					return R.succeed(undefined)
			}
		}
		return go(root)
	})
	return fields
}

/**
 * Picks the next field to split on. A field comes before the fields below it,
 * so a value of a field can fix them. Then a field in more tests comes first,
 * and then the first name in order, so the choice is the same each time.
 */
const nextField = (node: Node): string => {
	// A native `Map`, as in `dedupeCells`: a condition that is not bound to a
	// domain may have any field names. The map belongs to this call.
	const counts = new Map<string, number>()
	Arr.forEach(testedFields(node), (field) =>
		counts.set(field, (counts.get(field) ?? 0) + 1),
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
const searchNode = (search: Search) => (R: Trampoline.Runner) => {
	const go = (
		node: Node,
		state: SearchState,
		assignment: ReadonlyArray<readonly [string, unknown]>,
	): Trampoline.Step<Found> => {
		if (node._tag === "True") {
			return R.succeed({ assignment: Option.some(assignment), state })
		}
		if (node._tag === "False") {
			return R.succeed({ assignment: Option.none(), state })
		}
		// The key reads at most a small part of the node: a node with very
		// many nodes, or with very many values in its `In` tests, is its own
		// key. A step reads the nodes but not the values, which `membersOf`
		// keeps, so the budget counts the size.
		const key = Algebra.keyOf(node)
		if (search.failed.has(key)) {
			return R.succeed({ assignment: Option.none(), state })
		}
		if (state.steps + node.size > search.budget) {
			throw new OutOfBudget()
		}
		const field = nextField(node)
		// The cells are tried in order, until one gives values. A fold over
		// the cells does no work after a found answer, and it does not grow
		// the stack with the number of cells. Each call for the next field
		// is a step of the runner, so very many fields do not fill the stack.
		return R.map(
			R.reduce(
				search.cells(field),
				{
					assignment: Option.none(),
					state: { ...state, steps: state.steps + node.size },
				} as Found,
				(before, cell): Trampoline.Step<Found> => {
					if (Option.isSome(before.assignment)) {
						return R.succeed(before)
					}
					const steps = before.state.steps + node.size
					if (steps > search.budget) {
						throw new OutOfBudget()
					}
					return R.suspend(() =>
						go(fix(node, field, cell, search), { ...before.state, steps }, [
							...assignment,
							[field, cell],
						]),
					)
				},
			),
			(result) => {
				if (Option.isNone(result.assignment)) {
					search.failed.add(key)
				}
				return result
			},
		)
	}
	return go
}

/**
 * Puts a value at a path in an object, and gives a new object. A value with
 * parts (`opaque`) becomes an empty object, and it keeps an object that is
 * there.
 */
type Fields = Readonly<Record<string, unknown>>

const setPath = (
	root: Fields,
	names: ReadonlyArray<string>,
	value: unknown,
): Fields => {
	const last = names[names.length - 1]
	if (last === undefined) {
		return root
	}
	// Only an own field counts, as a condition reads it. An inherited one,
	// such as `__proto__`, is not a field of the example.
	const own = (base: Fields, name: string): unknown =>
		Object.hasOwn(base, name) ? base[name] : undefined
	// The object at each part of the path, from the root down to the object
	// that gets the value. A part that is not an object becomes empty. The
	// path is walked in a loop, so a long path does not fill the stack.
	const bases = Arr.scan(names.slice(0, -1), root, (base, name): Fields => {
		const inner = own(base, name)
		return isObject(inner) && inner !== opaque ? (inner as Fields) : {}
	})
	const target = bases[bases.length - 1]!
	const inner = own(target, last)
	const placed: Fields =
		value === opaque && isObject(inner)
			? target
			: { ...target, [last]: value === opaque ? {} : value }
	// Each object above gets the new object below it, from the bottom up.
	return Arr.reduceRight(
		names.slice(0, -1),
		placed,
		(below, name, index): Fields => ({ ...bases[index]!, [name]: below }),
	)
}

const exampleOf = (
	assignment: ReadonlyArray<readonly [string, unknown]>,
): Example =>
	Arr.reduce(
		assignment,
		{} as Readonly<Record<string, unknown>>,
		(root, [field, value]) => setPath(root, field.split("."), value),
	)

/**
 * The constants that the tests of each field use. They come from a policy, so
 * they go into a native `Map` and `Set`, as in {@link dedupeCells}. The map
 * belongs to one search.
 */
const constantsOf = (node: Node): Map<string, Set<Nodes.Scalar>> => {
	// The constants go into one map as the walk finds them. A walk that
	// joined the lists of the children would copy the list of a deep
	// condition at each level. The map belongs to one search.
	const all = new Map<string, Set<Nodes.Scalar>>()
	const add = (field: string, values: ReadonlyArray<Nodes.Scalar>): void => {
		const known = all.get(field) ?? new Set<Nodes.Scalar>()
		Arr.forEach(values, (value) => known.add(value))
		all.set(field, known)
	}
	// The walk takes the steps of a trampoline, so a deep condition does not
	// fill the stack.
	Trampoline.run(node.depth, (R) => {
		const go = (current: Node): Trampoline.Step<undefined> => {
			switch (current._tag) {
				case "Compare":
					add(current.field, [literalOf(current.value)])
					return R.succeed(undefined)
				case "In":
					add(current.field, Arr.map(current.values, literalOf))
					return R.succeed(undefined)
				case "Exists":
					add(current.field, [])
					return R.succeed(undefined)
				case "Under":
					throw new Error(
						"Condition.satisfiable needs a condition with no Under nodes. Call Condition.partial first.",
					)
				case "And":
				case "Or":
					return R.map(
						R.forEach(current.conditions, (child) =>
							R.suspend(() => go(child)),
						),
						() => undefined,
					)
				case "Not":
					return R.suspend(() => go(current.condition))
				default:
					return R.succeed(undefined)
			}
		}
		return go(node)
	})
	return all
}

/** Gives the kinds of each field of a catalog. A field that it does not have may hold any value. */
export const kindsIn =
	(catalog: Catalog.Catalog | undefined, parts?: number) =>
	(field: string): Catalog.Kinds =>
		(catalog === undefined ? undefined : Catalog.lookup(catalog, field, parts))
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
	fields: number = Limits.searchFields,
): Satisfiability => {
	if (node.opaque) {
		return satisfiability.Unknown({ reason: "predicate" })
	}
	const constants = constantsOf(node)
	// The search calls itself one time for each field that it fixes.
	if (constants.size > fields) {
		return satisfiability.Unknown({ reason: "budget" })
	}
	// The cells of each field, in a native `Map` as the constants are.
	const cells = new Map<string, ReadonlyArray<unknown>>()
	const search: Search = {
		members: new Map(),
		failed: new Set(),
		cells: (field) => {
			const made = cells.get(field)
			if (made !== undefined) {
				return made
			}
			// The cells come from the constants, so many constants are work
			// that the budget must count before the cells are made.
			const known = constants.get(field) ?? new Set<Nodes.Scalar>()
			if (known.size > budget) {
				throw new OutOfBudget()
			}
			const found = cellsOf(kindsOf(field), Array.from(known))
			cells.set(field, found)
			return found
		},
		budget,
	}
	try {
		// The search goes one call deeper for each field, so the runner is the
		// one for that many levels.
		const found = Trampoline.run(constants.size, (R) =>
			searchNode(search)(R)(Algebra.simplify(node), { steps: 0 }, []),
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
