/**
 * A policy is a tree that gives a {@link Decision.Decision} for a request.
 *
 * The leaves of the tree are lists of rules. A combining algorithm decides
 * which rule gives the answer when more than one rule applies:
 * - `denyOverrides` (the default): a deny rule wins over every allow rule.
 * - `permitOverrides`: an allow rule wins over every deny rule.
 * - `firstApplicable`: the first rule that applies wins.
 * - `lastApplicable`: the last rule that applies wins.
 *
 * The branches put policies together:
 * - {@link all}: every policy must allow, and one deny is enough to deny. Use
 *   it when a user token may never do more than its user.
 * - {@link any}: one allow is enough.
 * - {@link firstOf}: the first policy that gives an answer wins. Use it for
 *   grants first, then rules.
 * - {@link ceiling}: the deny rules of a second policy are a limit for
 *   everyone. Its allow rules do nothing.
 *
 * A policy gives three kinds of answers:
 * - {@link decide}: the decision for one resource value.
 * - {@link residual}: a condition on resource values. A value passes when the
 *   policy allows the request for that value. Use it to make a database
 *   query, or to ask "may this principal do this act on some resource of
 *   this kind?"
 * - {@link permittedFields}: the fields that the policy lets a request use.
 *
 * Each of them also takes the request first and the policy later. In a `pipe`,
 * the policy gives the domain. Outside a `pipe`, give the domain by hand, as
 * in `Policy.decide<typeof App>(request)`. Without it the request has the type
 * `never`, so TypeScript can still check it.
 *
 * A policy without predicates can become JSON with {@link schema}.
 *
 * @stability stable
 * @since 0.3.0
 */
// A policy keeps the error type and the service type of its predicates in the
// public types. The code below works on the nodes with no types, where they
// are `unknown`, so the language service check for `unknown` in an Effect is
// off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import type * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type * as Pipeable from "effect/Pipeable"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Condition from "./Condition.ts"
import * as Decision from "./Decision.ts"
import type * as Domain from "./Domain.ts"
import * as Resource from "./Resource.ts"
import * as Rule from "./Rule.ts"

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Algorithm =
	"denyOverrides" | "permitOverrides" | "firstApplicable" | "lastApplicable"

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface RulesNode {
	readonly _tag: "Rules"
	readonly algorithm: Algorithm
	readonly rules: ReadonlyArray<Rule.Any>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface AllNode {
	readonly _tag: "All"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface AnyNode {
	readonly _tag: "Any"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface FirstOfNode {
	readonly _tag: "FirstOf"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface CeilingNode {
	readonly _tag: "Ceiling"
	readonly cap: Node
	readonly policy: Node
}

/**
 * The nodes of a policy tree.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Node = RulesNode | AllNode | AnyNode | FirstOfNode | CeilingNode

/**
 * A policy for the domain `D`. `E`, `R` and `O` come from the conditions of
 * its rules. See `Condition.Condition`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Policy<D extends Domain.Any, E = never, R = never, O = never>
	extends Pipeable.Pipeable {
	readonly domain: D
	readonly node: Node
	readonly "~Policy"?: Condition.Variance<E, R, O>
}

/**
 * Any policy.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Policy<any, any, any, any>

/**
 * The domain of a policy.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DomainOf<P> = P extends Policy<infer D, any, any, any> ? D : never

/**
 * The error type of a policy.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Error<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a policy.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type Services<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * `Condition.Opaque` when a policy has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer _E, infer _R, infer O>
}
	? O
	: never

/**
 * One act on one resource value, for each kind of the domain. The action must
 * be an action of the kind, and the field must be a field of the kind.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Target<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly resource: Domain.ValueOf<D, K>
		readonly field?: Condition.FieldPath<Domain.DataOf<D, K>>
	}
}[Domain.Kind<D>]

/**
 * A {@link Target} with no field. Each kind keeps its own actions.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FieldlessTarget<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly resource: Domain.ValueOf<D, K>
	}
}[Domain.Kind<D>]

/**
 * One act on one kind of resource, with no value.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type KindTarget<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly kind: K
		readonly field?: Condition.FieldPath<Domain.DataOf<D, K>>
	}
}[Domain.Kind<D>]

/**
 * A request: a principal, an action, and a resource value.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Request<D> = Target<D> & { readonly principal: Domain.Principal<D> }

/**
 * A {@link Request} with no field.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FieldlessRequest<D> = FieldlessTarget<D> & {
	readonly principal: Domain.Principal<D>
}

/**
 * A request about a kind of resource, with no value.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type KindRequest<D> = KindTarget<D> & {
	readonly principal: Domain.Principal<D>
}

/**
 * A request with no types.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface AnyRequest {
	readonly principal: object
	readonly action: string
	readonly resource: object
	readonly field?: string | undefined
}

/**
 * One rule that a decision tested. `path` gives the place of the rule in the
 * policy tree: the index of each child, then the index of the rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Step {
	readonly path: ReadonlyArray<number>
	readonly rule: Rule.Any
	readonly applies: boolean
}

/**
 * A decision, and the rules that were tested to make it, in order. Keep it in
 * an audit log.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Explanation {
	readonly decision: Decision.Decision
	readonly steps: ReadonlyArray<Step>
}

/**
 * The options of a list of rules.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Options {
	/** The default is `denyOverrides`. */
	readonly algorithm?: Algorithm
}

const nodes = Data.taggedEnum<Node>()

const encodeNode = (node: Node): EncodedNode => {
	switch (node._tag) {
		case "Rules":
			return {
				_tag: "Rules",
				algorithm: node.algorithm,
				rules: node.rules.map((value) => ({ ...value }) as EncodedRule),
			}
		case "All":
		case "Any":
		case "FirstOf":
			return { _tag: node._tag, policies: node.policies.map(encodeNode) }
		case "Ceiling":
			return {
				_tag: "Ceiling",
				cap: encodeNode(node.cap),
				policy: encodeNode(node.policy),
			}
	}
}

/**
 * The class of every policy value. Two policies of one domain with the same
 * tree are equal. As JSON, a policy is its tree.
 */
class PolicyData extends Data.Class<{
	readonly domain: Domain.Any
	readonly node: Node
}> {
	toJSON(): unknown {
		return encodeNode(this.node)
	}
}

const fromNode = (domain: Domain.Any, node: Node): any =>
	new PolicyData({ domain, node })

/**
 * Makes a policy from a list of rules.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const rules: <D extends Domain.Any, Rules extends Rule.Any>(
	domain: D,
	rules: Iterable<Rules>,
	options?: Options,
) => Policy<
	D,
	Rule.Error<Rules>,
	Rule.Services<Rules>,
	Rule.OpaqueOf<Rules>
> = (domain, values, options) => {
	const node = nodes.Rules({
		algorithm: options?.algorithm ?? "denyOverrides",
		rules: Array.from(values),
	})
	// A rule does not keep its domain in its type, so a rule of another domain
	// can come here. Such a rule is a mistake in the code, so it is a defect.
	const issues = validate(domain, encodeNode(node))
	if (issues.length > 0) {
		throw new globalThis.Error(
			`A rule does not fit the domain: ${issues.map((issue) => issue.issue).join("; ")}`,
		)
	}
	return fromNode(domain, node)
}

/**
 * Makes a policy from a generator function that gives rules. It is pure and it
 * gives its result at once.
 *
 * @example
 * ```ts
 * const policy = Policy.define(App)(function* (_) {
 *   yield* _.allow("read", Bot)
 *   yield* _.allow(["update", "delete"], Bot, {
 *     when: ($) => $.eq("ownerUserId", $.principal("userId")),
 *   })
 * })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const define =
	<D extends Domain.Any>(domain: D, options?: Options) =>
	<Rules extends Rule.Any, A>(
		body: (builder: Rule.Builder<D>) => Generator<Rules, A, unknown>,
	): Policy<
		D,
		Rule.Error<Rules>,
		Rule.Services<Rules>,
		Rule.OpaqueOf<Rules>
	> => {
		const collected: Array<Rules> = []
		const iterator = body(Rule.builder(domain))
		let state = iterator.next()
		while (state.done !== true) {
			collected.push(state.value)
			state = iterator.next(state.value)
		}
		return rules(domain, collected, options)
	}

/**
 * A policy with no rules. It is not applicable to any request.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const empty = <D extends Domain.Any>(domain: D): Policy<D> =>
	rules(domain, [])

type Combined<D extends Domain.Any, Ps extends ReadonlyArray<Any>> = Policy<
	D,
	Error<Ps[number]>,
	Services<Ps[number]>,
	OpaqueOf<Ps[number]>
>

const sameDomain = (policies: ReadonlyArray<Any>): Domain.Any => {
	const domain = policies[0]!.domain
	for (const policy of policies) {
		if (policy.domain !== domain) {
			throw new globalThis.Error(
				"Policies from two domains can not be put together",
			)
		}
	}
	return domain
}

const combine =
	(tag: "All" | "Any" | "FirstOf") =>
	(policies: ReadonlyArray<Any>): any =>
		fromNode(
			sameDomain(policies),
			nodes[tag]({ policies: policies.map((policy) => policy.node) }),
		)

/**
 * Every policy must allow, and one deny is enough to deny. With some policies
 * not applicable and none that deny, the result is not applicable.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const all: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = combine("All")

/**
 * One allow is enough. Without an allow, one deny gives a deny.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const any: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = combine("Any")

/**
 * The first policy that allows or denies gives the answer.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const firstOf: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = combine("FirstOf")

/**
 * Puts a limit on a policy. A deny from `cap` always wins. An allow from `cap`
 * does nothing.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const ceiling: {
	<D extends Domain.Any, E2, R2, O2>(
		cap: Policy<D, E2, R2, O2>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Policy<D, E | E2, R | R2, O | O2>
	<D extends Domain.Any, E, R, O, E2, R2, O2>(
		policy: Policy<D, E, R, O>,
		cap: Policy<D, E2, R2, O2>,
	): Policy<D, E | E2, R | R2, O | O2>
} = dual(2, (policy: Any, cap: Any): any =>
	fromNode(
		sameDomain([policy, cap]),
		nodes.Ceiling({ cap: cap.node, policy: policy.node }),
	),
)

const provideNode = (node: Node, context: Context.Context<never>): Node => {
	switch (node._tag) {
		case "Rules":
			return nodes.Rules({
				algorithm: node.algorithm,
				rules: node.rules.map((value) =>
					value.when === undefined || !Condition.hasPredicate(value.when)
						? value
						: Rule.make({
								...value,
								when: Condition.provideContext(value.when, context as never),
							}),
				),
			})
		case "All":
		case "Any":
		case "FirstOf":
			return nodes[node._tag]({
				policies: node.policies.map((child) => provideNode(child, context)),
			})
		case "Ceiling":
			return nodes.Ceiling({
				cap: provideNode(node.cap, context),
				policy: provideNode(node.policy, context),
			})
	}
}

/**
 * Gives the services in `context` to every predicate of a policy, so the
 * policy needs no services when it runs.
 *
 * @stability stable
 * @category services
 * @since 0.4.0
 */
export const provideContext: {
	<R>(
		context: Context.Context<R>,
	): <D extends Domain.Any, E, O>(
		policy: Policy<D, E, R, O>,
	) => Policy<D, E, never, O>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		context: Context.Context<R>,
	): Policy<D, E, never, O>
} = dual(2, (policy: Any, context: Context.Context<never>): any =>
	fromNode(policy.domain, provideNode(policy.node, context)),
)

// Decisions

interface DecideContext {
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly input: Condition.Input
	readonly trace: Array<Step> | undefined
}

const ruleApplies = (
	value: Rule.Any,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!Rule.matchesTarget(value, context)) {
		return Effect.succeed(false)
	}
	const test =
		value.when === undefined
			? Effect.succeed(true)
			: Condition.evaluate(value.when, context.input)
	return context.trace === undefined
		? test
		: Effect.tap(test, (applies) =>
				Effect.sync(() => {
					context.trace!.push({ path, rule: value, applies })
				}),
			)
}

const fromRule = (value: Rule.Any): Decision.Decision =>
	value._tag === "Allow"
		? Decision.Allow({ rule: value })
		: value.reason === undefined
			? Decision.Deny({ rule: value })
			: Decision.Deny({ rule: value, reason: value.reason })

const firstApplying = Effect.fnUntraced(function* (
	candidates: ReadonlyArray<readonly [Rule.Any, number]>,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.fn.Return<Rule.Any | undefined, unknown, unknown> {
	for (const [value, index] of candidates) {
		if (yield* ruleApplies(value, context, [...path, index])) {
			return value
		}
	}
	return undefined
})

const decideRules = Effect.fnUntraced(function* (
	node: RulesNode,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.fn.Return<Decision.Decision, unknown, unknown> {
	const indexed = node.rules.map((value, index) => [value, index] as const)
	const denies = indexed.filter(([value]) => value._tag === "Deny")
	const allows = indexed.filter(([value]) => value._tag === "Allow")
	let found: Rule.Any | undefined
	switch (node.algorithm) {
		case "denyOverrides":
			found =
				(yield* firstApplying(denies, context, path)) ??
				(yield* firstApplying(allows, context, path))
			break
		case "permitOverrides":
			found =
				(yield* firstApplying(allows, context, path)) ??
				(yield* firstApplying(denies, context, path))
			break
		case "firstApplicable":
			found = yield* firstApplying(indexed, context, path)
			break
		case "lastApplicable":
			found = yield* firstApplying(indexed.slice().reverse(), context, path)
			break
	}
	return found === undefined ? Decision.NotApplicable : fromRule(found)
})

const decideNode = (
	node: Node,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	switch (node._tag) {
		case "Rules":
			return decideRules(node, context, path)
		case "All":
			return Effect.gen(function* () {
				let firstAllow: Decision.Decision | undefined
				let allAllow = node.policies.length > 0
				for (const [index, child] of node.policies.entries()) {
					const result = yield* decideNode(child, context, [...path, index])
					if (result._tag === "Deny") {
						return result
					}
					if (result._tag === "Allow") {
						firstAllow ??= result
					} else {
						allAllow = false
					}
				}
				return allAllow && firstAllow !== undefined
					? firstAllow
					: Decision.NotApplicable
			})
		case "Any":
			return Effect.gen(function* () {
				let firstDeny: Decision.Decision | undefined
				for (const [index, child] of node.policies.entries()) {
					const result = yield* decideNode(child, context, [...path, index])
					if (result._tag === "Allow") {
						return result
					}
					if (result._tag === "Deny") {
						firstDeny ??= result
					}
				}
				return firstDeny ?? Decision.NotApplicable
			})
		case "FirstOf":
			return Effect.gen(function* () {
				for (const [index, child] of node.policies.entries()) {
					const result = yield* decideNode(child, context, [...path, index])
					if (result._tag !== "NotApplicable") {
						return result
					}
				}
				return Decision.NotApplicable
			})
		case "Ceiling":
			return Effect.gen(function* () {
				const capped = yield* decideNode(node.cap, context, [...path, 0])
				if (capped._tag === "Deny") {
					return capped
				}
				return yield* decideNode(node.policy, context, [...path, 1])
			})
	}
}

const makeContext = (
	domain: Domain.Any,
	request: AnyRequest,
	trace: Array<Step> | undefined,
): DecideContext | undefined => {
	const kind = Resource.kindOf(request.resource)
	const descriptor = kind === undefined ? undefined : domain.resources.get(kind)
	if (kind === undefined || descriptor === undefined) {
		return undefined
	}
	return {
		action: request.action,
		kind,
		field: request.field,
		input: {
			value: request.resource,
			principal: request.principal,
			path: descriptor.path,
		},
		trace,
	}
}

const decideAny = (
	policy: Any,
	request: AnyRequest,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	const context = makeContext(policy.domain, request, undefined)
	return context === undefined
		? Effect.succeed(Decision.NotApplicable)
		: decideNode(policy.node, context, [])
}

/**
 * Gives the decision of a policy for a request.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decide: {
	<D extends Domain.Any = never>(
		request: Request<D>,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<Decision.Decision, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Decision.Decision, E, R>
} = dual(2, decideAny) as never

/**
 * Gives the decision of a policy with no predicates, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decideSync: {
	<D extends Domain.Any = never>(
		request: Request<D>,
	): (policy: Policy<D>) => Decision.Decision
	<D extends Domain.Any>(
		policy: Policy<D>,
		request: Request<NoInfer<D>>,
	): Decision.Decision
} = dual(2, (policy: Any, request: AnyRequest): Decision.Decision =>
	Effect.runSync(
		// The public type of `decideSync` takes only policies with no
		// predicates, so this Effect has no error and needs no services.
		// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
		decideAny(policy, request) as Effect.Effect<Decision.Decision>,
	),
)

/**
 * Gives the decision of a policy and the rules that were tested to make it.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const explain: {
	<D extends Domain.Any = never>(
		request: Request<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Effect.Effect<Explanation, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Explanation, E, R>
} = dual(
	2,
	(
		policy: Any,
		request: AnyRequest,
	): Effect.Effect<Explanation, unknown, unknown> =>
		// Each run of the Effect needs its own trace, so the trace is made inside
		// the Effect.
		Effect.suspend(() => {
			const trace: Array<Step> = []
			const context = makeContext(policy.domain, request, trace)
			if (context === undefined) {
				return Effect.succeed({ decision: Decision.NotApplicable, steps: [] })
			}
			return Effect.map(decideNode(policy.node, context, []), (decision) => ({
				decision,
				steps: trace,
			}))
		}),
) as never

/**
 * Gives the fields of a resource value that the policy lets a request use. It
 * tests each field of the resource Schema, with dots for nested fields.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const permittedFields: {
	<D extends Domain.Any = never>(
		request: FieldlessRequest<D>,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<ReadonlyArray<string>, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: FieldlessRequest<NoInfer<D>>,
	): Effect.Effect<ReadonlyArray<string>, E, R>
} = dual(
	2,
	Effect.fnUntraced(function* (
		policy: Any,
		request: Omit<AnyRequest, "field">,
	): Effect.fn.Return<ReadonlyArray<string>, unknown, unknown> {
		const kind = Resource.kindOf(request.resource)
		const descriptor =
			kind === undefined ? undefined : policy.domain.resources.get(kind)
		if (descriptor === undefined) {
			return []
		}
		const output: Array<string> = []
		for (const field of descriptor.fieldPaths) {
			const result: Decision.Decision = yield* decideAny(policy, {
				...request,
				field,
			})
			if (result._tag === "Allow") {
				output.push(field)
			}
		}
		return output
	}),
) as never

// Residual conditions

type Ast = Condition.Ast

/**
 * The two residual conditions of a request. See {@link residuals}.
 *
 * @stability stable
 * @category models
 * @since 0.4.0
 */
export interface Residuals<E = never, R = never, O = never> {
	/** The condition on resource values for which the policy allows. */
	readonly allow: Condition.Condition<E, R, O>
	/** The condition on resource values for which the policy denies. */
	readonly deny: Condition.Condition<E, R, O>
}

const always: Ast = Condition.always
const never: Ast = Condition.never
// These helpers work on nodes with no types, so they leave out the type field
// of a condition.
const and = (...values: ReadonlyArray<Ast>): Ast =>
	Condition.simplify(Condition.and(...(values as ReadonlyArray<never>)))
const or = (...values: ReadonlyArray<Ast>): Ast =>
	Condition.simplify(Condition.or(...(values as ReadonlyArray<never>)))
const not = (value: Ast): Ast =>
	Condition.simplify(Condition.not(value as never))

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
}

const ruleCondition = (value: Rule.Any, context: ResidualContext): Ast =>
	!Rule.matchesTarget(value, context)
		? never
		: value.when === undefined
			? always
			: Condition.partial(value.when, context.input)

/**
 * Gives the conditions for "the first rule that applies is an allow rule" and
 * "the first rule that applies is a deny rule".
 */
const firstApplicableResidual = (
	values: ReadonlyArray<Rule.Any>,
	context: ResidualContext,
): Pair => {
	let allow: Ast = never
	let deny: Ast = never
	for (const value of values.slice().reverse()) {
		const applies = ruleCondition(value, context)
		if (value._tag === "Allow") {
			allow = or(applies, allow)
			deny = and(not(applies), deny)
		} else {
			deny = or(applies, deny)
			allow = and(not(applies), allow)
		}
	}
	return { allow, deny }
}

/**
 * A condition that is always true, but that tests both conditions of a pair
 * first. It runs every predicate that `decide` runs for the node, so a failure
 * of a predicate is not lost.
 */
const runAll = (pair: Pair): Ast => or(pair.allow, pair.deny, always)

const residualNode = (node: Node, context: ResidualContext): Pair => {
	switch (node._tag) {
		case "Rules": {
			switch (node.algorithm) {
				// The parts of each condition are in the order that `decide` tests
				// the rules. So a predicate that fails in `decide` fails here too.
				case "denyOverrides": {
					const deny = or(
						...node.rules
							.filter((value) => value._tag === "Deny")
							.map((value) => ruleCondition(value, context)),
					)
					const allow = and(
						not(deny),
						or(
							...node.rules
								.filter((value) => value._tag === "Allow")
								.map((value) => ruleCondition(value, context)),
						),
					)
					return { allow, deny }
				}
				case "permitOverrides": {
					const allow = or(
						...node.rules
							.filter((value) => value._tag === "Allow")
							.map((value) => ruleCondition(value, context)),
					)
					const deny = and(
						not(allow),
						or(
							...node.rules
								.filter((value) => value._tag === "Deny")
								.map((value) => ruleCondition(value, context)),
						),
					)
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
			const deny = or(...pairs.map((pair) => pair.deny))
			// `decide` tests every child, also after a child that does not allow.
			// So the predicates of every child run first.
			const allow = and(
				...pairs.map(runAll),
				...pairs.map((pair) => pair.allow),
				not(deny),
			)
			return { allow, deny }
		}
		case "Any": {
			// `decide` tests each child in full before it goes to the next one, so
			// the predicates of a child that does not allow run first.
			let allow: Ast = never
			const pairs = node.policies.map((child) => residualNode(child, context))
			for (const pair of pairs.slice().reverse()) {
				allow = or(pair.allow, and(runAll(pair), allow))
			}
			const deny = and(not(allow), or(...pairs.map((pair) => pair.deny)))
			return { allow, deny }
		}
		case "FirstOf": {
			let allow: Ast = never
			let deny: Ast = never
			for (const child of node.policies.slice().reverse()) {
				const pair = residualNode(child, context)
				const nextAllow = or(pair.allow, and(not(pair.deny), allow))
				deny = or(pair.deny, and(not(pair.allow), deny))
				allow = nextAllow
			}
			return { allow, deny }
		}
		case "Ceiling": {
			const cap = residualNode(node.cap, context)
			const inner = residualNode(node.policy, context)
			return {
				allow: and(runAll(cap), not(cap.deny), inner.allow),
				deny: or(cap.deny, inner.deny),
			}
		}
	}
}

const residualsAny = (
	policy: Any,
	request: {
		readonly principal: object
		readonly action: string
		readonly kind: string
		readonly field?: string | undefined
	},
): Pair => {
	const descriptor = policy.domain.resources.get(request.kind)
	if (descriptor === undefined) {
		return { allow: never, deny: never }
	}
	return residualNode(policy.node, {
		action: request.action,
		kind: request.kind,
		field: request.field,
		input: { principal: request.principal, path: descriptor.path },
	})
}

/**
 * Gives the condition on resource values for which the policy allows a
 * request. It has no principal fields and no `Under` nodes, so you can give it
 * to `Condition.fold`. It is `True` when the policy allows every value of the
 * kind, and `False` when it allows none.
 *
 * Predicates stay in the condition. They take the principal with them.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const residual: {
	<D extends Domain.Any = never>(
		request: KindRequest<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Condition.Condition<E, R, O>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: KindRequest<NoInfer<D>>,
	): Condition.Condition<E, R, O>
} = dual(
	2,
	(policy: Any, request: KindRequest<Domain.Any>): Ast =>
		residualsAny(policy, request).allow,
) as never

/**
 * Gives both residual conditions of a request: the values that the policy
 * allows, and the values that it denies. A value in neither is not
 * applicable. See {@link residual}.
 *
 * @stability stable
 * @category evaluation
 * @since 0.4.0
 */
export const residuals: {
	<D extends Domain.Any = never>(
		request: KindRequest<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Residuals<E, R, O>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: KindRequest<NoInfer<D>>,
	): Residuals<E, R, O>
} = dual(2, residualsAny) as never

// Schema

/**
 * The JSON form of a rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface EncodedRule {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Encoded
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
}

/**
 * The JSON form of a policy.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type EncodedNode =
	| {
			readonly _tag: "Rules"
			readonly algorithm: Algorithm
			readonly rules: ReadonlyArray<EncodedRule>
	  }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly policies: ReadonlyArray<EncodedNode>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly cap: EncodedNode
			readonly policy: EncodedNode
	  }

const AlgorithmSchema = Schema.Literals([
	"denyOverrides",
	"permitOverrides",
	"firstApplicable",
	"lastApplicable",
])

const encodedRuleSchema = (meta: Schema.Top | undefined) =>
	Schema.Struct({
		_tag: Schema.Literals(["Allow", "Deny"]),
		actions: Schema.Array(Schema.String),
		resources: Schema.Array(Schema.String),
		when: Schema.optionalKey(Condition.schema),
		fields: Schema.String.pipe(Schema.Array, Schema.optionalKey),
		reason: Schema.optionalKey(Schema.String),
		id: Schema.optionalKey(Schema.String),
		meta: Schema.optionalKey(
			(meta ?? Schema.Never) as Schema.Codec<unknown, unknown>,
		),
	})

const encodedNodeSchema = (
	meta: Schema.Top | undefined,
): Schema.Codec<EncodedNode> => {
	const self: Schema.Codec<EncodedNode> = Schema.Union([
		Schema.TaggedStruct("Rules", {
			algorithm: AlgorithmSchema,
			rules: Schema.Array(encodedRuleSchema(meta)),
		}),
		Schema.TaggedStruct("All", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("Any", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("FirstOf", {
			policies: Schema.Array(Schema.suspend(() => self)),
		}),
		Schema.TaggedStruct("Ceiling", {
			cap: Schema.suspend(() => self),
			policy: Schema.suspend(() => self),
		}),
	]) as never
	return self
}

const principalRefs = (ast: Condition.Encoded | Ast): ReadonlyArray<string> => {
	const output: Array<string> = []
	const visitOperand = (operand: Condition.Operand) => {
		if (operand._tag === "Principal") output.push(operand.path)
	}
	const visit = (node: Condition.Encoded | Ast): void => {
		switch (node._tag) {
			case "Compare":
				visitOperand(node.value)
				return
			case "In":
				node.values.forEach(visitOperand)
				return
			case "Under":
				node.prefix.forEach(visitOperand)
				return
			case "And":
			case "Or":
				;(node.conditions as ReadonlyArray<Ast>).forEach(visit)
				return
			case "Not":
				visit(node.condition)
				return
			default:
				return
		}
	}
	visit(ast)
	return output
}

interface Issue {
	readonly path: ReadonlyArray<PropertyKey>
	readonly issue: string
}

/**
 * Checks the names in an encoded policy against the domain. It gives one
 * message for each problem.
 */
const validate = (
	domain: Domain.Any,
	root: EncodedNode,
): ReadonlyArray<Issue> => {
	const issues: Array<Issue> = []
	const principalPaths = new Set(Resource.fieldPaths(domain.principal))
	const visit = (node: EncodedNode, path: ReadonlyArray<PropertyKey>) => {
		switch (node._tag) {
			case "Rules":
				node.rules.forEach((value, index) => {
					const at = [...path, "rules", index]
					const kinds = value.resources.includes("*")
						? undefined
						: value.resources
					const descriptors = []
					for (const kind of value.resources) {
						if (kind === "*") continue
						const descriptor = domain.resources.get(kind)
						if (descriptor === undefined) {
							issues.push({
								path: [...at, "resources"],
								issue: `There is no resource with the kind "${kind}"`,
							})
						} else {
							descriptors.push(descriptor)
						}
					}
					const known =
						kinds === undefined
							? Array.from(domain.resources.values())
							: descriptors
					for (const action of value.actions) {
						if (action === "*") continue
						if (
							!known.some((descriptor) => descriptor.actions.includes(action))
						) {
							issues.push({
								path: [...at, "actions"],
								issue: `The action "${action}" is not an action of these resources`,
							})
						}
					}
					const usedFields = [
						...(value.fields ?? []).filter((field) => !field.includes("*")),
						...(value.when === undefined
							? []
							: Condition.fields(value.when as Ast)),
					]
					for (const field of usedFields) {
						const everywhere =
							kinds !== undefined &&
							descriptors.length > 0 &&
							descriptors.every((descriptor) =>
								descriptor.fieldPaths.includes(field),
							)
						if (!everywhere) {
							issues.push({
								path: at,
								issue: `The field "${field}" is not a field of every resource of the rule`,
							})
						}
					}
					if (value.when !== undefined) {
						for (const ref of principalRefs(value.when)) {
							if (!principalPaths.has(ref)) {
								issues.push({
									path: [...at, "when"],
									issue: `The principal has no field "${ref}"`,
								})
							}
						}
					}
				})
				return
			case "All":
			case "Any":
			case "FirstOf":
				node.policies.forEach((child, index) =>
					visit(child, [...path, "policies", index]),
				)
				return
			case "Ceiling":
				visit(node.cap, [...path, "cap"])
				visit(node.policy, [...path, "policy"])
				return
		}
	}
	visit(root, [])
	return issues
}

const decodeNode = (node: EncodedNode): Node => {
	switch (node._tag) {
		case "Rules":
			return nodes.Rules({
				algorithm: node.algorithm,
				rules: node.rules.map((value) => Rule.make(value as Rule.Shape)),
			})
		case "All":
		case "Any":
		case "FirstOf":
			return nodes[node._tag]({ policies: node.policies.map(decodeNode) })
		case "Ceiling":
			return nodes.Ceiling({
				cap: decodeNode(node.cap),
				policy: decodeNode(node.policy),
			})
	}
}

/**
 * Tests if a value is a policy.
 *
 * @stability stable
 * @category guards
 * @since 0.3.0
 */
export const isPolicy = (u: unknown): u is Any => u instanceof PolicyData

/**
 * The Schema of the policies of a domain with no predicates. Decoding checks
 * every kind, action, field and principal field against the domain, and the
 * `meta` of each rule against the `meta` Schema of the domain.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema = <D extends Domain.Any>(
	domain: D,
): Schema.Codec<Policy<D>, EncodedNode> =>
	encodedNodeSchema(domain.meta).pipe(
		Schema.check(Schema.makeFilter((node) => validate(domain, node))),
		Schema.decodeTo(
			Schema.declare((u): u is Policy<D> => isPolicy(u) && u.domain === domain),
			SchemaTransformation.transform({
				decode: (node: EncodedNode) => fromNode(domain, decodeNode(node)),
				encode: (policy: Policy<D>) => encodeNode(policy.node),
			}),
		),
	)
