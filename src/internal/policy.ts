/**
 * The values of policies: the class of a policy, the constructors, the
 * combinators and the Schema. The types are in `Policy.ts`.
 */
import type * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Condition from "../Condition.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import * as Bind from "./bind.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as PolicyJson from "./policy-json.ts"
import * as PolicyNodes from "./policy-nodes.ts"
import * as RuleData from "./rule.ts"
import * as Trampoline from "./trampoline.ts"

type Any = Policy.Any
type Node = Policy.Node
type Options = Policy.Options

/**
 * The class of every policy value. Two policies of one domain with the same
 * tree are equal. As JSON, a policy is its tree.
 */
export class PolicyData<
	D extends Domain.Any = any,
	X = never,
> extends Data.Class<{
	readonly domain: D
	readonly node: Node
}> {
	// A private field makes the type of a policy its own: a spread of a
	// policy, or an object made by hand, is not a policy. `Equal` does not
	// read it.
	readonly #policy = true
	// The steps of the work of the checks of the rules, from the binding. A
	// tree of policies keeps the sum of the work of its parts. `Equal` does
	// not read it.
	readonly #work: number
	/** Only in the types. */
	declare readonly "~Opaque": () => X
	/**
	 * Only in the types. A policy reads the values and the principal of its
	 * domain, so a policy of one domain is not a policy of a wider domain.
	 */
	declare readonly "~Domain": (domain: D) => D

	constructor(args: { readonly domain: D; readonly node: Node }, work: number) {
		super(args)
		this.#work = work
	}

	toJSON(): unknown {
		return PolicyJson.toJson(this.node, PolicyJson.syncMeta(this.domain.meta))
	}

	/** Tests if a value is a policy, by its private field. */
	static is(u: unknown): u is Any {
		return typeof u === "object" && u !== null && #policy in u
	}

	/** Gives the steps of the work of the checks of the rules of a policy. */
	static workOf(policy: Any): number {
		return (policy as PolicyData).#work
	}
}

/** The node of a policy, with no types, for the code below. */
export const nodeOf = (policy: Any): PolicyNodes.Node => policy.node as never

/**
 * Makes a policy of a domain from its tree, with the steps of the work of the
 * binding of its rules. The constructors of the nodes check the ceiling of
 * `policyNodes`, since a node does not know its domain, so this checks the
 * limit of the domain.
 */
const fromNode = (
	domain: Domain.Any,
	node: PolicyNodes.Node,
	work: number,
): any => {
	const most = domain.limits.policyNodes
	if (node.size > most) {
		throw Limits.exceeded(
			"A policy tree",
			"policyNodes",
			"nodes",
			node.size,
			most,
		)
	}
	return new PolicyData({ domain, node }, work)
}

/**
 * The error when a rule does not fit its domain. It has one issue for each
 * problem, with its path.
 */
export class PolicyError extends Schema.TaggedError<PolicyError>(
	"@nmnmcc/ability/Policy/PolicyError",
)("PolicyError", {
	issues: Schema.Array(
		Schema.Struct({
			path: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
			message: Schema.String,
		}),
	),
	message: Schema.String,
}) {}

/** Makes a policy from a list of rules, and binds them to the domain. */
const fromRules = (
	domain: Domain.Any,
	values: Iterable<unknown>,
	options?: Options,
): Any => {
	// The constructor takes only rules, and it stops a list past the limits.
	const node = new PolicyNodes.Rules({
		algorithm: options?.algorithm ?? "denyOverrides",
		rules: Array.from(values) as ReadonlyArray<RuleData.Rule>,
	})
	// A rule from a builder of another domain is a mistake in the code, so it
	// is a defect. Two domains may have the same types, so the types do not
	// find it.
	if (
		Arr.some(node.rules, (value) => {
			const origin = value.domain
			return origin !== undefined && origin !== domain
		})
	) {
		throw new globalThis.Error(
			"A rule comes from the builder of another domain",
		)
	}
	// Every rule is bound to the domain here, also a rule from `Policy.rule`.
	const { issues, work } = Bind.treeIssues(domain, node)
	if (issues.length > 0) {
		throw PolicyError.make({
			issues: Arr.map(issues, (issue) => ({
				path: Arr.map(issue.path, (part) =>
					typeof part === "number" ? part : String(part),
				),
				message: issue.issue,
			})),
			message: `A rule does not fit the domain: ${issues.map((issue) => issue.issue).join("; ")}`,
		})
	}
	return fromNode(domain, node, work)
}

/** Makes a policy from a generator function that gives rules. */
export const define =
	(domain: Domain.Any, options?: Options) =>
	(body: (builder: unknown) => Generator<unknown, unknown, unknown>): Any => {
		const iterator = body(RuleData.builder(domain))
		// Each rule goes back into the generator, as `yield*` gives it.
		const collected = Arr.unfold(iterator.next(), (state) =>
			state.done === true
				? Option.none()
				: Option.some([state.value, iterator.next(state.value)] as const),
		)
		return fromRules(domain, collected, options) as never
	}

const sameDomain = (policies: ReadonlyArray<Any>): Domain.Any => {
	// A copy of a policy made with a spread may keep the type fields of another
	// policy. Only a policy value goes into a tree.
	if (!Arr.every(policies, isPolicy)) {
		throw new globalThis.Error("A value in the list is not a policy")
	}
	const domain = policies[0]!.domain
	if (!Arr.every(policies, (policy) => policy.domain === domain)) {
		throw new globalThis.Error(
			"Policies from two domains can not be put together",
		)
	}
	return domain
}

/**
 * Makes a policy of a tree of policies. The work of the tree is the sum of
 * the work of its parts. A binding of the whole tree, as the Schema does,
 * counts the work on a pattern or a test that two parts share one time, so
 * it is never more. So a tree that this makes is a tree that the Schema
 * takes. A binding of the whole tree here would bind each part again for
 * each level of a deep tree.
 */
const fromParts = (
	policies: ReadonlyArray<Any>,
	node: PolicyNodes.Node,
): any => {
	const domain = sameDomain(policies)
	const work = Arr.reduce(
		policies,
		0,
		(total, policy) => total + PolicyData.workOf(policy),
	)
	const most = domain.limits.searchSteps
	if (work > most) {
		const message = Bind.workIssue(most)
		throw PolicyError.make({ issues: [{ path: [], message }], message })
	}
	return fromNode(domain, node, work)
}

// The constructors of the nodes stop a tree past `policyDepth` or
// `policyNodes`.
export const combine =
	(tag: "All" | "Any" | "FirstOf") =>
	(policies: ReadonlyArray<Any>): any =>
		fromParts(policies, new PolicyNodes[tag](Arr.map(policies, nodeOf)))

/** Puts a limit on a policy. A deny from `cap` always wins. */
export const ceiling = dual(2, (policy: Any, cap: Any): any =>
	fromParts(
		[policy, cap],
		new PolicyNodes.Ceiling({ cap: nodeOf(cap), policy: nodeOf(policy) }),
	),
)

/**
 * Gives the services to the predicates of a tree. A node with none stays. The
 * conditions get the services first, from a flat list of the rules, so the
 * walk does not go down the levels of the tree and of a condition at once.
 */
const provideNode = (
	root: PolicyNodes.Node,
	context: Context.Context<never>,
): PolicyNodes.Node => {
	// A native map, because it must find a rule by the rule itself: two rules
	// with the same data are `Equal`.
	const provided = new Map<RuleData.Rule, RuleData.Rule>(
		Arr.map(PolicyNodes.rulesOf(root), (value) => [
			value,
			value.when === undefined || !Nodes.toNode(value.when).opaque
				? value
				: RuleData.make({
						...value,
						when: Condition.provideContext(
							value.when as Condition.Any,
							context as never,
						),
					}),
		]),
	)
	// The walk of the tree takes the steps of a trampoline, so a deep tree
	// does not fill the stack.
	return Trampoline.run(root.depth, (R) => {
		const provide = (
			node: PolicyNodes.Node,
		): Trampoline.Step<PolicyNodes.Node> => {
			if (!node.opaque) {
				return R.succeed(node)
			}
			switch (node._tag) {
				case "Rules":
					return R.succeed(
						new PolicyNodes.Rules({
							algorithm: node.algorithm,
							rules: Arr.map(
								node.rules,
								(value) => provided.get(value) ?? value,
							),
						}),
					)
				case "All":
				case "Any":
				case "FirstOf": {
					const tag = node._tag
					return R.map(
						R.forEach(node.policies, (child) =>
							R.suspend(() => provide(child)),
						),
						(policies) => new PolicyNodes[tag](policies),
					)
				}
				case "Ceiling":
					return R.flatMap(
						R.suspend(() => provide(node.cap)),
						(cap) =>
							R.map(
								R.suspend(() => provide(node.policy)),
								(policy) => new PolicyNodes.Ceiling({ cap, policy }),
							),
					)
			}
		}
		return provide(root)
	})
}

/** Gives the services in `context` to every predicate of a policy. */
export const provideContext = dual(
	2,
	(policy: Any, context: Context.Context<never>): any =>
		fromNode(
			policy.domain,
			provideNode(nodeOf(policy), context),
			PolicyData.workOf(policy),
		),
)

/** Tests if a value is a policy. */
export const isPolicy = (u: unknown): u is Any => PolicyData.is(u)

/**
 * The Schema of the policies of a domain with no predicates. A decoded policy
 * is bound to the domain. A policy value was bound when it was made, so it
 * is not bound again when it is encoded.
 */
export const schema = (domain: Domain.Any): Schema.Top => {
	// A policy with a predicate is not a plain policy, and it can not become
	// JSON.
	const Plain = Schema.declare(
		(u): u is Any => isPolicy(u) && u.domain === domain && !nodeOf(u).opaque,
	)
	return Schema.Unknown.pipe(
		Schema.decodeTo(
			Plain,
			SchemaTransformation.transformEffect({
				decode: (input: unknown, options) =>
					PolicyJson.decode(input, domain).pipe(
						Effect.mapError(
							(problem) =>
								new SchemaIssue.Pointer(
									problem.path,
									problem.issue ??
										new SchemaIssue.InvalidValue(
											{ message: problem.message },
											input,
											options,
										),
								),
						),
						Effect.flatMap((node) => {
							const { issues, work } = Bind.treeIssues(domain, node)
							// The issues, as a filter of the Schema gives them.
							const pointers = Arr.map(
								issues,
								(found) =>
									new SchemaIssue.Pointer(
										found.path,
										new SchemaIssue.InvalidValue(
											{ message: found.issue },
											input,
											options,
										),
									),
							)
							const issue = Arr.isReadonlyArrayNonEmpty(pointers)
								? pointers.length === 1
									? pointers[0]
									: new SchemaIssue.Composite(
											Plain.ast,
											pointers,
											input,
											options,
										)
								: undefined
							return issue === undefined
								? Effect.succeed(fromNode(domain, node, work))
								: Effect.fail(issue)
						}),
					),
				encode: (policy: Any) =>
					Effect.mapError(
						PolicyJson.encode(nodeOf(policy), domain.meta),
						(error) => error.issue,
					),
			}),
		),
	) as never
}
