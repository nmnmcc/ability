/**
 * The hash and the equality of the nodes of a condition and of a policy tree.
 * `Data.Class` gives them by structure, but its walk calls itself for each
 * level, and a tree has no limit of levels. So a node keeps its hash, which
 * its constructor makes from the hashes that its children keep, and the test
 * of equality is a walk of the trampoline. Two nodes with the same data are
 * equal, as with `Data.Class`.
 */
import * as Arr from "effect/Array"
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import * as Trampoline from "./trampoline.ts"

/** The nodes of one kind of tree. */
export interface Kind {
	readonly isNode: (u: unknown) => u is Hash.Hash & Equal.Equal
	/** Tests if a value is a record of the kind that the test of equality walks into. */
	readonly isRecord?: (u: unknown) => boolean
}

/**
 * The hash of a part of a node: a child, a list, or other data. The hash of
 * an object of data, as an operand or a rule, comes from its fields with
 * `Hash.structure`: `Hash.hash` keeps the hash of each object in a cache,
 * and a test may have very many values.
 */
const partHash = (kind: Kind, value: unknown): number =>
	kind.isNode(value)
		? value[Hash.symbol]()
		: Array.isArray(value)
			? Arr.reduce(
					value as ReadonlyArray<unknown>,
					Hash.number(value.length),
					(total, item) => Hash.combine(total, partHash(kind, item)),
				)
			: typeof value === "object" && value !== null
				? Hash.structure(value)
				: Hash.hash(value)

/**
 * Makes the hash of a node from its tag and its data. It reads the hash that
 * each child keeps, so it does not go down the levels of the tree.
 */
export const hashOf = (kind: Kind, tag: string, props: object): number =>
	Arr.reduce(Object.keys(props), Hash.string(tag), (total, key) =>
		Hash.combine(
			total,
			Hash.combine(
				Hash.string(key),
				partHash(kind, (props as Record<string, unknown>)[key]),
			),
		),
	)

/**
 * Tests if a value is a record that {@link equals} walks into: a plain object,
 * as the `meta` of a rule from JSON, or a record of the kind, as a rule.
 */
const isRecord = (kind: Kind, u: unknown): u is object => {
	if (typeof u !== "object" || u === null) {
		return false
	}
	const prototype: unknown = Object.getPrototypeOf(u)
	return (
		prototype === Object.prototype ||
		prototype === null ||
		(kind.isRecord?.(u) ?? false)
	)
}

/**
 * Tests if two nodes have the same data. Two nodes with other hashes are not
 * equal, so most tests end at once. The walk goes into the nodes, the lists
 * and the records, as the `meta` of a rule, which may have very many levels
 * too. It is a walk of the trampoline for an input of an unknown depth, so a
 * deep tree does not fill the stack. Other values are tested with `Equal`.
 *
 * The pairs of objects that the walk has met are in a native `Map` of native
 * sets, because the walk must find an object by the object itself. A pair
 * that it meets again is taken as equal, so a part that two places share is
 * tested one time, and a loop ends. The map belongs to one test.
 */
export const equals = (kind: Kind, self: object, that: unknown): boolean => {
	const met = new Map<object, Set<object>>()
	return Trampoline.adaptive<readonly [unknown, unknown], boolean>(
		(R, child) =>
			([x, y], depth) => {
				if (x === y) {
					return R.succeed(true)
				}
				// Tells if the walk has met the pair, and marks it as met.
				const known = (a: object, b: object): boolean => {
					const seen = met.get(a)
					if (seen?.has(b) ?? false) {
						return true
					}
					met.set(a, (seen ?? new Set()).add(b))
					return false
				}
				const pairs = (
					xs: ReadonlyArray<unknown>,
					ys: ReadonlyArray<unknown>,
				) =>
					xs.length === ys.length
						? R.every(Arr.zip(xs, ys), (pair) => child(pair, depth + 1))
						: R.succeed(false)
				const fields = (a: object, b: object) => {
					if (known(a, b)) {
						return R.succeed(true)
					}
					const keys = Object.keys(a)
					return keys.length === Object.keys(b).length &&
						Arr.every(keys, (key) => Object.hasOwn(b, key))
						? pairs(
								Arr.map(keys, (key) => (a as Record<string, unknown>)[key]),
								Arr.map(keys, (key) => (b as Record<string, unknown>)[key]),
							)
						: R.succeed(false)
				}
				if (kind.isNode(x) && kind.isNode(y)) {
					return x.constructor === y.constructor &&
						x[Hash.symbol]() === y[Hash.symbol]()
						? fields(x, y)
						: R.succeed(false)
				}
				if (Array.isArray(x) && Array.isArray(y)) {
					return known(x, y) ? R.succeed(true) : pairs(x, y)
				}
				if (
					isRecord(kind, x) &&
					isRecord(kind, y) &&
					Object.getPrototypeOf(x) === Object.getPrototypeOf(y)
				) {
					return fields(x, y)
				}
				return R.succeed(Equal.equals(x, y))
			},
	)([self, that])
}
