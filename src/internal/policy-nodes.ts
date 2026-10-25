/**
 * The nodes of a policy tree. As with the nodes of a condition, each node is
 * a class, only its constructor makes one, and it works out three facts once:
 * - `size`: the number of nodes, with each rule and each node of its condition,
 *   and a shared child counted for each place;
 * - `depth`: the number of levels of the tree;
 * - `opaque`: a rule of the tree has a predicate.
 *
 * The constructor stops a tree past `policyNodes` or `policyDepth`. So a walk
 * over any tree, such as a decision, needs no memo.
 */
import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Equal from "effect/Equal"
import * as Hash from "effect/Hash"
import * as Schema from "effect/Schema"
import * as Rule from "./rule.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as Structure from "./structure.ts"
import * as Trampoline from "./trampoline.ts"

/** The combining algorithms of a list of rules. The decoder reads this list too. */
export const Algorithm = Schema.Literals([
	"denyOverrides",
	"permitOverrides",
	"firstApplicable",
	"lastApplicable",
])

export type Algorithm = typeof Algorithm.Type

/**
 * Tests if a value is a combining algorithm. It reads the list of the Schema
 * with `includes`, as `Nodes.isCompareOperator` does.
 */
export const isAlgorithm = (u: unknown): u is Algorithm =>
	(Algorithm.literals as ReadonlyArray<unknown>).includes(u)

interface Facts {
	readonly size: number
	readonly depth: number
	readonly opaque: boolean
}

/** Checks the facts of a node against the limits. */
const checked = (facts: Facts): Facts => {
	// A node does not know its domain, so it checks the ceiling. A policy
	// checks the limit of its domain.
	if (facts.size > Limits.ceilings.policyNodes) {
		throw Limits.exceeded(
			"A policy tree",
			"policyNodes",
			"nodes",
			facts.size,
			Limits.ceilings.policyNodes,
		)
	}
	return facts
}

const factsOf = (children: ReadonlyArray<Node>): Facts =>
	checked({
		size: Arr.reduce(children, 1, (total, child) => total + child.size),
		depth:
			1 + Arr.reduce(children, 0, (top, child) => Math.max(top, child.depth)),
		opaque: Arr.some(children, (child) => child.opaque),
	})

/** The base of every node. It keeps the facts. */
abstract class Base extends Data.Class {
	readonly #facts: Facts
	readonly #hash: number

	/** `hashed` is the data that the hash reads, which is `props` at most. */
	constructor(
		tag: string,
		props: object,
		facts: Facts,
		hashed: object = props,
	) {
		super(props as never)
		this.#facts = facts
		this.#hash = Structure.hashOf(kind, tag, hashed)
	}

	// A tree has no limit of levels, so the hash and the equality are the
	// ones of `Structure`, which do not fill the stack. They read the same
	// data as the ones of `Data.Class`.
	[Hash.symbol](): number {
		return this.#hash
	}

	[Equal.symbol](that: unknown): boolean {
		return Structure.equals(kind, this, that)
	}

	/** The number of nodes, with the rules and their conditions. */
	get size(): number {
		return this.#facts.size
	}

	/** The number of levels of the tree. */
	get depth(): number {
		return this.#facts.depth
	}

	/** A rule of the tree has a predicate. */
	get opaque(): boolean {
		return this.#facts.opaque
	}
}

const kind: Structure.Kind = {
	isNode: (u): u is Base => u instanceof Base,
	// A rule holds its `meta`, which may have very many levels.
	isRecord: Rule.isRule,
}

/**
 * The condition of a rule. A value that is not a node counts as one node
 * here: the binding of the rule gives the issue for it, before any walk.
 */
const whenOf = (rule: Rule.Rule): Nodes.Node | undefined =>
	Nodes.isNode(rule.when) ? rule.when : undefined

/** A list of rules with a combining algorithm. */
export class Rules extends Base {
	readonly _tag = "Rules"
	declare readonly algorithm: Algorithm
	declare readonly rules: ReadonlyArray<Rule.Rule>
	constructor(props: {
		readonly algorithm: Algorithm
		readonly rules: ReadonlyArray<Rule.Rule>
	}) {
		if (!isAlgorithm(props.algorithm)) {
			throw new Error(
				`"${String(props.algorithm)}" is not a combining algorithm`,
			)
		}
		const rules = Object.freeze(Array.from(props.rules))
		// A value that is not a rule, such as a copy of a rule made with a
		// spread, may keep the type fields of another rule, and it does not
		// work in a generator. It is a mistake in the code, so it is a defect.
		if (!Arr.every(rules, Rule.isRule)) {
			throw new Error("A value in the list is not a rule")
		}
		const conditions = Arr.map(rules, whenOf)
		super(
			"Rules",
			{ algorithm: props.algorithm, rules },
			checked({
				size: Arr.reduce(
					conditions,
					1,
					// A condition counts its nodes and the values of its tests.
					(total, when) => total + 1 + (when?.weight ?? 0),
				),
				depth: 1,
				opaque: Arr.some(conditions, (when) => when?.opaque ?? false),
			}),
			// The hash of a rule reads only its small parts: see `Rule`.
			{
				algorithm: props.algorithm,
				rules: Arr.map(rules, (rule) => rule[Hash.symbol]()),
			},
		)
	}
}

const checkChildren = (
	policies: ReadonlyArray<unknown>,
): ReadonlyArray<Node> => {
	const children = Array.from(policies)
	if (!Arr.every(children, isNode)) {
		throw new Error("A child of a policy tree is not a node of a policy")
	}
	return Object.freeze(children)
}

/** Every policy must allow, and one deny is enough to deny. */
export class All extends Base {
	readonly _tag = "All"
	declare readonly policies: ReadonlyArray<Node>
	constructor(policies: ReadonlyArray<Node>) {
		const children = checkChildren(policies)
		super("All", { policies: children }, factsOf(children))
	}
}

/** One allow is enough. Without an allow, one deny gives a deny. */
export class Any extends Base {
	readonly _tag = "Any"
	declare readonly policies: ReadonlyArray<Node>
	constructor(policies: ReadonlyArray<Node>) {
		const children = checkChildren(policies)
		super("Any", { policies: children }, factsOf(children))
	}
}

/** The first policy that allows or denies gives the answer. */
export class FirstOf extends Base {
	readonly _tag = "FirstOf"
	declare readonly policies: ReadonlyArray<Node>
	constructor(policies: ReadonlyArray<Node>) {
		const children = checkChildren(policies)
		super("FirstOf", { policies: children }, factsOf(children))
	}
}

/** A deny from `cap` always wins. An allow from `cap` does nothing. */
export class Ceiling extends Base {
	readonly _tag = "Ceiling"
	declare readonly cap: Node
	declare readonly policy: Node
	constructor(props: { readonly cap: Node; readonly policy: Node }) {
		const [cap, policy] = checkChildren([props.cap, props.policy])
		super("Ceiling", { cap, policy }, factsOf([cap!, policy!]))
	}
}

/** A node of a policy tree. */
export type Node = Rules | All | Any | FirstOf | Ceiling

/** Tests if a value is a node of a policy tree. */
export const isNode = (u: unknown): u is Node => u instanceof Base

/**
 * The rules of a tree, in order, once for each place. A walk that also goes
 * into the condition of each rule takes the rules from this list first, so it
 * does not go down the levels of the tree and of a condition at once.
 */
export const rulesOf = (root: Node): ReadonlyArray<Rule.Rule> => {
	// The rules go into one list, in order. A walk that joined the lists of
	// the children at each node would copy the list of a deep tree at each
	// level. The list belongs to this walk.
	const rules: Array<Rule.Rule> = []
	// The walk takes the steps of a trampoline, so a deep tree does not fill
	// the stack.
	Trampoline.run(root.depth, (R) => {
		const children = (nodes: ReadonlyArray<Node>) =>
			R.map(
				R.forEach(nodes, (child) => R.suspend(() => go(child))),
				() => undefined,
			)
		const go = (node: Node): Trampoline.Step<undefined> => {
			switch (node._tag) {
				case "Rules":
					Arr.forEach(node.rules, (rule) => {
						rules.push(rule)
					})
					return R.succeed(undefined)
				case "All":
				case "Any":
				case "FirstOf":
					return children(node.policies)
				case "Ceiling":
					return children([node.cap, node.policy])
			}
		}
		return go(root)
	})
	return rules
}
