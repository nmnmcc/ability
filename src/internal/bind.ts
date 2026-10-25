/**
 * The binding of rules to a domain. It is the one check of a rule, for a rule
 * from the builder, from `Rule.make`, and from JSON alike. It reads the
 * catalogs of the resources and of the principal, and it gives one issue for
 * each problem, with the path of the problem and, for a name with a mistake,
 * the name that it may mean.
 */
import * as Arr from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import { hasProperty, isObject } from "effect/Predicate"
import type * as Domain from "../Domain.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import { withSuggestion } from "./suggest.ts"

/** One problem of a rule or a policy, with its path. */
export interface Issue {
	readonly path: ReadonlyArray<PropertyKey>
	readonly issue: string
}

/** The data of a rule that the binding reads. */
export interface RuleData {
	readonly actions: ReadonlyArray<string>
	readonly resources: ReadonlyArray<string>
	readonly when?: unknown
	readonly fields?: ReadonlyArray<string>
}

/** The kinds that a rule may run on, from the view of its checks. */
interface Context {
	readonly domain: Domain.Any
	/** The rule is for every resource (`"*"`). */
	readonly all: boolean
	/** The resources that the rule names and that the domain has. */
	readonly named: ReadonlyArray<Resource.Descriptor>
	/** The named resources that have one of the actions of the rule. */
	readonly applicable: ReadonlyArray<Resource.Descriptor>
	/**
	 * The resources whose paths a path test may read: every resource with one
	 * of the actions, for a rule for every resource.
	 */
	readonly paths: ReadonlyArray<Resource.Descriptor>
}

type Operand =
	| { readonly _tag: "Literal"; readonly value: unknown }
	| { readonly _tag: "Principal"; readonly path: string }

const compareOperators = HashSet.make("eq", "ne", "lt", "lte", "gt", "gte")

const isOperand = (operand: unknown): operand is Operand =>
	hasProperty(operand, "_tag") &&
	(operand._tag === "Principal"
		? hasProperty(operand, "path") && typeof operand.path === "string"
		: operand._tag === "Literal" && hasProperty(operand, "value"))

const isOperandList = (values: unknown): values is ReadonlyArray<Operand> =>
	Array.isArray(values) && Arr.every(values, isOperand)

const isScalar = (value: unknown): boolean =>
	value === null ||
	typeof value === "string" ||
	typeof value === "number" ||
	typeof value === "boolean"

/**
 * Tests if a field may hold a value of the type of a fixed value. A test with
 * `null` is a test that the field is missing, so `null` always fits. A number
 * fits any field of numbers: a test of an integer field with `1.5` or
 * `Infinity` has a meaning, as `lt` shows.
 */
const fitsLiteral = (kinds: Catalog.Kinds, value: unknown): boolean =>
	value === null ||
	(typeof value === "number" && kinds.number !== "none") ||
	Catalog.accepts(kinds, value)

/**
 * Tests if two fields may hold one scalar. A principal field that is `null`
 * or that holds an object is a missing value, and a test with a missing value
 * is false, so only scalars count.
 */
const meet = (left: Catalog.Kinds, right: Catalog.Kinds): boolean =>
	(left.string && right.string) ||
	(left.boolean && right.boolean) ||
	(left.number !== "none" && right.number !== "none") ||
	Arr.some(left.literals, (value) => Catalog.accepts(right, value)) ||
	Arr.some(right.literals, (value) => Catalog.accepts(left, value))

const hasStrings = (kinds: Catalog.Kinds): boolean =>
	kinds.string || Arr.some(kinds.literals, (value) => typeof value === "string")

const hasNumbers = (kinds: Catalog.Kinds): boolean =>
	kinds.number !== "none" ||
	Arr.some(kinds.literals, (value) => typeof value === "number")

/** Tests if a field may hold a value with an order: a number or a string. */
const isOrdered = (kinds: Catalog.Kinds): boolean =>
	hasStrings(kinds) || hasNumbers(kinds)

/** Tests if two fields may hold values of one ordered type. */
const orderedMeet = (left: Catalog.Kinds, right: Catalog.Kinds): boolean =>
	(hasStrings(left) && hasStrings(right)) ||
	(hasNumbers(left) && hasNumbers(right))

/** The texts of the fields of a catalog that have only names, for suggestions. */
const namesOf = (catalog: Catalog.Catalog): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(catalog.fields, (field) =>
			Arr.every(field.path, (segment) => typeof segment === "string"),
		),
		(field) => field.text,
	)

/** The issue of a field that is not a field of every resource of the rule. */
const fieldIssue = (
	context: Context,
	field: string,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	const message = `The field "${field}" is not a field of every resource of the rule`
	if (context.all || context.named.length === 0) {
		return [{ path: at, issue: message }]
	}
	const without = Arr.filter(
		context.named,
		(descriptor) => Catalog.lookup(descriptor.catalog, field) === undefined,
	)
	return without.length === 0
		? []
		: [
				{
					path: at,
					issue: withSuggestion(message, field, namesOf(without[0]!.catalog)),
				},
			]
}

/** The fields of the resources that a test of the rule may read. */
const fieldsAt = (
	context: Context,
	field: string,
): ReadonlyArray<Catalog.Field> =>
	Arr.flatMap(context.applicable, (descriptor) => {
		const found = Catalog.lookup(descriptor.catalog, field)
		return found === undefined ? [] : [found]
	})

const badLiteral = (at: ReadonlyArray<PropertyKey>): Issue => ({
	path: at,
	issue:
		"A test has a fixed value that is not a string, a number, a boolean or null",
})

/** The field of the principal that an operand names, or the issue when there is none. */
const principalField = (
	context: Context,
	ref: string,
	at: ReadonlyArray<PropertyKey>,
): Catalog.Field | Issue => {
	const found = Catalog.lookup(context.domain.principalCatalog, ref)
	return found !== undefined
		? found
		: {
				path: at,
				issue: withSuggestion(
					`The principal has no field "${ref}"`,
					ref,
					namesOf(context.domain.principalCatalog),
				),
			}
}

const isIssue = (value: Catalog.Field | Issue): value is Issue =>
	"issue" in value

/** The issues of one operand of a test of a field. */
const operandIssues = (
	context: Context,
	field: string,
	ordered: boolean,
	operand: Operand,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	const fields = fieldsAt(context, field)
	if (operand._tag === "Literal") {
		const value = operand.value
		if (!isScalar(value)) {
			return [badLiteral(at)]
		}
		if (ordered && typeof value !== "string" && typeof value !== "number") {
			return [
				{
					path: at,
					issue: `The field "${field}" has an ordered test with a value that has no order`,
				},
			]
		}
		return [
			...(Arr.some(fields, (found) => !fitsLiteral(found.kinds, value))
				? [
						{
							path: at,
							issue: `The field "${field}" can not hold the value ${JSON.stringify(value)}`,
						},
					]
				: []),
			...(ordered && Arr.some(fields, (found) => !isOrdered(found.kinds))
				? [
						{
							path: at,
							issue: `The field "${field}" has an ordered test with a value that has no order`,
						},
					]
				: []),
		]
	}
	const principal = principalField(context, operand.path, at)
	if (isIssue(principal)) {
		return [principal]
	}
	return [
		...(Arr.some(fields, (found) => !meet(found.kinds, principal.kinds))
			? [
					{
						path: at,
						issue: `The field "${field}" can not hold a value of the principal field "${operand.path}"`,
					},
				]
			: []),
		...(ordered &&
		Arr.some(fields, (found) => !orderedMeet(found.kinds, principal.kinds))
			? [
					{
						path: at,
						issue: `The field "${field}" has an ordered test with a value that has no order`,
					},
				]
			: []),
	]
}

/**
 * Tests if the path of a resource may start with a prefix: it is as long as
 * the prefix, and each fixed string of the prefix is the string of the path
 * at its place, when the path has a string there.
 */
const mayStartWith = (
	descriptor: Resource.Descriptor,
	strings: ReadonlyArray<string | null>,
): boolean =>
	(descriptor.path?.length ?? 0) >= strings.length &&
	Arr.every(strings, (string, index) => {
		const segment = descriptor.path?.[index]
		return string === null || typeof segment !== "string" || segment === string
	})

/** The kinds of the part of the path of a resource at a place. */
const pathPartKinds = (
	descriptor: Resource.Descriptor,
	index: number,
): Catalog.Kinds | string | undefined => {
	const segment = descriptor.path?.[index]
	return segment === undefined || typeof segment === "string"
		? segment
		: (Catalog.lookup(descriptor.catalog, segment.field)?.kinds ??
				Catalog.anyKinds)
}

/** The issues of the prefix of a path test. */
const underIssues = (
	context: Context,
	prefix: ReadonlyArray<Operand>,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	const strings = Arr.map(prefix, (operand) =>
		operand._tag === "Literal" && typeof operand.value === "string"
			? operand.value
			: null,
	)
	// The test can match only a path that starts with the fixed strings of
	// the prefix, so the other resources are left out.
	const candidates = Arr.filter(context.paths, (descriptor) =>
		mayStartWith(descriptor, strings),
	)
	return Arr.flatMap(prefix, (operand, index): ReadonlyArray<Issue> => {
		const place = [...at, "prefix", index]
		if (operand._tag === "Literal") {
			if (!isScalar(operand.value)) {
				return [badLiteral(place)]
			}
			return Arr.some(candidates, (descriptor) => {
				const kinds = pathPartKinds(descriptor, index)
				return typeof kinds === "object" && !fitsLiteral(kinds, operand.value)
			})
				? [
						{
							path: place,
							issue: `The path part ${String(index)} can not hold the value ${JSON.stringify(operand.value)}`,
						},
					]
				: []
		}
		const principal = principalField(context, operand.path, place)
		if (isIssue(principal)) {
			return [principal]
		}
		return Arr.some(candidates, (descriptor) => {
			const kinds = pathPartKinds(descriptor, index)
			return kinds === undefined
				? true
				: typeof kinds === "string"
					? !Catalog.accepts(principal.kinds, kinds)
					: !meet(kinds, principal.kinds)
		})
			? [
					{
						path: place,
						issue: `The principal field "${operand.path}" can not hold a part of the path of the resource`,
					},
				]
			: []
	})
}

const notWhole = (at: ReadonlyArray<PropertyKey>): Issue => ({
	path: at,
	issue: "The condition is not a whole condition tree",
})

/**
 * The issues of a condition. A node that the condition uses in many places is
 * checked one time. The nodes it has seen are in a native `Set`, because it
 * must find a node by the node itself: `Equal` compares nodes by structure.
 */
const conditionIssues = (
	context: Context,
	node: unknown,
	at: ReadonlyArray<PropertyKey>,
	depth: number,
	seen: Set<object>,
): ReadonlyArray<Issue> => {
	if (!isObject(node) || !hasProperty(node, "_tag")) {
		return [notWhole(at)]
	}
	if (depth > Limits.conditionDepth) {
		return [
			{
				path: at,
				issue: `A condition has more than ${String(Limits.conditionDepth)} levels. The most is ${String(Limits.conditionDepth)}.`,
			},
		]
	}
	if (seen.has(node)) {
		return []
	}
	seen.add(node)
	const below = (child: unknown, path: ReadonlyArray<PropertyKey>) =>
		conditionIssues(context, child, path, depth + 1, seen)
	switch (node._tag) {
		case "True":
		case "False":
			return []
		case "Compare": {
			if (
				!hasProperty(node, "op") ||
				typeof node.op !== "string" ||
				!HashSet.has(compareOperators, node.op) ||
				!hasProperty(node, "field") ||
				typeof node.field !== "string" ||
				!hasProperty(node, "value") ||
				!isOperand(node.value)
			) {
				return [notWhole(at)]
			}
			const field = node.field
			const exists = fieldIssue(context, field, [...at, "field"])
			return exists.length > 0
				? exists
				: operandIssues(
						context,
						field,
						node.op !== "eq" && node.op !== "ne",
						node.value,
						[...at, "value"],
					)
		}
		case "In": {
			if (
				!hasProperty(node, "field") ||
				typeof node.field !== "string" ||
				!hasProperty(node, "values") ||
				!isOperandList(node.values)
			) {
				return [notWhole(at)]
			}
			const field = node.field
			const exists = fieldIssue(context, field, [...at, "field"])
			return exists.length > 0
				? exists
				: Arr.flatMap(node.values, (operand, index) =>
						operandIssues(context, field, false, operand, [
							...at,
							"values",
							index,
						]),
					)
		}
		case "Exists":
			return hasProperty(node, "field") && typeof node.field === "string"
				? fieldIssue(context, node.field, [...at, "field"])
				: [notWhole(at)]
		case "Under":
			return hasProperty(node, "prefix") && isOperandList(node.prefix)
				? underIssues(context, node.prefix, at)
				: [notWhole(at)]
		case "And":
		case "Or":
			return hasProperty(node, "conditions") && Array.isArray(node.conditions)
				? Arr.flatMap(
						node.conditions as ReadonlyArray<unknown>,
						(child, index) => below(child, [...at, "conditions", index]),
					)
				: [notWhole(at)]
		case "Not":
			return hasProperty(node, "condition")
				? below(node.condition, [...at, "condition"])
				: [notWhole(at)]
		case "Predicate":
			return hasProperty(node, "name") &&
				typeof node.name === "string" &&
				hasProperty(node, "run") &&
				typeof node.run === "function"
				? []
				: [notWhole(at)]
		default:
			return [notWhole(at)]
	}
}

const hasAction = (
	descriptor: Resource.Descriptor,
	actions: ReadonlyArray<string>,
): boolean =>
	actions.includes("*") ||
	Arr.some(actions, (action) => descriptor.actions.includes(action))

/**
 * Checks one rule against a domain. It gives one issue for each problem. `at`
 * is the path of the rule, for the paths of the issues.
 */
export const ruleIssues = (
	domain: Domain.Any,
	rule: RuleData,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> => {
	const all = rule.resources.includes("*")
	// Each kind is checked one time, also when the list names it again.
	const names = Arr.dedupe(Arr.filter(rule.resources, (kind) => kind !== "*"))
	const kinds = Array.from(HashMap.keys(domain.resources))
	const named = Arr.flatMap(names, (kind) =>
		Option.toArray(HashMap.get(domain.resources, kind)),
	)
	const known = all ? Array.from(HashMap.values(domain.resources)) : named
	// The rule never runs on a kind without one of its actions, so the types
	// of its tests are checked only on the kinds with one.
	const applicable = Arr.filter(named, (descriptor) =>
		hasAction(descriptor, rule.actions),
	)
	const context: Context = {
		domain,
		all,
		named,
		applicable,
		paths: all
			? Arr.filter(known, (descriptor) => hasAction(descriptor, rule.actions))
			: applicable,
	}
	const actions = Arr.dedupe(
		Arr.flatMap(known, (descriptor) => descriptor.actions),
	)
	return [
		...Arr.map(
			Arr.filter(names, (kind) => !HashMap.has(domain.resources, kind)),
			(kind): Issue => ({
				path: [...at, "resources"],
				issue: withSuggestion(
					`There is no resource with the kind "${kind}"`,
					kind,
					kinds,
				),
			}),
		),
		...Arr.map(
			Arr.filter(
				rule.actions,
				(action) => action !== "*" && !actions.includes(action),
			),
			(action): Issue => ({
				path: [...at, "actions"],
				issue: withSuggestion(
					`The action "${action}" is not an action of these resources`,
					action,
					actions,
				),
			}),
		),
		...Arr.flatMap(rule.fields ?? [], (field, index) =>
			// A pattern is checked when its kinds are known, as the builder does.
			field.includes("*")
				? []
				: fieldIssue(context, field, [...at, "fields", index]),
		),
		...(rule.when === undefined
			? []
			: conditionIssues(context, rule.when, [...at, "when"], 1, new Set())),
	]
}

/** The JSON form of a policy tree, or a policy tree, as the binding reads it. */
type TreeNode =
	| { readonly _tag: "Rules"; readonly rules: ReadonlyArray<RuleData> }
	| {
			readonly _tag: "All" | "Any" | "FirstOf"
			readonly policies: ReadonlyArray<TreeNode>
	  }
	| {
			readonly _tag: "Ceiling"
			readonly cap: TreeNode
			readonly policy: TreeNode
	  }

/** Checks each rule of a policy tree against a domain. */
export const treeIssues = (
	domain: Domain.Any,
	root: TreeNode,
): ReadonlyArray<Issue> => {
	const issuesOf = (
		node: TreeNode,
		path: ReadonlyArray<PropertyKey>,
		level: number,
	): ReadonlyArray<Issue> => {
		if (level > Limits.policyDepth) {
			return [
				{
					path,
					issue: `A policy tree has more than ${String(Limits.policyDepth)} levels. The most is ${String(Limits.policyDepth)}.`,
				},
			]
		}
		switch (node._tag) {
			case "Rules":
				return Arr.flatMap(node.rules, (rule, index) =>
					ruleIssues(domain, rule, [...path, "rules", index]),
				)
			case "All":
			case "Any":
			case "FirstOf":
				return Arr.flatMap(node.policies, (child, index) =>
					issuesOf(child, [...path, "policies", index], level + 1),
				)
			case "Ceiling":
				return [
					...issuesOf(node.cap, [...path, "cap"], level + 1),
					...issuesOf(node.policy, [...path, "policy"], level + 1),
				]
		}
	}
	return issuesOf(root, [], 1)
}
