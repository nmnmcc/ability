/**
 * The decision walk of a policy: `decide`, `explain` and `permittedFields`.
 * The types are in `Policy.ts`.
 */
// A policy keeps the error type and the service type of its predicates in the
// public types. The code below works on the nodes with no types, where they
// are `unknown`, so the language service check for `unknown` in an Effect is
// off here.
// @effect-diagnostics anyUnknownInErrorContext:off
import * as Arr from "effect/Array"
import * as Chunk from "effect/Chunk"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Condition from "../Condition.ts"
import * as Decision from "../Decision.ts"
import type * as Domain from "../Domain.ts"
import type * as Policy from "../Policy.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as DomainData from "./domain.ts"
import * as PolicyNodes from "./policy-nodes.ts"
import { nodeOf } from "./policy.ts"
import * as ResourceData from "./resource.ts"
import * as RuleData from "./rule.ts"

type Any = Policy.Any
type AnyRequest = Policy.AnyRequest
type AnyRule = Policy.AnyRule
type Explanation = Policy.Explanation
type Step = Policy.Step

/** The steps of one explanation. */
type Trace = Ref.Ref<Chunk.Chunk<Step>>

interface DecideContext {
	readonly action: string
	readonly kind: string
	readonly field: string | undefined
	readonly input: Condition.Input
	/** The resource of the kind, for the fields that a rule may grant. */
	readonly descriptor: Resource.Descriptor
	/** The test of `RuleData.fitsOf` for the catalog, for this decision. */
	readonly fits: (field: string) => boolean
	/** The tests of the field paths on the field, for this decision. */
	readonly fieldTest: RuleData.FieldTest | undefined
	/** The rules that were tested, for {@link explain}. */
	readonly trace: Trace | undefined
}

/**
 * The place of a node or a rule in a tree.
 */
type At = ReadonlyArray<number>

const ruleApplies = (
	value: RuleData.Rule,
	context: DecideContext,
	at: At,
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
				Ref.update(
					trace,
					Chunk.append({ path: at, rule: typed(value), applies }),
				),
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
	at: At,
): Effect.Effect<Option.Option<RuleData.Rule>, unknown, unknown> =>
	Effect.map(
		Effect.findFirst(candidates, ([value, index]) =>
			ruleApplies(value, context, [...at, index]),
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
	at: At,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	const indexed = Arr.map(node.rules, (value, index) => [value, index] as const)
	const denies = Arr.filter(indexed, ([value]) => value._tag === "Deny")
	const allows = Arr.filter(indexed, ([value]) => value._tag === "Allow")
	const first = (candidates: ReadonlyArray<readonly [RuleData.Rule, number]>) =>
		firstApplying(candidates, context, at)
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
	at: At,
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
					// Each call for a child is a step of the Effect, so a deep tree
					// does not fill the stack.
					Effect.suspend(() =>
						decideNode(children[index]!, context, [...at, index]),
					),
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
 * predicates run each time, as the policy says.
 */
export const decideNode = (
	node: PolicyNodes.Node,
	context: DecideContext,
	at: At,
): Effect.Effect<Decision.Decision, unknown, unknown> => {
	switch (node._tag) {
		case "Rules":
			return decideRules(node, context, at)
		case "All":
			// One deny is enough to deny. Every child must allow.
			return walkChildren(
				node.policies,
				context,
				at,
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
				at,
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
				at,
				undefined,
				(_, decision) =>
					decision._tag === "NotApplicable" ? next(undefined) : stop(decision),
				() => Decision.NotApplicable,
			)
		case "Ceiling":
			// A deny of the cap wins. Else the policy decides.
			return Effect.filterOrElse(
				Effect.suspend(() => decideNode(node.cap, context, [...at, 0])),
				(capped) => capped._tag === "Deny",
				() => decideNode(node.policy, context, [...at, 1]),
			)
	}
}

/**
 * Tests if a request fits its kind: the action is an action of the kind, and
 * the field, if there is one, is a field of the kind.
 */
export const fitsKind = (
	descriptor: Resource.Descriptor,
	request: { readonly action: string; readonly field?: string | undefined },
): boolean =>
	descriptor.actions.includes(request.action) &&
	(request.field === undefined ||
		Catalog.lookup(descriptor.catalog, request.field) !== undefined)

const makeContext = (
	domain: Domain.Any,
	request: AnyRequest,
	trace: Trace | undefined,
): DecideContext | undefined => {
	const kind = ResourceData.kindOf(request.resource)
	const descriptor =
		kind === undefined ? undefined : DomainData.descriptorOf(domain, kind)
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
		fits: RuleData.fitsOf(descriptor.catalog),
		fieldTest:
			request.field === undefined
				? undefined
				: RuleData.fieldTestOf(request.field, descriptor),
		trace,
	}
}

export const decideAny = (
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

/** Gives the decision of a policy with no predicates, at once. */
export const decideSync = (
	policy: Any,
	request: AnyRequest,
): Decision.Decision =>
	Effect.runSync(
		// The public type of `decideSync` takes only policies with no
		// predicates, so this Effect has no error and needs no services.
		// @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
		decideAny(policy, request) as Effect.Effect<Decision.Decision>,
	)

/** Gives the decision of a policy and the rules that were tested to make it. */
export const explain = (
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
		return {
			decision,
			steps: Chunk.toReadonlyArray(yield* Ref.get(trace)),
		}
	})

/** Gives the fields of a resource value that the policy lets a request use. */
export const permittedFields = (
	policy: Any,
	request: Omit<AnyRequest, "field">,
): Effect.Effect<ReadonlyArray<string>, unknown, unknown> => {
	const kind = ResourceData.kindOf(request.resource)
	const descriptor: Resource.Descriptor | undefined =
		kind === undefined
			? undefined
			: DomainData.descriptorOf(policy.domain, kind)
	if (descriptor === undefined) {
		return Effect.succeed([])
	}
	// List the named fields that the fixed directory exposes.
	const listed = Arr.filter(
		Catalog.fieldsOf(descriptor.catalog),
		(field) =>
			field.listed &&
			Arr.every(field.path, (segment) => typeof segment === "string"),
	)
	return Effect.map(
		Effect.filter(listed, (field) =>
			Effect.map(
				decideAny(policy, { ...request, field: field.text }),
				(result) => result._tag === "Allow",
			),
		),
		Arr.map((field) => field.text),
	)
}
