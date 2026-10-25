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
import type * as Context from "effect/Context"
import type * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as Pipeable from "effect/Pipeable"
import type * as Schema from "effect/Schema"
import type * as Condition from "./Condition.ts"
import * as Analysis from "./internal/analysis.ts"
import * as Decide from "./internal/decide.ts"
import * as Internal from "./internal/policy.ts"
import type * as PolicyNodes from "./internal/policy-nodes.ts"
import * as RuleData from "./internal/rule.ts"
import type * as Decision from "./Decision.ts"
import type * as Domain from "./Domain.ts"
import type * as Resource from "./Resource.ts"

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Algorithm =
	"denyOverrides" | "permitOverrides" | "firstApplicable" | "lastApplicable"

/**
 * A list of rules with a combining algorithm.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type RulesNode = PolicyNodes.Rules

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type AllNode = PolicyNodes.All

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type AnyNode = PolicyNodes.Any

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FirstOfNode = PolicyNodes.FirstOf

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type CeilingNode = PolicyNodes.Ceiling

/**
 * The nodes of a policy tree, without types. Each node is a class, and only
 * the functions of this module and the Schema make one.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Node = PolicyNodes.Node

/**
 * A policy for the domain `D`. `X` is `Condition.Opaque` when a rule of the
 * policy has a predicate, and `never` when the policy is plain data. A plain
 * policy can become JSON, and `decideSync` takes it.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Policy<D extends Domain.Any, X = never> = Internal.PolicyData<D, X>

/**
 * Any policy.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Any = Policy<any, any>

/**
 * The domain of a policy.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DomainOf<P> = P extends Policy<infer D, any> ? D : never

/**
 * The mark of a policy or a rule: `Condition.Opaque` when it has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type OpaqueOf<P> = P extends { readonly "~Opaque": () => infer X }
	? X
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
		readonly field?: Condition.FieldSelector<Domain.DataOf<D, K>>
		/** A target has a resource value or a kind, never both. */
		readonly kind?: never
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
		readonly kind?: never
	}
}[Domain.Kind<D>]

/**
 * A scope: a part of a kind, as a condition on its values. It gets a builder
 * with the types of the kind and of the principal, like the condition of a
 * rule. A scope is plain data, so it can not have a predicate.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export type Scope<D, K extends string> = (
	builder: Condition.Builder<
		Domain.DataOf<D, K>,
		Domain.ValueOf<D, K>,
		Domain.Principal<D>
	>,
) => Condition.Condition<
	Condition.Reads<Domain.ValueOf<D, K>, Domain.Principal<D>>
>

/**
 * One act on one kind of resource, with no value. With `within`, the target is
 * only the values of the kind in the scope. Without it, the target is every
 * value of the kind.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type KindTarget<D> = {
	[K in Domain.Kind<D>]: {
		readonly action: Domain.ActionOf<D, K>
		readonly kind: K
		readonly field?: Condition.FieldSelector<Domain.DataOf<D, K>>
		/** The part of the kind. See {@link Scope}. */
		readonly within?: Scope<D, K>
		/** A target has a resource value or a kind, never both. */
		readonly resource?: never
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
	readonly rule: AnyRule
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

// Rules

/**
 * A rule for the domain `D`. `I` is what the tests of its condition read, and
 * `X` is its mark: see `Condition.Condition`. A predicate reads the values and
 * the principal of its domain, so a rule may go only into a policy of its own
 * domain. A rule from {@link rule} has the domain `any`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Rule<D = any, I = unknown, X = never>
	extends RuleShape<I, X>, Pipeable.Pipeable {
	readonly "~Opaque": () => X
	readonly "~Domain": (domain: D) => D
	[Symbol.iterator](): Generator<Rule<D, I, X>, Rule<D, I, X>, unknown>
}

/**
 * The data of a rule.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export interface RuleShape<I = unknown, X = never> {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Condition<I, X>
	readonly fields?: ReadonlyArray<string>
	readonly reason?: string
	readonly id?: string
	readonly meta?: unknown
	/**
	 * The domain of the builder that made the rule. Two domains may have the
	 * same types but other paths, so the types can not tell them apart. It is
	 * not in the JSON form of a rule.
	 */
	readonly domain?: Domain.Any
}

/**
 * Any rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
// Every rule fits `never` as what it reads, and a condition taken from such a
// rule fits no rule that reads a value or a principal.
export type AnyRule = Rule<any, never, any>

/**
 * A resource in a rule: a kind name, a resource of the domain, or `"*"`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type RuleTarget<D> = Domain.Kind<D> | Domain.Resources<D> | "*"

/**
 * The kind name of a target.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type KindOf<T> = T extends string ? T : Resource.Kind<T>

/**
 * The actions that a rule may use for the kinds `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ActionFor<D, K> =
	| "*"
	| ("*" extends K
			? Domain.AnyAction<D>
			: Domain.ActionOf<D, Extract<K, string>>)

/**
 * The targets in the resource argument of a rule: the one target, or the
 * targets of a list.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type TargetOf<Res> = Res extends ReadonlyArray<infer X> ? X : Res

/**
 * The actions that a rule may use for its resource argument. A list of
 * resources may use an action of any of them. One target with a union type
 * may use only an action of every kind in the union, because its value may be
 * any one of them. When the argument may be a list or one target, the rule
 * may use only an action that each of these shapes allows.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type ActionForTargets<D, Res> = (
	Res extends ReadonlyArray<infer X>
		? (action: ActionFor<D, KindOf<X>>) => void
		: (action: ActionForTarget<D, Res>) => void
) extends (action: infer A) => void
	? A
	: never

/** The actions for one target that is not a list. */
type ActionForTarget<D, Res> =
	| "*"
	| ("*" extends KindOf<Res>
			? Domain.AnyAction<D>
			: Domain.CommonAction<D, Extract<KindOf<Res>, string>>)

/**
 * The data type of the kinds `K`. For `"*"` it has no fields.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type DataFor<D, K> = "*" extends K
	? {}
	: Domain.DataOf<D, Extract<K, string>>

/**
 * The value type of the kinds `K`.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type ValueFor<D, K> = "*" extends K
	? Domain.AnyValue<D>
	: Domain.ValueOf<D, Extract<K, string>>

/**
 * A field name or a field pattern of the kinds `K`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type FieldFor<D, K> =
	Condition.FieldSelector<DataFor<D, K>> | `${string}*${string}`

/**
 * A condition that a rule for the kinds `K` may have. Its predicates may read
 * only the values of these kinds and the principal of the domain.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export type ConditionFor<D, K> = Condition.Condition<
	Condition.Reads<ValueFor<D, K>, Domain.Principal<D>>,
	any
>

/**
 * The options of a rule.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface RuleOptions<D, K, C extends Condition.Any> {
	/** The condition. It gets a builder with the types of the resource. */
	readonly when?: (
		builder: Condition.Builder<
			DataFor<D, K>,
			ValueFor<D, K>,
			Domain.Principal<D>
		>,
	) => C
	readonly fields?: ReadonlyArray<FieldFor<D, K>>
	readonly reason?: string
	readonly id?: string
	readonly meta?: Domain.Meta<D>
}

type SingleOrArray<A> = A | ReadonlyArray<A>

/**
 * Makes rules with the types of a domain.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Builder<D> {
	readonly allow: <
		const Res extends SingleOrArray<RuleTarget<D>>,
		const A extends ActionForTargets<D, Res>,
		const C extends ConditionFor<D, KindOf<TargetOf<Res>>> =
			Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: Res,
		options?: RuleOptions<D, KindOf<TargetOf<Res>>, C>,
	) => Rule<D, Condition.ReadsOf<C>, Condition.OpaqueOf<C>>
	readonly deny: <
		const Res extends SingleOrArray<RuleTarget<D>>,
		const A extends ActionForTargets<D, Res>,
		const C extends ConditionFor<D, KindOf<TargetOf<Res>>> =
			Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: Res,
		options?: RuleOptions<D, KindOf<TargetOf<Res>>, C>,
	) => Rule<D, Condition.ReadsOf<C>, Condition.OpaqueOf<C>>
}

/**
 * Makes rules with the types of a domain. `Policy.define` gives one to its
 * generator. Use this one to make rules outside of a generator.
 *
 * @example
 * ```ts
 * const _ = Policy.builder(App)
 * const rule = _.allow("read", Document, {
 *   when: ($) => $.eq("ownerId", $.principal("id")),
 * })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 2.0.0
 */
export const builder = <D extends Domain.Any>(domain: D): Builder<D> =>
	RuleData.builder(domain) as never

/**
 * Makes a rule from its data, with no types. It does not check the data
 * against a domain: a policy does that when the rule goes into it. Use
 * {@link builder} for rules with types, or {@link schema} for rules from JSON.
 *
 * @stability stable
 * @category constructors
 * @since 2.0.0
 */
export const rule = <I = unknown, X = never>(
	data: RuleShape<I, X>,
	// The types come from the data only, not from where the rule goes.
): Rule<any, NoInfer<I>, NoInfer<X>> => RuleData.make(data as never) as never

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

/**
 * The error when a rule does not fit its domain: it names a kind, an action,
 * a field or a field of the principal that the domain does not have, or it
 * tests a field with a value that the field can not hold. It has one issue
 * for each problem, with its path, and a suggestion when a name has a mistake.
 *
 * @stability stable
 * @category errors
 * @since 2.0.0
 */
export const PolicyError: typeof Internal.PolicyError = Internal.PolicyError

/**
 * @stability stable
 * @category errors
 * @since 2.0.0
 */
export type PolicyError = Internal.PolicyError

/** The mark of a union of rules: `Condition.Opaque` when one has a predicate. */
type RulesOpaque<Rules> = Rules extends { readonly "~Opaque": () => infer X }
	? X
	: never

/**
 * Makes a policy from a generator function that gives rules. It is pure and it
 * gives its result at once.
 *
 * @example
 * ```ts
 * const policy = Policy.define(App)(function* (_) {
 *   yield* _.allow("read", Document)
 *   yield* _.allow(["update", "delete"], Document, {
 *     when: ($) => $.eq("ownerId", $.principal("id")),
 *   })
 * })
 * ```
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const define: <D extends Domain.Any>(
	domain: D,
	options?: Options,
) => <Rules extends Rule<D, never, any>, A>(
	body: (builder: Builder<D>) => Generator<Rules, A, unknown>,
) => Policy<D, RulesOpaque<Rules>> = Internal.define as never

type Combined<D extends Domain.Any, Ps extends ReadonlyArray<Any>> = Policy<
	D,
	OpaqueOf<Ps[number]>
>

/**
 * Every policy must allow, and one deny is enough to deny. With some policies
 * not applicable and none that deny, the result is not applicable.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const all: <const Ps extends readonly [Any, ...Array<Any>]>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = Internal.combine("All")

/**
 * One allow is enough. Without an allow, one deny gives a deny.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const any: <const Ps extends readonly [Any, ...Array<Any>]>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = Internal.combine("Any")

/**
 * The first policy that allows or denies gives the answer.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const firstOf: <const Ps extends readonly [Any, ...Array<Any>]>(
	policies: Ps,
) => Combined<DomainOf<Ps[0]>, Ps> = Internal.combine("FirstOf")

/**
 * Puts a limit on a policy. A deny from `cap` always wins. An allow from `cap`
 * does nothing.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const ceiling: {
	<D extends Domain.Any, X2>(
		cap: Policy<D, X2>,
	): <X>(policy: Policy<D, X>) => Policy<D, X | X2>
	<D extends Domain.Any, X, X2>(
		policy: Policy<D, X>,
		cap: Policy<D, X2>,
	): Policy<D, X | X2>
} = Internal.ceiling as never

/**
 * Gives the services in `context` to every predicate of a policy, so the
 * policy needs no services when it runs.
 *
 * @stability stable
 * @category services
 * @since 1.0.0
 */
export const provideContext: {
	<R>(
		context: Context.Context<R>,
	): <D extends Domain.Any, X>(
		policy: Policy<D, X> &
			([Condition.ServicesOf<X>] extends [R] ? unknown : never),
	) => Policy<D, Condition.Provided<X>>
	<D extends Domain.Any, X>(
		policy: Policy<D, X>,
		context: Context.Context<Condition.ServicesOf<X>>,
	): Policy<D, Condition.Provided<X>>
} = Internal.provideContext as never

// Decisions

/**
 * Gives the decision of a policy for a request.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decide: <D extends Domain.Any, X>(
	policy: Policy<D, X>,
	request: Request<NoInfer<D>>,
) => Effect.Effect<
	Decision.Decision,
	Condition.ErrorOf<X>,
	Condition.ServicesOf<X>
> = Decide.decideAny as never

/**
 * Gives the decision of a policy with no predicates, at once.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const decideSync: <D extends Domain.Any>(
	policy: Policy<D>,
	request: Request<NoInfer<D>>,
) => Decision.Decision = Decide.decideSync

/**
 * Gives the decision of a policy and the rules that were tested to make it.
 *
 * One node may be a child of many nodes. Its rules are tested, and are in the
 * steps, each time that the decision comes to it.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const explain: <D extends Domain.Any, X>(
	policy: Policy<D, X>,
	request: Request<NoInfer<D>>,
) => Effect.Effect<Explanation, Condition.ErrorOf<X>, Condition.ServicesOf<X>> =
	Decide.explain as never

/**
 * Gives the fields of a resource value that the policy lets a request use. It
 * tests each field that a list of fields shows: each scalar, record or array
 * of the resource Schema, with dots for nested fields.
 *
 * A field that holds more than one value, such as a record, is left out when a
 * deny rule names a part of it. The list can not name that part, and the whole
 * field would show it.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const permittedFields: <D extends Domain.Any, X>(
	policy: Policy<D, X>,
	request: FieldlessRequest<NoInfer<D>>,
) => Effect.Effect<
	ReadonlyArray<string>,
	Condition.ErrorOf<X>,
	Condition.ServicesOf<X>
> = Decide.permittedFields as never

// Residual conditions

/**
 * What a residual condition reads: a value of the kind `K`. The principal is
 * already in it. A residual is for one kind, so when `K` is a union of kinds,
 * the value must be a value of each of them. No value is, so such a residual
 * can not be evaluated on a value of the wrong kind.
 *
 * @stability stable
 * @category utility types
 * @since 1.0.0
 */
export type ResidualReads<D, K> = Condition.Reads<
	(
		K extends unknown ? (value: Domain.ValueOf<D, K & string>) => void : never
	) extends (value: infer V) => void
		? V
		: never,
	unknown
>

/**
 * Gives the condition on resource values for which the policy allows a
 * request. It has no principal fields and no `Under` nodes, so you can give it
 * to `Condition.fold`. It is `True` when the policy allows every value of the
 * kind, and `False` when it allows none.
 *
 * With a scope (`within`), the condition is the scope and the residual
 * together, so it is false for every value outside the scope. Give the policy
 * first to use a scope. The condition comes from its parts, with no search. To
 * know if it allows all of the scope or none of it, use {@link coverage}.
 *
 * When a rule that the request may use has a predicate, the condition is one
 * predicate with the name `"policy"`. It runs the whole policy for each value,
 * so its answers and its failures are the same as those of {@link decide}. It
 * takes the principal with it. Give it resource values with their `_tag`. It
 * is false for a value of another kind.
 *
 * A policy tree may use the condition of a child two times, so a small policy
 * may give a very large condition. When the condition would have more than
 * 10000 nodes, this function throws an error. In an `Authorizer`, the error
 * is a defect, so the check fails.
 *
 * @stability stable
 * @category evaluation
 * @since 0.3.0
 */
export const residual: <
	D extends Domain.Any,
	X,
	const Req extends KindRequest<NoInfer<D>>,
>(
	policy: Policy<D, X>,
	request: Req,
) => Condition.Condition<ResidualReads<D, Req["kind"]>, X> =
	Analysis.residual as never

/**
 * How much of a scope a policy allows. In each case, `condition` is the exact
 * condition on the values in the scope that the policy allows: give it to
 * `Condition.fold` for a list query.
 * - `All`: the policy allows every value in the scope. `condition` is the
 *   scope (`True` with no scope).
 * - `None`: the policy allows no value in the scope. `condition` is `False`.
 *   An empty scope is `None` too, so a check on a scope that has a mistake,
 *   such as a principal field with no value, never passes.
 * - `Some`: the policy allows some values in the scope and not others.
 *   `allowed` is an example of a value that it allows, and `refused` of a
 *   value in the scope that it does not allow.
 * - `Unknown`: the answer needs a predicate, or the search went past its
 *   budget.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export type Coverage<I = unknown, X = never> = Data.TaggedEnum<{
	All: { readonly condition: Condition.Condition<I, X> }
	None: { readonly condition: Condition.Condition<I, X> }
	Some: {
		readonly condition: Condition.Condition<I, X>
		readonly allowed: Condition.Example
		readonly refused: Condition.Example
	}
	Unknown: {
		readonly condition: Condition.Condition<I, X>
		readonly reason: "predicate" | "budget"
	}
}>

/**
 * Tells how much of a scope the policy allows: all of it, none of it, or some
 * of it. See {@link Coverage}. With no scope (`within`), the scope is every
 * value of the kind.
 *
 * The answer comes from {@link Condition.satisfiable} with the shape of the
 * Schema of the resource. `All` and `None` hold for every value of the
 * Schema. `Some` means that, by the shape of the Schema, a value may get
 * either answer: a check such as a minimum length may still stop one of the
 * examples. `Unknown` comes only from a predicate or from the budget of the
 * search.
 *
 * `Some` does not mean that such a value is in your database. To know that,
 * run `condition` as a query.
 *
 * @stability stable
 * @category evaluation
 * @since 1.0.0
 */
export const coverage: <
	D extends Domain.Any,
	X,
	const Req extends KindRequest<NoInfer<D>>,
>(
	policy: Policy<D, X>,
	request: Req,
) => Coverage<ResidualReads<D, Req["kind"]>, X> = Analysis.coverageAny as never

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

/**
 * The Schema of the policies of a domain with no predicates. Decoding checks
 * every kind, action, field and principal field against the domain, and the
 * `meta` of each rule against the `meta` Schema of the domain.
 *
 * The decoder takes at most 256 levels of policies and 500 levels of
 * conditions, and at most 1000000 objects and array items, with a shared
 * object counted for each place. It reads only the own data fields of the
 * input.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema: <D extends Domain.Any>(
	domain: D,
) => Schema.Codec<Policy<D>, EncodedNode> = Internal.schema as never
