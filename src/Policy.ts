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
import * as Arr from "effect/Array"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Option from "effect/Option"
import type * as Pipeable from "effect/Pipeable"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as SchemaTransformation from "effect/SchemaTransformation"
import * as Condition from "./Condition.ts"
import * as Algebra from "./internal/algebra.ts"
import * as Bind from "./internal/bind.ts"
import * as Catalog from "./internal/catalog.ts"
import * as Limits from "./internal/limits.ts"
import * as Nodes from "./internal/nodes.ts"
import * as PolicyJson from "./internal/policy-json.ts"
import * as PolicyNodes from "./internal/policy-nodes.ts"
import * as RuleData from "./internal/rule.ts"
import * as Search from "./internal/search.ts"
import * as Decision from "./Decision.ts"
import * as Domain from "./Domain.ts"
import * as Resource from "./Resource.ts"

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
	readonly rules: ReadonlyArray<AnyRule>
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
 * The tree of a policy with the types of its predicates and its domain `D`.
 * Each rule and each child has the types too, and `"~Node"` is only in the types. A node made by
 * hand does not have it. So the node of one policy, or a part of it, can not
 * go into a policy with other types.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export type TypedNode<E = never, R = never, O = never, D = any> = (
	| {
			readonly _tag: "Rules"
			readonly algorithm: Algorithm
			// The rules may read different values, so a node keeps no one type of
			// what they read. With `never`, a condition taken from a node fits no
			// rule that reads a value or a principal.
			readonly rules: ReadonlyArray<Rule<E, R, O, D, never>>
	  }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly policies: ReadonlyArray<TypedNode<E, R, O, D>>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly cap: TypedNode<E, R, O, D>
			readonly policy: TypedNode<E, R, O, D>
	  }
) & {
	readonly "~Node": Condition.Variance<E, R, O>
}

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
	readonly node: TypedNode<E, R, O, D>
	readonly "~Policy": Condition.Variance<E, R, O>
	/**
	 * Only in the types. A policy reads the values and the principal of its
	 * domain, so a policy of one domain is not a policy of a wider domain.
	 */
	readonly "~Domain": (domain: D) => D
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
	never,
	never,
	never,
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
 * A rule. `E`, `R` and `O` come from its condition. See
 * `Condition.Condition`. `D` is the domain of the rule. A predicate reads the
 * values and the principal of its domain, so a rule may go only into a policy
 * of its own domain. A rule from {@link rule} has the domain `any`. `I` is
 * what the predicates of its condition read. See `Condition.Reads`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Rule<E = never, R = never, O = never, D = any, I = unknown>
	extends RuleShape<E, R, O, I>, Pipeable.Pipeable {
	readonly "~Rule": Condition.Variance<E, R, O>
	readonly "~Domain": (domain: D) => D
	[Symbol.iterator](): Generator<
		Rule<E, R, O, D, I>,
		Rule<E, R, O, D, I>,
		unknown
	>
}

/**
 * The data of a rule.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export interface RuleShape<E = never, R = never, O = never, I = unknown> {
	readonly _tag: "Allow" | "Deny"
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: Condition.Condition<E, R, O, I>
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
export type AnyRule = Rule<any, any, any, any, never>

/**
 * The error type of a rule.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type RuleError<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer E, infer _R, infer _O>
}
	? E
	: never

/**
 * The service type of a rule.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type RuleServices<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer _E, infer R, infer _O>
}
	? R
	: never

/**
 * `Condition.Opaque` when a rule has a predicate.
 *
 * @stability stable
 * @category utility types
 * @since 0.3.0
 */
export type RuleOpaque<A> = A extends {
	readonly "~Rule"?: Condition.Variance<infer _E, infer _R, infer O>
}
	? O
	: never

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
	any,
	any,
	any,
	Condition.Reads<ValueFor<D, K>, Domain.Principal<D>>
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
	) => C & Condition.Checked<C>
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
	) => Rule<
		Condition.Error<C>,
		Condition.Services<C>,
		Condition.OpaqueOf<C>,
		D,
		Condition.ReadsOf<C>
	>
	readonly deny: <
		const Res extends SingleOrArray<RuleTarget<D>>,
		const A extends ActionForTargets<D, Res>,
		const C extends ConditionFor<D, KindOf<TargetOf<Res>>> =
			Condition.Condition,
	>(
		action: SingleOrArray<A>,
		resource: Res,
		options?: RuleOptions<D, KindOf<TargetOf<Res>>, C>,
	) => Rule<
		Condition.Error<C>,
		Condition.Services<C>,
		Condition.OpaqueOf<C>,
		D,
		Condition.ReadsOf<C>
	>
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
export const rule = <E = never, R = never, O = never, I = unknown>(
	data: RuleShape<E, R, O, I>,
): Rule<E, R, O, any, I> => RuleData.make(data as never) as never

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
 * The class of every policy value. Two policies of one domain with the same
 * tree are equal. As JSON, a policy is its tree.
 */
class PolicyData extends Data.Class<{
	readonly domain: Domain.Any
	readonly node: PolicyNodes.Node
}> {
	toJSON(): unknown {
		return PolicyJson.toJson(this.node, this.domain.meta)
	}
}

/** The node of a policy, with no types, for the code below. */
const nodeOf = (policy: Any): PolicyNodes.Node => policy.node as never

const fromNode = (domain: Domain.Any, node: PolicyNodes.Node): any =>
	new PolicyData({ domain, node })

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

/**
 * Makes a policy from a list of rules.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const rules: <
	D extends Domain.Any,
	Rules extends Rule<any, any, any, D, never>,
>(
	domain: D,
	rules: Iterable<Rules>,
	options?: Options,
) => Policy<D, RuleError<Rules>, RuleServices<Rules>, RuleOpaque<Rules>> = (
	domain,
	values,
	options,
) => {
	// The constructor takes only rules, and it stops a list past the limits.
	const node = new PolicyNodes.Rules({
		algorithm: options?.algorithm ?? "denyOverrides",
		rules: Array.from(values),
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
export const define =
	<D extends Domain.Any>(domain: D, options?: Options) =>
	<Rules extends Rule<any, any, any, D, never>, A>(
		body: (builder: Builder<D>) => Generator<Rules, A, unknown>,
	): Policy<D, RuleError<Rules>, RuleServices<Rules>, RuleOpaque<Rules>> => {
		const iterator = body(builder(domain))
		// Each rule goes back into the generator, as `yield*` gives it.
		const collected = Arr.unfold(iterator.next(), (state) =>
			state.done === true
				? Option.none()
				: Option.some([state.value, iterator.next(state.value)] as const),
		)
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
const combine =
	(tag: "All" | "Any" | "FirstOf") =>
	(policies: ReadonlyArray<Any>): any =>
		fromNode(
			sameDomain(policies),
			new PolicyNodes[tag](Arr.map(policies, nodeOf)),
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
					value.when === undefined || !Condition.hasPredicate(value.when)
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
	): <D extends Domain.Any, E, O>(
		policy: Policy<D, E, R, O>,
	) => Policy<D, E, never, O>
	<D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O>,
		context: Context.Context<R>,
	): Policy<D, E, never, O>
} = dual(2, (policy: Any, context: Context.Context<never>): any =>
	fromNode(policy.domain, provideNode(nodeOf(policy), context)),
)

// Decisions

interface DecideContext {
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly input: Condition.Input
	/** The resource of the kind, for the fields that a rule may grant. */
	readonly descriptor: Resource.Descriptor
	/** The rules that were tested, for {@link explain}. */
	readonly trace: Ref.Ref<Chunk.Chunk<Step>> | undefined
}

const ruleApplies = (
	value: RuleData.Rule,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<boolean, unknown, unknown> => {
	if (!RuleData.matchesTarget(value, context)) {
		return Effect.succeed(false)
	}
	const test =
		value.when === undefined
			? Effect.succeed(true)
			: // A rule of a node keeps no type of what it reads. The decision gives
				// it the value and the principal of the request.
				Condition.evaluate(value.when as Condition.Any, context.input)
	const trace = context.trace
	return trace === undefined
		? test
		: Effect.tap(test, (applies) =>
				// A chunk adds a step with no copy of the steps before.
				Ref.update(trace, Chunk.append({ path, rule: typed(value), applies })),
			)
}

/** A rule of a node, with the type of a rule of no domain. */
const typed = (value: RuleData.Rule): AnyRule => value as never

const fromRule = (value: RuleData.Rule): Decision.Decision =>
	value._tag === "Allow"
		? Decision.Allow({ rule: typed(value) })
		: value.reason === undefined
			? Decision.Deny({ rule: typed(value) })
			: Decision.Deny({ rule: typed(value), reason: value.reason })

/** Gives the first rule that applies, in order. */
const firstApplying = (
	candidates: ReadonlyArray<readonly [RuleData.Rule, number]>,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Option.Option<RuleData.Rule>, unknown, unknown> =>
	Effect.map(
		Effect.findFirst(candidates, ([value, index]) =>
			ruleApplies(value, context, [...path, index]),
		),
		Option.map(([value]) => value),
	)

/** Gives the first result that is found, and tests `next` only when none is. */
const orElse = <A, E, R>(
	first: Effect.Effect<Option.Option<A>, E, R>,
	next: () => Effect.Effect<Option.Option<A>, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
	Effect.filterOrElse(first, Option.isSome, next)

const decideRules = (
	node: PolicyNodes.Rules,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	const indexed = Arr.map(node.rules, (value, index) => [value, index] as const)
	const denies = Arr.filter(indexed, ([value]) => value._tag === "Deny")
	const allows = Arr.filter(indexed, ([value]) => value._tag === "Allow")
	const first = (candidates: ReadonlyArray<readonly [RuleData.Rule, number]>) =>
		firstApplying(candidates, context, path)
	const found = (() => {
		switch (node.algorithm) {
			case "denyOverrides":
				return orElse(first(denies), () => first(allows))
			case "permitOverrides":
				return orElse(first(allows), () => first(denies))
			case "firstApplicable":
				return first(indexed)
			case "lastApplicable":
				return first(Arr.reverse(indexed))
		}
	})()
	return Effect.map(
		found,
		Option.match({ onNone: () => Decision.NotApplicable, onSome: fromRule }),
	)
}

/** The next step of a walk over children: stop with a decision, or go on. */
type WalkStep<S> =
	| { readonly _tag: "Stop"; readonly decision: Decision.Decision }
	| { readonly _tag: "Next"; readonly state: S }

/**
 * Decides the children in order. After each child, `step` stops with a
 * decision, or gives the state for the next child. After the last child,
 * `end` gives the decision. A child after a stop is not decided, so its
 * predicates do not run.
 */
const walkChildren = <S>(
	children: ReadonlyArray<PolicyNodes.Node>,
	context: DecideContext,
	path: ReadonlyArray<number>,
	start: S,
	step: (state: S, decision: Decision.Decision) => WalkStep<S>,
	end: (state: S) => Decision.Decision,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	const go = (
		index: number,
		state: S,
	): Effect.Effect<Decision.Decision, unknown, unknown> =>
		index === children.length
			? Effect.succeed(end(state))
			: Effect.flatMap(
					decideNode(children[index]!, context, [...path, index]),
					(decision) => {
						const next = step(state, decision)
						return next._tag === "Stop"
							? Effect.succeed(next.decision)
							: go(index + 1, next.state)
					},
				)
	return go(0, start)
}

const stop = (decision: Decision.Decision): WalkStep<never> => ({
	_tag: "Stop",
	decision,
})

const next = <S>(state: S): WalkStep<S> => ({ _tag: "Next", state })

/**
 * Decides a node. A shared child is decided again for each place, so its
 * predicates run each time, as the policy says. The limits of the nodes keep
 * this work small.
 */
const decideNode = (
	node: PolicyNodes.Node,
	context: DecideContext,
	path: ReadonlyArray<number>,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	switch (node._tag) {
		case "Rules":
			return decideRules(node, context, path)
		case "All":
			// One deny is enough to deny. Every child must allow.
			return walkChildren(
				node.policies,
				context,
				path,
				{
					firstAllow: Option.none<Decision.Decision>(),
					allAllow: node.policies.length > 0,
				},
				(state, decision) =>
					decision._tag === "Deny"
						? stop(decision)
						: next({
								firstAllow: Option.orElse(state.firstAllow, () =>
									decision._tag === "Allow"
										? Option.some(decision)
										: Option.none(),
								),
								allAllow: state.allAllow && decision._tag === "Allow",
							}),
				(state) =>
					state.allAllow
						? Option.getOrElse(state.firstAllow, () => Decision.NotApplicable)
						: Decision.NotApplicable,
			)
		case "Any":
			// One allow is enough. Without one, the first deny denies.
			return walkChildren(
				node.policies,
				context,
				path,
				Option.none<Decision.Decision>(),
				(firstDeny, decision) =>
					decision._tag === "Allow"
						? stop(decision)
						: next(
								Option.orElse(firstDeny, () =>
									decision._tag === "Deny"
										? Option.some(decision)
										: Option.none(),
								),
							),
				(firstDeny) =>
					Option.getOrElse(firstDeny, () => Decision.NotApplicable),
			)
		case "FirstOf":
			return walkChildren(
				node.policies,
				context,
				path,
				undefined,
				(_, decision) =>
					decision._tag === "NotApplicable" ? next(undefined) : stop(decision),
				() => Decision.NotApplicable,
			)
		case "Ceiling":
			// A deny of the cap wins. Else the policy decides.
			return Effect.filterOrElse(
				decideNode(node.cap, context, [...path, 0]),
				(capped) => capped._tag === "Deny",
				() => decideNode(node.policy, context, [...path, 1]),
			)
	}
}

/**
 * Tests if a request fits its kind: the action is an action of the kind, and
 * the field, if there is one, is a field of the kind. The types check this,
 * but a value with a union type, or a value from outside, may get past them.
 * A rule for every action (`"*"`) must not cover an action that the kind does
 * not have, so such a request is not applicable.
 *
 * @stability stable
 * @category predicates
 * @since 1.0.0
 */
export const fitsKind = (
	descriptor: Resource.Descriptor,
	request: { readonly action: string; readonly field?: string | undefined },
): boolean =>
	descriptor.actions.includes(request.action) &&
	(request.field === undefined ||
		(Catalog.lookup(descriptor.catalog, request.field)?.listed ?? false))

const makeContext = (
	domain: Domain.Any,
	request: AnyRequest,
	trace: Ref.Ref<Chunk.Chunk<Step>> | undefined,
): DecideContext | undefined => {
	const kind = Resource.kindOf(request.resource)
	const descriptor =
		kind === undefined ? undefined : Domain.descriptorOf(domain, kind)
	if (
		kind === undefined ||
		descriptor === undefined ||
		!fitsKind(descriptor, request)
	) {
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
		descriptor,
		trace,
	}
}

const decideAny = (
	policy: Any,
	request: AnyRequest,
): Effect.Effect<Decision.Decision, unknown, unknown> =>
	// The context reads the resource value, so it is made for each run.
	Effect.suspend(() => {
		const context = makeContext(policy.domain, request, undefined)
		return context === undefined
			? Effect.succeed(Decision.NotApplicable)
			: decideNode(nodeOf(policy), context, [])
	})

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
 * One node may be a child of many nodes. Its rules are tested, and are in the
 * steps, each time that the decision comes to it.
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
		Effect.gen(function* () {
			const trace = yield* Ref.make(Chunk.empty<Step>())
			const context = makeContext(policy.domain, request, trace)
			if (context === undefined) {
				return { decision: Decision.NotApplicable, steps: [] }
			}
			const decision = yield* decideNode(nodeOf(policy), context, [])
			return { decision, steps: Chunk.toReadonlyArray(yield* Ref.get(trace)) }
		}),
) as never

/**
 * Tests if a deny rule of the request names a part inside `field`.
 */
const deniesInside = (
	node: PolicyNodes.Node,
	target: { readonly action: string; readonly kind: string },
	field: string,
): boolean => {
	switch (node._tag) {
		case "Rules":
			return node.rules.some(
				(value) =>
					value._tag === "Deny" &&
					value.fields !== undefined &&
					value.fields.some((pattern) =>
						RuleData.matchesInside(pattern, field),
					) &&
					(value.actions.includes("*") ||
						value.actions.includes(target.action)) &&
					(value.resources.includes("*") ||
						value.resources.includes(target.kind)),
			)
		case "All":
		case "Any":
		case "FirstOf":
			return node.policies.some((child) => deniesInside(child, target, field))
		case "Ceiling":
			return (
				deniesInside(node.cap, target, field) ||
				deniesInside(node.policy, target, field)
			)
	}
}

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
	(
		policy: Any,
		request: Omit<AnyRequest, "field">,
	): Effect.Effect<ReadonlyArray<string>, unknown, unknown> => {
		const kind = Resource.kindOf(request.resource)
		const descriptor: Resource.Descriptor | undefined =
			kind === undefined ? undefined : Domain.descriptorOf(policy.domain, kind)
		if (descriptor === undefined) {
			return Effect.succeed([])
		}
		// The fields with names only: a list can not name every key of a record.
		const listed = Arr.filter(
			descriptor.catalog.fields,
			(field) =>
				field.listed &&
				Arr.every(field.path, (segment) => typeof segment === "string"),
		)
		return Effect.map(
			Effect.filter(listed, (field) =>
				Effect.map(
					decideAny(policy, { ...request, field: field.text }),
					(result) =>
						result._tag === "Allow" &&
						!(
							field.open &&
							deniesInside(
								nodeOf(policy),
								{ ...request, kind: descriptor.kind },
								field.text,
							)
						),
				),
			),
			Arr.map((field) => field.text),
		)
	},
) as never

// Residual conditions

type Ast = Condition.Ast

/**
 * The two residual conditions of a request. See {@link residuals}.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export interface Residuals<E = never, R = never, O = never, I = unknown> {
	/** The condition on resource values for which the policy allows. */
	readonly allow: Condition.Condition<E, R, O, I>
	/** The condition on resource values for which the policy denies. */
	readonly deny: Condition.Condition<E, R, O, I>
}

/**
 * A request about a kind of resource, with no types.
 *
 * @stability stable
 * @category models
 * @since 1.0.0
 */
export interface AnyKindRequest {
	readonly principal: object
	readonly action: string
	readonly kind: string
	readonly field?: string | undefined
	/**
	 * A scope needs the types of the domain for its builder. With the request
	 * first, the domain is not known yet, so give the policy first.
	 */
	readonly within?: never
}

/**
 * `unknown` when the request `Req` is a request of the type `T`, and `never`
 * when it is not. With the request first and the policy later, the request is
 * checked when the policy, and so the domain, is known. For a union, each
 * member must be such a request.
 */
type Fits<Req, T> = [Req] extends [T] ? unknown : never

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
}

const ruleCondition = (value: RuleData.Rule, context: ResidualContext): Ast =>
	!RuleData.matchesTarget(value, context)
		? never
		: value.when === undefined
			? always
			: Condition.partial(value.when as Condition.Any, context.input)

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
					Condition.hasPredicate(value.when) &&
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
	if (Condition.hasPredicate(ast)) {
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
interface ScopedRequest {
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

const residualsAny = (policy: Any, request: ScopedRequest): Pair =>
	scopedResiduals(policy, request)

const scopedResiduals = (policy: Any, request: ScopedRequest): Scoped => {
	const descriptor = Domain.descriptorOf(policy.domain, request.kind)
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
	const context: ResidualContext = {
		action: request.action,
		kind: request.kind,
		field: request.field,
		input,
		descriptor,
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
				trace: undefined,
			},
			[],
		)
	// A value of another kind is not a value that the residual is about, so
	// the rules of this kind must not run on it.
	const test = (tag: Decision.Decision["_tag"]): Ast =>
		Condition.builder<any, any, any>().predicate(policyPredicate, (value) =>
			Resource.kindOf(value) === request.kind
				? Effect.map(decision(value), (result) => result._tag === tag)
				: Effect.succeed(false),
		)
	// The scope comes first in each `And`, so the policy runs only on values
	// in the scope.
	return inScope({ allow: test("Allow"), deny: test("Deny") })
}

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
export const residual: {
	<const Req extends AnyKindRequest>(
		request: Req,
	): <D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O> & Fits<Req, KindRequest<D>>,
	) => Condition.Condition<E, R, O, ResidualReads<D, Req["kind"]>>
	<D extends Domain.Any, E, R, O, const Req extends KindRequest<NoInfer<D>>>(
		policy: Policy<D, E, R, O>,
		request: Req,
	): Condition.Condition<E, R, O, ResidualReads<D, Req["kind"]>>
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
 * @since 1.0.0
 */
export const residuals: {
	<const Req extends AnyKindRequest>(
		request: Req,
	): <D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O> & Fits<Req, KindRequest<D>>,
	) => Residuals<E, R, O, ResidualReads<D, Req["kind"]>>
	<D extends Domain.Any, E, R, O, const Req extends KindRequest<NoInfer<D>>>(
		policy: Policy<D, E, R, O>,
		request: Req,
	): Residuals<E, R, O, ResidualReads<D, Req["kind"]>>
} = dual(2, residualsAny) as never

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
export type Coverage<
	E = never,
	R = never,
	O = never,
	I = unknown,
> = Data.TaggedEnum<{
	All: { readonly condition: Condition.Condition<E, R, O, I> }
	None: { readonly condition: Condition.Condition<E, R, O, I> }
	Some: {
		readonly condition: Condition.Condition<E, R, O, I>
		readonly allowed: Condition.Example
		readonly refused: Condition.Example
	}
	Unknown: {
		readonly condition: Condition.Condition<E, R, O, I>
		readonly reason: "predicate" | "budget"
	}
}>

/** A {@link Coverage} with no types. */
type AnyCoverage = Data.TaggedEnum<{
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

const coverageAny = (policy: Any, request: ScopedRequest): AnyCoverage => {
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

/**
 * Decides a request about every value in a scope, with at most two searches.
 * - `Allow`: the scope has a value, and the policy allows each value in it.
 * - `NotApplicable`: the scope has a value, and the policy denies no value in
 *   it, but it does not allow each one. A decider may answer.
 * - `Deny`: else. An empty scope, a search that can not say, or a predicate
 *   that may fail is a "no".
 *
 * The searches read the shape of the Schema. `Allow` needs no value outside
 * the residual, and `NotApplicable` needs no value in the residual of the
 * denials, so both hold for every real value. That the scope has a value
 * holds for the shape only.
 */
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
export const coverage: {
	<const Req extends AnyKindRequest>(
		request: Req,
	): <D extends Domain.Any, E, R, O>(
		policy: Policy<D, E, R, O> & Fits<Req, KindRequest<D>>,
	) => Coverage<E, R, O, ResidualReads<D, Req["kind"]>>
	<D extends Domain.Any, E, R, O, const Req extends KindRequest<NoInfer<D>>>(
		policy: Policy<D, E, R, O>,
		request: Req,
	): Coverage<E, R, O, ResidualReads<D, Req["kind"]>>
} = dual(2, coverageAny) as never

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
 * The decoder takes at most 256 levels of policies and 1000 levels of
 * conditions, and at most 1000000 objects and array items, with a shared
 * object counted for each place. It reads only the own data fields of the
 * input.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const schema = <D extends Domain.Any>(
	domain: D,
): Schema.Codec<Policy<D>, EncodedNode> =>
	Schema.Unknown.pipe(
		Schema.decodeTo(
			// A policy with a predicate is not a plain policy, and it can not
			// become JSON.
			Schema.declare(
				(u): u is Policy<D> =>
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
				encode: (policy: Policy<D>) =>
					Effect.sync(() => PolicyJson.toJson(nodeOf(policy), domain.meta)),
			}),
		),
	) as never
