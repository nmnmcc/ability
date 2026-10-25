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
	readonly depthOf: (node: object) => number
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
 * Tests if two nodes have the same data. Two nodes with other hashes are not
 * equal, so most tests end at once. The walk takes the steps of a trampoline,
 * so a deep tree does not fill the stack.
 */
export const equals = (kind: Kind, self: object, that: unknown): boolean =>
	Trampoline.run(kind.depthOf(self), (R) => {
		const nodes = (
			a: Hash.Hash & Equal.Equal,
			b: Hash.Hash & Equal.Equal,
		): Trampoline.Step<boolean> => {
			if (a === b) {
				return R.succeed(true)
			}
			if (
				a.constructor !== b.constructor ||
				a[Hash.symbol]() !== b[Hash.symbol]()
			) {
				return R.succeed(false)
			}
			const keys = Object.keys(a)
			return keys.length !== Object.keys(b).length
				? R.succeed(false)
				: R.every(keys, (key) =>
						part(
							(a as unknown as Record<string, unknown>)[key],
							(b as unknown as Record<string, unknown>)[key],
						),
					)
		}
		const part = (x: unknown, y: unknown): Trampoline.Step<boolean> =>
			kind.isNode(x) && kind.isNode(y)
				? R.suspend(() => nodes(x, y))
				: Array.isArray(x) && Array.isArray(y)
					? x.length === y.length
						? R.every(Arr.zip(x as ReadonlyArray<unknown>, y), ([a, b]) =>
								part(a, b),
							)
						: R.succeed(false)
					: R.succeed(Equal.equals(x, y))
		return kind.isNode(self) && kind.isNode(that)
			? nodes(self, that)
			: R.succeed(false)
	})
