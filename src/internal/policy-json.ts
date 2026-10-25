/**
 * The JSON form of a policy tree. The decoder is a plain walk, as the decoder
 * of a condition is, and the two share one budget of `jsonNodes` objects and
 * items. It makes each node with its constructor, so the limits of the nodes
 * hold for a decoded tree too. The binding of the rules to the domain comes
 * after, in the Schema of the policy.
 */
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as Domain from "../Domain.ts"
import * as Rule from "./rule.ts"
import * as Json from "./json.ts"
import * as Limits from "./limits.ts"
import * as Place from "./place.ts"
import * as PolicyNodes from "./policy-nodes.ts"
import * as Trampoline from "./trampoline.ts"

type Node = PolicyNodes.Node

/**
 * The codec of the `meta` Schema of a domain to and from JSON. The JSON form
 * of a policy must stay the same through `JSON.stringify` and `JSON.parse`, so
 * a `Date` in `meta`, for one, becomes a string in it, and a string again
 * when it is decoded.
 */
const metaCodec = (meta: Schema.Top): Schema.Codec<unknown, unknown> =>
	Schema.toCodecJson(meta) as unknown as Schema.Codec<unknown, unknown>

/** Gives the JSON form of the `meta` of a rule, or `undefined` for none. */
export type MetaJson = (rule: Rule.Rule) => unknown

/**
 * Gives the JSON form of the `meta` of each rule at once, with the `meta`
 * Schema of a domain. `JSON.stringify` needs it at once, so the Schema must
 * not need an async step there.
 */
export const syncMeta =
	(meta: Schema.Top | undefined): MetaJson =>
	(rule) =>
		rule.meta === undefined || meta === undefined
			? undefined
			: Schema.encodeUnknownSync(metaCodec(meta))(rule.meta)

/** The JSON form of the condition of each rule, by the rule. */
type WhenJson = (rule: Rule.Rule) => unknown

/** Gives the JSON form of a rule. The domain of a rule is not in it. */
const ruleJson = (
	rule: Rule.Rule,
	metaJson: MetaJson,
	whenJson: WhenJson,
): unknown => {
	const meta = metaJson(rule)
	return {
		_tag: rule._tag,
		actions: rule.actions,
		resources: rule.resources,
		...(rule.when === undefined ? {} : { when: whenJson(rule) }),
		...(rule.fields === undefined ? {} : { fields: rule.fields }),
		...(rule.reason === undefined ? {} : { reason: rule.reason }),
		...(rule.id === undefined ? {} : { id: rule.id }),
		// The `meta` of a rule is a decoded value. Its JSON form comes from the
		// `meta` Schema of the domain.
		...(meta === undefined ? {} : { meta }),
	}
}

/**
 * Gives the JSON form of a policy tree with no predicate. A condition with a
 * predicate has no JSON form, so it throws an error. The conditions are
 * written first, from a flat list of the rules, so the walk does not go down
 * the levels of the tree and of a condition at once.
 */
export const toJson = (node: Node, meta: MetaJson): unknown => {
	// A native map, because it must find a rule by the rule itself: two rules
	// with the same data are `Equal`.
	const whens = new Map<Rule.Rule, unknown>(
		Arr.map(PolicyNodes.rulesOf(node), (rule) => [
			rule,
			rule.when === undefined ? undefined : Json.toJson(rule.when as never),
		]),
	)
	// The walk of the tree takes the steps of a trampoline, so a deep tree
	// does not fill the stack.
	return Trampoline.run(node.depth, (R) => {
		const tree = (current: Node): Trampoline.Step<unknown> => {
			switch (current._tag) {
				case "Rules":
					return R.succeed({
						_tag: "Rules",
						algorithm: current.algorithm,
						rules: Arr.map(current.rules, (rule) =>
							ruleJson(rule, meta, (found) => whens.get(found)),
						),
					})
				case "All":
				case "Any":
				case "FirstOf": {
					const tag = current._tag
					return R.map(
						R.forEach(current.policies, (child) =>
							R.suspend(() => tree(child)),
						),
						(policies) => ({ _tag: tag, policies }),
					)
				}
				case "Ceiling":
					return R.flatMap(
						R.suspend(() => tree(current.cap)),
						(cap) =>
							R.map(
								R.suspend(() => tree(current.policy)),
								(policy) => ({ _tag: "Ceiling", cap, policy }),
							),
					)
			}
		}
		return tree(node)
	})
}

/**
 * Gives the JSON form of a policy tree as an Effect. The `meta` Schema of the
 * domain may need an async step, so each `meta` is encoded as an Effect.
 */
export const encode = (
	node: Node,
	meta: Schema.Top | undefined,
): Effect.Effect<unknown, Schema.SchemaError> =>
	Effect.gen(function* () {
		const rules = Arr.filter(
			PolicyNodes.rulesOf(node),
			(rule) => rule.meta !== undefined,
		)
		const encoded =
			meta === undefined
				? []
				: yield* Effect.forEach(rules, (rule) =>
						Effect.map(
							Schema.encodeUnknownEffect(metaCodec(meta))(rule.meta),
							(json) => [rule, json] as const,
						),
					)
		// A native map, because it must find a rule by the rule itself: two
		// rules with the same data are `Equal`, and each keeps its own form.
		const forms = new Map<Rule.Rule, unknown>(encoded)
		return toJson(node, (rule) => forms.get(rule))
	})

/** Reads a list of strings. */
const readStrings = (
	input: object,
	name: string,
	at: Place.Place | undefined,
	budget: Json.Budget,
): ReadonlyArray<string> =>
	Arr.map(Json.readList(input, name, at, budget), (value, index) => {
		if (typeof value !== "string") {
			throw Json.problemAt(
				Place.at(at, name, index),
				"The item must be a string",
			)
		}
		return value
	})

/**
 * Reads a field that a rule may leave out. A field that the input has only
 * from the prototype of a class is not plain data, so it is a problem: a rule
 * that loses its condition would allow more.
 */
const readOptional = <A>(
	input: object,
	name: string,
	at: Place.Place | undefined,
	read: () => A,
): A | undefined => {
	if (Object.hasOwn(input, name)) {
		return read()
	}
	// A read of the field throws a problem when the field is not data.
	Json.read(input, name, at)
	return undefined
}

/** A value of the input to count, with its place. */
interface Part {
	readonly value: unknown
	readonly at: Place.Place | undefined
}

/**
 * Counts the objects and items of a value, as the other parts count. It is a
 * walk of the trampoline, so a deep value does not fill the stack.
 */
const spendValue = (budget: Json.Budget): ((part: Part) => void) =>
	Trampoline.adaptive<Part, void>((R, child) => (part, depth) => {
		const { value, at } = part
		if (typeof value !== "object" || value === null) {
			return R.succeed(undefined)
		}
		// The length of an array counts before its items are read, so a sparse
		// array with a very large length stops at once.
		const list = Array.isArray(value)
		if (list) {
			Json.spend(budget, 1 + value.length, at)
		}
		const names = list
			? Array.from({ length: value.length }, (_, index) => String(index))
			: Object.keys(value)
		if (!list) {
			Json.spend(budget, 1 + names.length, at)
		}
		return R.map(
			R.forEach(names, (name) =>
				child(
					{ value: Json.read(value, name, at), at: Place.at(at, name) },
					depth + 1,
				),
			),
			() => undefined,
		)
	})

/**
 * A rule in the input, with its place, to decode after the tree. The place
 * shares the path of its parent: see `Place`.
 */
interface RuleInput {
	readonly input: unknown
	readonly place: Place.Place
}

/**
 * The shape of a tree, with the place of each rule in a flat list. `size`
 * counts the nodes and the rules, as the nodes do, so a shared input stops
 * at `policyNodes` before the decoder reads all of it.
 */
type Plan =
	| {
			readonly _tag: "Rules"
			readonly place: Place.Place | undefined
			readonly size: number
			readonly algorithm: PolicyNodes.Algorithm
			readonly rules: ReadonlyArray<number>
	  }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly place: Place.Place | undefined
			readonly size: number
			readonly policies: ReadonlyArray<Plan>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly place: Place.Place | undefined
			readonly size: number
			readonly cap: Plan
			readonly policy: Plan
	  }

/**
 * Decodes the `meta` of a rule with the `meta` Schema of the domain, as an
 * Effect, since the Schema may need an async step. The Schema reads all of
 * the value, so its size counts in the budget.
 */
const decodeMeta = (
	rule: RuleInput,
	domain: Domain.Any,
	budget: Json.Budget,
): Effect.Effect<unknown, Json.Problem> => {
	const { input, place } = rule
	const at = Place.at(place, "meta")
	return Effect.flatMap(
		attempt(() =>
			typeof input !== "object" || input === null
				? undefined
				: readOptional(input, "meta", place, () => {
						const value = Json.read(input, "meta", place)
						if (domain.meta === undefined) {
							throw Json.problemAt(at, "The domain has no Schema for meta")
						}
						spendValue(budget)({ value, at })
						return { value, schema: domain.meta }
					}),
		),
		(found) =>
			found === undefined
				? Effect.void
				: Effect.mapError(
						Schema.decodeUnknownEffect(metaCodec(found.schema))(found.value),
						(error) =>
							new Json.Problem({
								path: Place.pathOf(at),
								message: error.message,
								issue: error.issue,
							}),
					),
	)
}

const decodeRule = (
	rule: RuleInput,
	meta: unknown,
	budget: Json.Budget,
	domain: Domain.Any,
): Rule.Rule => {
	const { input, place } = rule
	if (typeof input !== "object" || input === null) {
		throw Json.problemAt(place, "A rule must be an object")
	}
	Json.spend(budget, 1, place)
	const tag = Json.read(input, "_tag", place)
	if (tag !== "Allow" && tag !== "Deny") {
		throw Json.problemAt(
			Place.at(place, "_tag"),
			'A rule must be "Allow" or "Deny"',
		)
	}
	const when = readOptional(input, "when", place, () =>
		Json.decodeAt(
			Json.read(input, "when", place),
			Place.at(place, "when"),
			budget,
		),
	)
	const fields = readOptional(input, "fields", place, () =>
		readStrings(input, "fields", place, budget),
	)
	const reason = readOptional(input, "reason", place, () =>
		Json.readString(input, "reason", place),
	)
	const id = readOptional(input, "id", place, () =>
		Json.readString(input, "id", place),
	)
	// Each rule gets the domain of the Schema, as a rule from the builder of
	// the domain has it.
	return Rule.make({
		_tag: tag,
		actions: readStrings(input, "actions", place, budget),
		resources: readStrings(input, "resources", place, budget),
		...(when === undefined ? {} : { when: when as never }),
		...(fields === undefined ? {} : { fields }),
		...(reason === undefined ? {} : { reason }),
		...(id === undefined ? {} : { id }),
		...(meta === undefined ? {} : { meta }),
		domain,
	})
}

/** A node of the input of a tree, with its place. */
interface TreePart {
	readonly input: unknown
	readonly at: Place.Place | undefined
}

/**
 * Reads the shape of a tree, and puts each rule in `rules`. The rules are
 * decoded after the walk: a condition has levels of its own, and a decode
 * inside the walk would go down the levels of both. The walk is a walk of
 * the trampoline, so a deep tree does not fill the stack.
 */
const readTree = (
	budget: Json.Budget,
	// The rules of one decode. The list belongs to that decode.
	rules: Array<RuleInput>,
): ((part: TreePart) => Plan) =>
	Trampoline.adaptive<TreePart, Plan>((R, child) => (part, depth) => {
		const { input, at } = part
		if (typeof input !== "object" || input === null) {
			throw Json.problemAt(at, "A node of a policy must be an object")
		}
		Json.spend(budget, 1, at)
		const below = (value: unknown, ...parts: ReadonlyArray<PropertyKey>) =>
			child({ input: value, at: Place.at(at, ...parts) }, depth + 1)
		const tag = Json.read(input, "_tag", at)
		switch (tag) {
			case "Rules": {
				const algorithm = Json.readString(input, "algorithm", at)
				if (!PolicyNodes.isAlgorithm(algorithm)) {
					throw Json.problemAt(
						Place.at(at, "algorithm"),
						`"${algorithm}" is not a combining algorithm`,
					)
				}
				const found = Arr.map(
					Json.readList(input, "rules", at, budget),
					(rule, index) =>
						rules.push({
							input: rule,
							place: Place.at(at, "rules", index),
						}) - 1,
				)
				return R.succeed(
					sized(budget, {
						_tag: "Rules",
						place: at,
						size: 1 + found.length,
						algorithm,
						rules: found,
					}),
				)
			}
			case "All":
			case "Any":
			case "FirstOf":
				return R.map(
					R.forEach(
						Json.readList(input, "policies", at, budget),
						(value, index) => below(value, "policies", index),
					),
					(policies) =>
						sized(budget, {
							_tag: tag,
							place: at,
							size: Arr.reduce(policies, 1, (total, plan) => total + plan.size),
							policies,
						}),
				)
			case "Ceiling": {
				const cap = Json.read(input, "cap", at)
				const policy = Json.read(input, "policy", at)
				return R.flatMap(below(cap, "cap"), (capPlan) =>
					R.map(below(policy, "policy"), (policyPlan) =>
						sized(budget, {
							_tag: "Ceiling",
							place: at,
							size: 1 + capPlan.size + policyPlan.size,
							cap: capPlan,
							policy: policyPlan,
						}),
					),
				)
			}
			default:
				throw Json.problemAt(Place.at(at, "_tag"), "The node has no known tag")
		}
	})

/** Stops a plan past `policyNodes`, with the message of the nodes. */
const sized = (budget: Json.Budget, plan: Plan): Plan => {
	const most = budget.limits.policyNodes
	if (plan.size > most) {
		throw Json.problemAt(
			plan.place,
			`A policy tree has ${String(plan.size)} nodes. The most is ${String(most)}.`,
		)
	}
	return plan
}

/**
 * Makes the nodes of a plan, with the decoded rules. It is a walk of the
 * trampoline, so a deep plan does not fill the stack.
 */
const build = (
	budget: Json.Budget,
	rules: ReadonlyArray<Rule.Rule>,
): ((plan: Plan) => Node) =>
	Trampoline.adaptive<Plan, Node>((R, child) => (plan, depth) => {
		// A node past a limit is a problem at its place. The constructor checks
		// the ceilings, and the decoder checks the limits of the domain, with
		// the nodes and values of the conditions.
		const make = (made: () => Node): Node => {
			const node = (() => {
				try {
					return made()
				} catch (error) {
					if (error instanceof Limits.LimitExceeded) {
						throw Json.problemAt(plan.place, error.message)
					}
					throw error
				}
			})()
			const most = budget.limits.policyNodes
			if (node.size > most) {
				throw Json.problemAt(
					plan.place,
					`A policy tree has ${String(node.size)} nodes. The most is ${String(most)}.`,
				)
			}
			return node
		}
		switch (plan._tag) {
			case "Rules":
				return R.succeed(
					make(
						() =>
							new PolicyNodes.Rules({
								algorithm: plan.algorithm,
								rules: Arr.map(plan.rules, (index) => rules[index]!),
							}),
					),
				)
			case "All":
			case "Any":
			case "FirstOf": {
				const tag = plan._tag
				return R.map(
					R.forEach(plan.policies, (inner) => child(inner, depth + 1)),
					(policies) => make(() => new PolicyNodes[tag](policies)),
				)
			}
			case "Ceiling":
				return R.flatMap(child(plan.cap, depth + 1), (cap) =>
					R.map(child(plan.policy, depth + 1), (policy) =>
						make(() => new PolicyNodes.Ceiling({ cap, policy })),
					),
				)
		}
	})

/** Runs a step that may throw a problem, and puts the problem in the error. */
const attempt = <A>(step: () => A): Effect.Effect<A, Json.Problem> =>
	Effect.try({
		try: step,
		catch: (error) => {
			if (error instanceof Json.Problem) {
				return error
			}
			throw error
		},
	})

/**
 * Decodes the JSON form of a policy tree for a domain. It reads the tree
 * first, then the `meta` of each rule as an Effect, then the rules, and it
 * makes the nodes last.
 */
export const decode = (
	input: unknown,
	domain: Domain.Any,
): Effect.Effect<Node, Json.Problem> =>
	Effect.gen(function* () {
		const budget: Json.Budget = { used: 0, limits: domain.limits }
		// The rules of this decode. The list belongs to this decode.
		const inputs: Array<RuleInput> = []
		const plan = yield* attempt(() =>
			readTree(budget, inputs)({ input, at: undefined }),
		)
		const metas = yield* Effect.forEach(inputs, (rule) =>
			decodeMeta(rule, domain, budget),
		)
		const rules = yield* attempt(() =>
			Arr.map(inputs, (rule, index) =>
				decodeRule(rule, metas[index], budget, domain),
			),
		)
		return yield* attempt(() => build(budget, rules)(plan))
	})
