import { assert, describe, it } from "@effect/vitest"
import { Array as Arr } from "effect"
import * as Trampoline from "../src/internal/trampoline.ts"

interface Tree {
	readonly value: number
	readonly children: ReadonlyArray<Tree>
}

const chain = (levels: number): Tree =>
	Arr.reduce(
		Arr.range(1, levels),
		{ value: 0, children: [] } as Tree,
		(inner, value) => ({ value, children: [inner] }),
	)

// The sum of the values of a tree, as a walk with the steps of a runner.
const sum =
	(tree: Tree) =>
	(R: Trampoline.Runner): Trampoline.Step<number> => {
		const go = (node: Tree): Trampoline.Step<number> =>
			R.map(
				R.forEach(node.children, (child) => R.suspend(() => go(child))),
				(values) => Arr.reduce(values, node.value, (total, x) => total + x),
			)
		return go(tree)
	}

// Tests if a tree has a value, and stops at the first one.
const has =
	(tree: Tree, wanted: number) =>
	(R: Trampoline.Runner): Trampoline.Step<boolean> => {
		const go = (node: Tree): Trampoline.Step<boolean> =>
			node.value === wanted
				? R.succeed(true)
				: R.some(node.children, (child) => R.suspend(() => go(child)))
		return go(tree)
	}

describe("Trampoline", () => {
	it("gives the same values with both runners", () => {
		const tree: Tree = {
			value: 1,
			children: [chain(10), { value: 5, children: [] }, chain(3)],
		}
		assert.strictEqual(
			Trampoline.runWith(Trampoline.direct, sum(tree)),
			Trampoline.runWith(Trampoline.loop, sum(tree)),
		)
		assert.isTrue(Trampoline.runWith(Trampoline.loop, has(tree, 5)))
		assert.isFalse(Trampoline.runWith(Trampoline.loop, has(tree, 99)))
	})

	it("walks a very deep input with the loop, and not with the stack", () => {
		const deep = chain(100_000)
		assert.throws(() => Trampoline.runWith(Trampoline.direct, sum(deep)))
		assert.strictEqual(
			Trampoline.run(100_000, sum(deep)),
			(100_000 * 100_001) / 2,
		)
		assert.isTrue(Trampoline.run(100_000, has(deep, 0)))
	})

	it("gives back an error of a step as it was", () => {
		class Stop extends Error {}
		const failing = (R: Trampoline.Runner) =>
			R.suspend((): Trampoline.Step<number> => {
				throw new Stop("stop")
			})
		assert.throws(() => Trampoline.runWith(Trampoline.loop, failing), Stop)
		assert.throws(() => Trampoline.runWith(Trampoline.direct, failing), Stop)
	})
})
