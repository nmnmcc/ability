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
import * as Result from "effect/Result"
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

	toJSON(): unknown {
		return PolicyJson.toJson(this.node, this.domain.meta)
	}

	/** Tests if a value is a policy, by its private field. */
	static is(u: unknown): u is Any {
		return typeof u === "object" && u !== null && #policy in u
	}
}

/** The node of a policy, with no types, for the code below. */
export const nodeOf = (policy: Any): PolicyNodes.Node => policy.node as never

export const fromNode = (domain: Domain.Any, node: PolicyNodes.Node): any =>
	new PolicyData({ domain, node })

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
	const issues = Arr.flatMap(node.rules, (value, index) =>
		Bind.ruleIssues(domain, value, ["rules", index]),
	)
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
	return fromNode(domain, node)
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

// The constructors of the nodes stop a tree past `policyDepth` or
// `policyNodes`.
export const combine =
	(tag: "All" | "Any" | "FirstOf") =>
	(policies: ReadonlyArray<Any>): any =>
		fromNode(
			sameDomain(policies),
			new PolicyNodes[tag](Arr.map(policies, nodeOf)),
		)

/** Puts a limit on a policy. A deny from `cap` always wins. */
export const ceiling = dual(2, (policy: Any, cap: Any): any =>
	fromNode(
		sameDomain([policy, cap]),
		new PolicyNodes.Ceiling({ cap: nodeOf(cap), policy: nodeOf(policy) }),
	),
)

/** Gives the services to the predicates of a tree. A node with none stays. */
const provideNode = (
	node: PolicyNodes.Node,
	context: Context.Context<never>,
): PolicyNodes.Node => {
	if (!node.opaque) {
		return node
	}
	const provide = (child: PolicyNodes.Node) => provideNode(child, context)
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
			return new PolicyNodes[node._tag](Arr.map(node.policies, provide))
		case "Ceiling":
			return new PolicyNodes.Ceiling({
				cap: provide(node.cap),
				policy: provide(node.policy),
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

/** The Schema of the policies of a domain with no predicates. */
export const schema = (domain: Domain.Any): Schema.Top =>
	Schema.Unknown.pipe(
		Schema.decodeTo(
			// A policy with a predicate is not a plain policy, and it can not
			// become JSON.
			Schema.declare(
				(u): u is Any =>
					isPolicy(u) && u.domain === domain && !nodeOf(u).opaque,
			).check(
				Schema.makeFilter((policy) => Bind.treeIssues(domain, nodeOf(policy))),
			),
			SchemaTransformation.transformEffect({
				decode: (input: unknown, options) =>
					Result.match(PolicyJson.decode(input, domain), {
						onSuccess: (node) => Effect.succeed(fromNode(domain, node)),
						onFailure: (problem) =>
							Effect.fail(
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
					}),
				encode: (policy: Any) =>
					Effect.sync(() => PolicyJson.toJson(nodeOf(policy), domain.meta)),
			}),
		),
	) as never
