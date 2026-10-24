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
 * A policy without predicates can become JSON with {@link schema}.
 *
 * @since 0.3.0
 * @module
 */
import type * as Effect from "effect/Effect"
import type * as Equal from "effect/Equal"
import type * as Inspectable from "effect/Inspectable"
import type * as Pipeable from "effect/Pipeable"
import type * as Schema from "effect/Schema"
import type * as Condition from "./Condition.ts"
import type * as Decision from "./Decision.ts"
import type * as Domain from "./Domain.ts"
import * as internal from "./internal/policy.ts"
import type * as Rule from "./Rule.ts"

/**
 * @since 0.3.0
 * @category Type Ids
 */
export const TypeId: "~@nmnmcc/ability/Policy" = internal.TypeId

/**
 * @since 0.3.0
 * @category Type Ids
 */
export type TypeId = typeof TypeId

/**
 * @since 0.3.0
 * @category Models
 */
export type Algorithm =
	"denyOverrides" | "permitOverrides" | "firstApplicable" | "lastApplicable"

/**
 * @since 0.3.0
 * @category Models
 */
export interface RulesNode {
	readonly _tag: "Rules"
	readonly algorithm: Algorithm
	readonly rules: ReadonlyArray<Rule.Any>
}

/**
 * @since 0.3.0
 * @category Models
 */
export interface AllNode {
	readonly _tag: "All"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @since 0.3.0
 * @category Models
 */
export interface AnyNode {
	readonly _tag: "Any"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @since 0.3.0
 * @category Models
 */
export interface FirstOfNode {
	readonly _tag: "FirstOf"
	readonly policies: ReadonlyArray<Node>
}

/**
 * @since 0.3.0
 * @category Models
 */
export interface CeilingNode {
	readonly _tag: "Ceiling"
	readonly cap: Node
	readonly policy: Node
}

/**
 * The nodes of a policy tree.
 *
 * @since 0.3.0
 * @category Models
 */
export type Node = RulesNode | AllNode | AnyNode | FirstOfNode | CeilingNode

/**
 * A policy for the domain `D`. `E`, `R` and `O` come from the conditions of
 * its rules. See `Condition.Condition`.
 *
 * @since 0.3.0
 * @category Models
 */
export interface Policy<D extends Domain.Any, E = never, R = never, O = never>
	extends Equal.Equal, Inspectable.Inspectable, Pipeable.Pipeable {
	readonly [TypeId]: TypeId
	readonly domain: D
	readonly node: Node
	readonly "~Policy"?: Condition.Variance<E, R, O>
}

/**
 * Any policy.
 *
 * @since 0.3.0
 * @category Models
 */
export type Any = Policy<any, any, any, any>

/**
 * The domain of a policy.
 *
 * @since 0.3.0
 * @category Type Helpers
 */
export type DomainOf<P> = P extends Policy<infer D, any, any, any> ? D : never

/**
 * The error type of a policy.
 *
 * @since 0.3.0
 * @category Type Helpers
 */
export type Error<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a policy.
 *
 * @since 0.3.0
 * @category Type Helpers
 */
export type Context<P> = P extends {
	readonly "~Policy"?: Condition.Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * `Condition.Opaque` when a policy has a predicate.
 *
 * @since 0.3.0
 * @category Type Helpers
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
 * @since 0.3.0
 * @category Models
 */
export type Target<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly resource: Domain.ValueOf<D, K>
		readonly field?: Condition.FieldPath<Domain.DataOf<D, K>>
	}
}[Domain.Kind<D>]

/**
 * One act on one kind of resource, with no value.
 *
 * @since 0.3.0
 * @category Models
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
 * @since 0.3.0
 * @category Models
 */
export type Request<D> = Target<D> & { readonly principal: Domain.Principal<D> }

/**
 * A request about a kind of resource, with no value.
 *
 * @since 0.3.0
 * @category Models
 */
export type KindRequest<D> = KindTarget<D> & {
	readonly principal: Domain.Principal<D>
}

/**
 * A request with no types.
 *
 * @since 0.3.0
 * @category Models
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
 * @since 0.3.0
 * @category Models
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
 * @since 0.3.0
 * @category Models
 */
export interface Explanation {
	readonly decision: Decision.Decision
	readonly steps: ReadonlyArray<Step>
}

/**
 * The options of a list of rules.
 *
 * @since 0.3.0
 * @category Models
 */
export interface Options {
	/** The default is `denyOverrides`. */
	readonly algorithm?: Algorithm
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
 * @since 0.3.0
 * @category Constructors
 */
export const define: <D extends Domain.Any>(
	domain: D,
	options?: Options,
) => <Rules extends Rule.Any, A>(
	body: (builder: Rule.Builder<D>) => Generator<Rules, A, unknown>,
) => Policy<D, Rule.Error<Rules>, Rule.Context<Rules>, Rule.OpaqueOf<Rules>> =
	internal.define as never

/**
 * Makes a policy from a list of rules.
 *
 * @since 0.3.0
 * @category Constructors
 */
export const rules: <D extends Domain.Any, Rules extends Rule.Any>(
	domain: D,
	rules: Iterable<Rules>,
	options?: Options,
) => Policy<D, Rule.Error<Rules>, Rule.Context<Rules>, Rule.OpaqueOf<Rules>> =
	internal.rules

/**
 * A policy with no rules. It is not applicable to any request.
 *
 * @since 0.3.0
 * @category Constructors
 */
export const empty = <D extends Domain.Any>(domain: D): Policy<D> =>
	internal.rules(domain, [])

type Combined<D extends Domain.Any, Ps extends ReadonlyArray<Any>> = Policy<
	D,
	Error<Ps[number]>,
	Context<Ps[number]>,
	OpaqueOf<Ps[number]>
>

/**
 * Every policy must allow, and one deny is enough to deny. With some policies
 * not applicable and none that deny, the result is not applicable.
 *
 * @since 0.3.0
 * @category Combinators
 */
export const all: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = internal.all

/**
 * One allow is enough. Without an allow, one deny gives a deny.
 *
 * @since 0.3.0
 * @category Combinators
 */
export const any: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = internal.any

/**
 * The first policy that allows or denies gives the answer.
 *
 * @since 0.3.0
 * @category Combinators
 */
export const firstOf: <
	const Ps extends readonly [Policy<any, any, any, any>, ...Array<Any>],
>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = internal.firstOf

/**
 * Puts a limit on a policy. A deny from `cap` always wins. An allow from `cap`
 * does nothing.
 *
 * @since 0.3.0
 * @category Combinators
 */
export const ceiling: {
	<D extends Domain.Any, E2, R2, O2>(
		cap: Policy<D, E2, R2, O2>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Policy<D, E | E2, R | R2, O | O2>
	<D extends Domain.Any, E, R, O, E2, R2, O2>(
		policy: Policy<D, E, R, O>,
		cap: Policy<D, E2, R2, O2>,
	): Policy<D, E | E2, R | R2, O | O2>
} = internal.ceiling

/**
 * Gives the decision of a policy for a request.
 *
 * @since 0.3.0
 * @category Evaluation
 */
export const decide: {
	<D extends Domain.Any>(
		request: Request<D>,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<Decision.Decision, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Decision.Decision, E, R>
} = internal.decide as never

/**
 * Gives the decision of a policy with no predicates, at once.
 *
 * @since 0.3.0
 * @category Evaluation
 */
export const decideSync: {
	<D extends Domain.Any>(
		request: Request<D>,
	): (policy: Policy<D>) => Decision.Decision
	<D extends Domain.Any>(
		policy: Policy<D>,
		request: Request<NoInfer<D>>,
	): Decision.Decision
} = internal.decideSync

/**
 * Gives the decision of a policy and the rules that were tested to make it.
 *
 * @since 0.3.0
 * @category Evaluation
 */
export const explain: {
	<D extends Domain.Any>(
		request: Request<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Effect.Effect<Explanation, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Request<NoInfer<D>>,
	): Effect.Effect<Explanation, E, R>
} = internal.explain as never

/**
 * Gives the condition on resource values for which the policy allows a
 * request. It has no principal fields and no `Under` nodes, so you can give it
 * to `Condition.fold`. It is `True` when the policy allows every value of the
 * kind, and `False` when it allows none.
 *
 * Predicates stay in the condition. They take the principal with them.
 *
 * @since 0.3.0
 * @category Evaluation
 */
export const residual: {
	<D extends Domain.Any>(
		request: KindRequest<D>,
	): <E, R, O>(policy: Policy<D, E, R, O>) => Condition.Condition<E, R, O>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: KindRequest<NoInfer<D>>,
	): Condition.Condition<E, R, O>
} = internal.residual as never

/**
 * Gives the fields of a resource value that the policy lets a request use. It
 * tests each field of the resource Schema, with dots for nested fields.
 *
 * @since 0.3.0
 * @category Evaluation
 */
export const permittedFields: {
	<D extends Domain.Any>(
		request: Omit<Request<D>, "field">,
	): <E, R, O>(
		policy: Policy<D, E, R, O>,
	) => Effect.Effect<ReadonlyArray<string>, E, R>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		request: Omit<Request<NoInfer<D>>, "field">,
	): Effect.Effect<ReadonlyArray<string>, E, R>
} = internal.permittedFields as never

/**
 * The JSON form of a rule.
 *
 * @since 0.3.0
 * @category Models
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
 * @since 0.3.0
 * @category Models
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

/**
 * The Schema of the policies of a domain with no predicates. Decoding checks
 * every kind, action, field and principal field against the domain, and the
 * `meta` of each rule against the `meta` Schema of the domain.
 *
 * @since 0.3.0
 * @category Schemas
 */
export const schema: <D extends Domain.Any>(
	domain: D,
) => Schema.Codec<Policy<D>, EncodedNode> = internal.schema

/**
 * Tests if a value is a policy.
 *
 * @since 0.3.0
 * @category Guards
 */
export const isPolicy: (u: unknown) => u is Any = internal.isPolicy
