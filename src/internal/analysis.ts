/**
 * The residual conditions and the coverage of a policy. The types are in
 * `Policy.ts`.
 */
// A policy keeps the error type and the service type of its predicates in the
// public types. The code below works on the nodes with no types, where they
// are `unknown`, so the language service check for `unknown` in an Effect is
// off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Data from "effect/Data"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Condition from "../Condition.ts"
import * as Decision from "../Decision.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import type * as Resource from "../Resource.ts"
import * as Algebra from "./algebra.ts"
import * as Bind from "./bind.ts"
import type * as Catalog from "./catalog.ts"
import { decideNode, fitsKind } from "./decide.ts"
import * as DomainData from "./domain.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as PolicyNodes from "./policy-nodes.ts"
import { nodeOf } from "./policy.ts"
import * as ResourceData from "./resource.ts"
import * as RuleData from "./rule.ts"
import * as Search from "./search.ts"

type Any = Policy.Any

type Ast = Condition.Ast

const always: Ast = Condition.always
const never: Ast = Condition.never

/**
 * Makes conditions for one residual, with no types. Each step makes the
 * condition simple, and it stops the work when the condition has more nodes
 * than `residualNodes`. A policy tree may use a condition of a child two
 * times, in its allow condition and in its deny condition, so a small policy
 * may give a very large condition.
 */
interface Build {
	// A list goes in as an array, not as arguments: a call may take only so
	// many arguments, and a policy may have more rules.
	readonly and: (values: ReadonlyArray<Ast>) => Ast
	readonly or: (values: ReadonlyArray<Ast>) => Ast
	readonly not: (value: Ast) => Ast
}

const limit = (node: Nodes.Node): Ast => {
	if (node.size > Limits.residualNodes) {
		throw Limits.exceeded(
			"A residual condition",
			"residualNodes",
			"nodes",
			node.size,
			Limits.residualNodes,
		)
	}
	return node
}

const build: Build = {
	and: (values) => limit(Algebra.and(values as ReadonlyArray<Nodes.Node>)),
	or: (values) => limit(Algebra.or(values as ReadonlyArray<Nodes.Node>)),
	not: (value) => (value as Nodes.Node).pipe(Algebra.not, limit),
}

/** The two residual conditions of a node, with no types. */
interface Pair {
	readonly allow: Ast
	readonly deny: Ast
}

interface ResidualContext {
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly input: {
		readonly principal: object
		readonly path: Condition.Input["path"]
	}
	/** The resource of the kind, for the fields that a rule may grant. */
	readonly descriptor: Resource.Descriptor
	/** The test of `RuleData.fitsOf` for the catalog, for this request. */
	readonly fits: (pattern: string) => boolean
	/**
	 * The condition of each rule, with the principal in it. They are made
	 * first, from a flat list of the rules, so the walk does not go down the
	 * levels of the tree and of a condition at once. It is a native map,
	 * because it must find a rule by the rule itself: two rules with the same
	 * data are `Equal`.
	 */
	readonly conditions: Map<RuleData.Rule, Ast>
}

const makeCondition = (
	value: RuleData.Rule,
	context: Omit<ResidualContext, "conditions">,
): Ast =>
	!RuleData.matchesTarget(value, context)
		? never
		: value.when === undefined
			? always
			: Condition.partial(value.when as Condition.Any, context.input)

const ruleCondition = (value: RuleData.Rule, context: ResidualContext): Ast =>
	context.conditions.get(value) ?? makeCondition(value, context)

/**
 * Gives the conditions for "the first rule that applies is an allow rule" and
 * "the first rule that applies is a deny rule".
 */
const firstApplicableResidual = (
	values: ReadonlyArray<RuleData.Rule>,
	context: ResidualContext,
): Pair => {
	const { and, not, or } = build
	// The rules go in runs of one tag, from the last run to the first. The
	// conditions of a run go into one node at once. With one node for each
	// rule, each step would flatten the whole condition again.
	const runs = Arr.isReadonlyArrayNonEmpty(values)
		? Arr.groupWith(values, (a, b) => a._tag === b._tag)
		: []
	return Arr.reduceRight(
		runs,
		{ allow: never, deny: never },
		(rest: Pair, run): Pair => {
			const applies = or(Arr.map(run, (value) => ruleCondition(value, context)))
			return run[0]._tag === "Allow"
				? {
						allow: or([applies, rest.allow]),
						deny: and([not(applies), rest.deny]),
					}
				: {
						allow: and([not(applies), rest.allow]),
						deny: or([applies, rest.deny]),
					}
		},
	)
}

/**
 * Gives the residual pair of a node. A shared child is worked again for each
 * place. The limits of the nodes and of a residual keep this work small.
 */
const residualNode = (
	node: PolicyNodes.Node,
	context: ResidualContext,
): Pair => {
	const { and, not, or } = build
	switch (node._tag) {
		case "Rules": {
			switch (node.algorithm) {
				case "denyOverrides": {
					const deny = or(
						node.rules
							.filter((value) => value._tag === "Deny")
							.map((value) => ruleCondition(value, context)),
					)
					const allow = and([
						not(deny),
						or(
							node.rules
								.filter((value) => value._tag === "Allow")
								.map((value) => ruleCondition(value, context)),
						),
					])
					return { allow, deny }
				}
				case "permitOverrides": {
					const allow = or(
						node.rules
							.filter((value) => value._tag === "Allow")
							.map((value) => ruleCondition(value, context)),
					)
					const deny = and([
						not(allow),
						or(
							node.rules
								.filter((value) => value._tag === "Deny")
								.map((value) => ruleCondition(value, context)),
						),
					])
					return { allow, deny }
				}
				case "firstApplicable":
					return firstApplicableResidual(node.rules, context)
				case "lastApplicable":
					return firstApplicableResidual(node.rules.slice().reverse(), context)
			}
		}
		// falls through: every algorithm returns above
		case "All": {
			if (node.policies.length === 0) {
				return { allow: never, deny: never }
			}
			const pairs = node.policies.map((child) => residualNode(child, context))
			const deny = or(pairs.map((pair) => pair.deny))
			const allow = and([...pairs.map((pair) => pair.allow), not(deny)])
			return { allow, deny }
		}
		case "Any": {
			const pairs = node.policies.map((child) => residualNode(child, context))
			const allow = or(pairs.map((pair) => pair.allow))
			const deny = and([not(allow), or(pairs.map((pair) => pair.deny))])
			return { allow, deny }
		}
		case "FirstOf": {
			// The first child that gives an answer wins.
			return Arr.reduceRight(
				node.policies,
				{ allow: never, deny: never },
				(rest: Pair, child): Pair => {
					const pair = residualNode(child, context)
					return {
						allow: or([pair.allow, and([not(pair.deny), rest.allow])]),
						deny: or([pair.deny, and([not(pair.allow), rest.deny])]),
					}
				},
			)
		}
		case "Ceiling": {
			const cap = residualNode(node.cap, context)
			const inner = residualNode(node.policy, context)
			return {
				allow: and([not(cap.deny), inner.allow]),
				deny: or([cap.deny, inner.deny]),
			}
		}
	}
}

/** The name of the predicate of a residual condition that runs `decide`. */
const policyPredicate = "policy"

/** What {@link usesPredicate} needs: the request. */
interface PredicateContext {
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly descriptor: Resource.Descriptor
	readonly fits: (pattern: string) => boolean
}

/** Tests if a rule that the request may use has a predicate. */
const usesPredicate = (
	node: PolicyNodes.Node,
	context: PredicateContext,
): boolean => {
	if (!node.opaque) {
		return false
	}
	switch (node._tag) {
		case "Rules":
			return node.rules.some(
				(value) =>
					value.when !== undefined &&
					Nodes.toNode(value.when).opaque &&
					RuleData.matchesTarget(value, context),
			)
		case "All":
		case "Any":
		case "FirstOf":
			return node.policies.some((child) => usesPredicate(child, context))
		case "Ceiling":
			return (
				usesPredicate(node.cap, context) || usesPredicate(node.policy, context)
			)
	}
}

/**
 * Makes the scope of a request, with the principal in it. A scope comes from
 * code, so a scope that does not fit the domain is a defect. It is bound as a
 * rule for the kind and the action of the request is.
 */
const scopeOf = (
	request: ScopedRequest,
	domain: Domain.Any,
	input: ResidualContext["input"],
): Ast => {
	if (request.within === undefined) {
		return always
	}
	// The builder stops a value that a condition can not hold, such as
	// `undefined` from a route parameter. A predicate could make a check pass
	// on the wrong values, so a scope with one is a defect too.
	const ast = (request.within as (builder: unknown) => Ast)(Condition.builder())
	if (Nodes.toNode(ast).opaque) {
		throw new globalThis.Error("A scope can not have a predicate")
	}
	const issues = Bind.ruleIssues(
		domain,
		{ actions: [request.action], resources: [request.kind], when: ast },
		["within"],
	)
	if (issues.length > 0) {
		throw new globalThis.Error(
			`A scope does not fit the domain: ${issues.map((issue) => issue.issue).join("; ")}`,
		)
	}
	return Condition.partial(ast as Condition.Condition, input)
}

/** A request about a kind with no types, with the scope of a target. */
export interface ScopedRequest {
	readonly principal: object
	readonly action: string
	readonly kind: string
	readonly field?: string | undefined
	readonly within?: unknown
}

/** The scope of a request, and the residual conditions inside it. */
interface Scoped extends Pair {
	readonly scope: Ast
	/** The catalog of the kind, when the request fits the kind. */
	readonly catalog: Catalog.Catalog | undefined
}

export const residualsAny = (policy: Any, request: ScopedRequest): Pair =>
	scopedResiduals(policy, request)

const scopedResiduals = (policy: Any, request: ScopedRequest): Scoped => {
	const descriptor = DomainData.descriptorOf(policy.domain, request.kind)
	if (descriptor === undefined || !fitsKind(descriptor, request)) {
		return { scope: never, allow: never, deny: never, catalog: undefined }
	}
	const input = { principal: request.principal, path: descriptor.path }
	const scope = scopeOf(request, policy.domain, input)
	const and = build.and
	const inScope = (pair: Pair): Scoped => ({
		scope,
		allow: and([scope, pair.allow]),
		deny: and([scope, pair.deny]),
		catalog: descriptor.catalog,
	})
	if (scope._tag === "False") {
		return inScope({ allow: never, deny: never })
	}
	const target = {
		action: request.action,
		kind: request.kind,
		field: request.field,
		input,
		descriptor,
		fits: RuleData.fitsOf(descriptor.catalog),
	}
	const context: ResidualContext = {
		...target,
		conditions: new Map(
			Arr.map(policy.pipe(nodeOf, PolicyNodes.rulesOf), (value) => [
				value,
				makeCondition(value, target),
			]),
		),
	}
	// The type of the residual of a plain policy says that it has no
	// predicate, so it can not be the predicate below. A residual past the
	// limit is a defect.
	if (!usesPredicate(nodeOf(policy), context)) {
		return inScope(residualNode(nodeOf(policy), context))
	}
	// A predicate may fail, and it may give another answer each time it runs.
	// A tree of `And` and `Or` nodes can not run the predicates in the same
	// order and the same number of times as `decide`. So the residual is one
	// predicate that runs `decide` for each value.
	const decision = (value: object) =>
		decideNode(
			nodeOf(policy),
			{
				action: request.action,
				kind: request.kind,
				field: request.field,
				input: {
					value,
					principal: request.principal,
					path: descriptor.path,
				},
				descriptor,
				fits: RuleData.fitsOf(descriptor.catalog),
				trace: undefined,
			},
			[],
		)
	// A value of another kind is not a value that the residual is about, so
	// the rules of this kind must not run on it.
	const test = (tag: Decision.Decision["_tag"]): Ast =>
		Condition.builder<any, any, any>().predicate(policyPredicate, (value) =>
			ResourceData.kindOf(value) === request.kind
				? Effect.map(decision(value), (result) => result._tag === tag)
				: Effect.succeed(false),
		)
	// The scope comes first in each `And`, so the policy runs only on values
	// in the scope.
	return inScope({ allow: test("Allow"), deny: test("Deny") })
}

/** Gives the condition on resource values for which the policy allows. */
export const residual = (policy: Any, request: ScopedRequest): Ast =>
	residualsAny(policy, request).allow

/** A {@link Policy.Coverage} with no types. */
export type AnyCoverage = Data.TaggedEnum<{
	All: { readonly condition: Ast }
	None: { readonly condition: Ast }
	Some: {
		readonly condition: Ast
		readonly allowed: Condition.Example
		readonly refused: Condition.Example
	}
	Unknown: {
		readonly condition: Ast
		readonly reason: "predicate" | "budget"
	}
}>

const coverages = Data.taggedEnum<AnyCoverage>()

/** Searches for a value of the kind of a scope that makes a condition true. */
const search = (scoped: Scoped, ast: Ast): Condition.Satisfiability =>
	Search.satisfiable(ast as Nodes.Node, Search.kindsIn(scoped.catalog))

/** The values in the scope that the policy does not allow. */
const refusedOf = (scoped: Scoped): Ast =>
	// Only two nodes more than the residual, so it needs no size limit.
	Algebra.and([
		scoped.scope as Nodes.Node,
		Algebra.not(scoped.allow as Nodes.Node),
	])

export const coverageAny = (
	policy: Any,
	request: ScopedRequest,
): AnyCoverage => {
	const scoped = scopedResiduals(policy, request)
	const allowed = scoped.allow
	const some = search(scoped, allowed)
	if (some._tag === "Unsatisfiable") {
		return coverages.None({ condition: never })
	}
	if (some._tag === "Unknown") {
		return coverages.Unknown({ condition: allowed, reason: some.reason })
	}
	const missing = search(scoped, refusedOf(scoped))
	if (missing._tag === "Unsatisfiable") {
		return coverages.All({ condition: scoped.scope })
	}
	if (missing._tag === "Unknown") {
		return coverages.Unknown({ condition: allowed, reason: missing.reason })
	}
	return coverages.Some({
		condition: allowed,
		allowed: some.example,
		refused: missing.example,
	})
}

/** Decides a request about every value in a scope. */
export const decideKind = (
	policy: Any,
	request: ScopedRequest,
): Decision.Decision => {
	const scoped = scopedResiduals(policy, request)
	const missing = search(scoped, refusedOf(scoped))
	switch (missing._tag) {
		case "Unknown":
			return Decision.Deny({})
		case "Unsatisfiable":
			return search(scoped, scoped.scope)._tag === "Satisfiable"
				? Decision.Allow({})
				: Decision.Deny({})
		case "Satisfiable":
			// A refused value is in the scope, so the scope has a value.
			return search(scoped, scoped.deny)._tag === "Unsatisfiable"
				? Decision.NotApplicable
				: Decision.Deny({})
	}
}
