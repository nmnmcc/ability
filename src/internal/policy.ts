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
import * as Nodes from "./nodes.ts"
import * as PolicyJson from "./policy-json.ts"
import * as PolicyNodes from "./policy-nodes.ts"
import * as RuleData from "./rule.ts"

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
	/** Only in the types. */
	declare readonly "~Opaque": () => X
	/**
	 * Only in the types. A policy reads the values and the principal of its
	 * domain, so a policy of one domain is not a policy of a wider domain.
	 */
	declare readonly "~Domain": (domain: D) => D

	/** Tests if a value is a policy, by its private field. */
	static is(u: unknown): u is Any {
		return typeof u === "object" && u !== null && #policy in u
	}
}

/** The node of a policy, with no types, for the code below. */
export const nodeOf = (policy: Any): PolicyNodes.Node => policy.node as never

/** Makes a policy from a tree of checked nodes. */
const fromNode = (domain: Domain.Any, node: PolicyNodes.Node): any =>
	new PolicyData({ domain, node })

/** Makes a policy from a list of rules, and binds them to the domain. */
const fromRules = (
	domain: Domain.Any,
	values: ReadonlyArray<RuleData.Rule>,
	makeError: typeof Policy.PolicyError.make,
	options?: Options,
): Any => {
	// The constructor takes only rules.
	const node = new PolicyNodes.Rules({
		algorithm: options?.algorithm ?? "denyOverrides",
		rules: values,
	})
	// A rule from a builder of another domain is a mistake in the code, so it
	// is a defect. Two domains may have the same types, so the types do not
	// find it.
	if (
		Arr.some(node.rules, (value) => {
			const origin = value.domain
			return origin !== domain
		})
	) {
		throw new globalThis.Error(
			"A rule comes from the builder of another domain",
		)
	}
	// Bind once at the entry to the domain.
	const issues = Bind.treeIssues(domain, node)
	if (issues.length > 0) {
		throw makeError({
			issues: Arr.map(issues, (issue) => ({
				path: Arr.map(issue.path, (part) =>
					typeof part === "number" ? part : String(part),
				),
				message: issue.issue,
			})),
			message: `A rule does not fit the domain: ${issues.map((issue) => issue.issue).join("; ")}`,
		})
	}
	return fromNode(domain, node)
}

/**
 * Makes a policy from a generator function that gives rules. The public module
 * gives its error constructor here to avoid a runtime import cycle.
 */
export const define =
	(
		domain: Domain.Any,
		makeError: typeof Policy.PolicyError.make,
		options?: Options,
	) =>
	(body: (builder: unknown) => Generator<unknown, unknown, unknown>): Any => {
		const iterator = body(RuleData.builder(domain))
		// Each rule goes back into the generator, as `yield*` gives it.
		const collected = Arr.unfold(iterator.next(), (result) => {
			if (result.done === true) return Option.none()
			if (!RuleData.isRule(result.value)) {
				iterator.return(undefined)
				throw new globalThis.Error("A policy generator must give rules")
			}

			return Option.some([result.value, iterator.next(result.value)] as const)
		})
		return fromRules(domain, collected, makeError, options) as never
	}

const sameDomain = (policies: ReadonlyArray<Any>): Domain.Any => {
	// A copy of a policy made with a spread may keep the type fields of another
	// policy. Only a policy value goes into a tree.
	if (!Arr.every(policies, isPolicy)) {
		throw new globalThis.Error("A value in the list is not a policy")
	}
	const first = policies[0]
	if (first === undefined)
		throw new globalThis.Error("A list of policies must have a policy")
	const domain = first.domain
	if (!Arr.every(policies, (policy) => policy.domain === domain)) {
		throw new globalThis.Error(
			"Policies from two domains can not be put together",
		)
	}
	return domain
}

/** Reuses the bound trees of policies from the same domain. */
const fromParts = (policies: ReadonlyArray<Any>, node: PolicyNodes.Node): any =>
	fromNode(sameDomain(policies), node)

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

/** Gives services to every predicate. Plain nodes are reused. */
const provideNode = (
	node: PolicyNodes.Node,
	context: Context.Context<never>,
): PolicyNodes.Node => {
	if (!node.opaque) return node
	switch (node._tag) {
		case "Rules":
			return new PolicyNodes.Rules({
				algorithm: node.algorithm,
				rules: Arr.map(node.rules, (value) =>
					value.when === undefined || !Nodes.toNode(value.when).opaque
						? value
						: RuleData.make({
								...value,
								when: Condition.provideContext(
									value.when as Condition.Any,
									context as never,
								),
							}),
				),
			})
		case "All":
		case "Any":
		case "FirstOf":
			return new PolicyNodes[node._tag](
				Arr.map(node.policies, (child) => provideNode(child, context)),
			)
		case "Ceiling":
			return new PolicyNodes.Ceiling({
				cap: provideNode(node.cap, context),
				policy: provideNode(node.policy, context),
			})
	}
}

/** Gives the services in `context` to every predicate of a policy. */
export const provideContext = dual(
	2,
	(policy: Any, context: Context.Context<never>): any =>
		fromNode(policy.domain, provideNode(nodeOf(policy), context)),
)

/** Tests if a value is a policy. */
export const isPolicy = (u: unknown): u is Any => PolicyData.is(u)

/**
 * The Schema of the policies of a domain with no predicates. A decoded policy
 * is bound to the domain. A policy value was bound when it was made, so it
 * is not bound again when it is encoded.
 */
export const schema = (domain: Domain.Any): Schema.Top => {
	const Plain = Schema.declare(
		(u): u is Any => isPolicy(u) && u.domain === domain && !nodeOf(u).opaque,
	)
	return Schema.String.pipe(
		Schema.decodeTo(
			Plain,
			SchemaTransformation.transformEffect({
				decode: (input: string, options) =>
					PolicyJson.decode(input, domain).pipe(
						Effect.mapError(
							(problem) =>
								new SchemaIssue.Pointer(
									problem.path,
									new SchemaIssue.InvalidValue(
										{ message: problem.message },
										input,
										options,
									),
								),
						),
						Effect.flatMap((node) => {
							const issue = Bind.treeIssues(domain, node)[0]
							return issue === undefined
								? Effect.succeed(fromNode(domain, node))
								: Effect.fail(
										new SchemaIssue.Pointer(
											issue.path,
											new SchemaIssue.InvalidValue(
												{ message: issue.issue },
												input,
												options,
											),
										),
									)
						}),
					),
				encode: (policy: Any, options) =>
					policy.pipe(
						nodeOf,
						PolicyJson.encode,
						Effect.mapError(
							(problem) =>
								new SchemaIssue.Pointer(
									problem.path,
									new SchemaIssue.InvalidValue(
										{ message: problem.message },
										policy,
										options,
									),
								),
						),
					),
			}),
		),
	) as never
}
