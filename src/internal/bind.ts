/**
 * The binding of rules to a domain. It is the one check of a rule, for a rule
 * from the builder, from `Policy.rule`, and from JSON alike. It reads the
 * catalogs of the resources and of the principal, and it gives one issue for
 * each problem, with the path of the problem and, for a name with a mistake,
 * the name that it may mean.
 */
import * as Arr from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type * as Domain from "../Domain.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"
import * as Patterns from "./patterns.ts"
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

/**
 * The memo of one binding, for all its rules. A policy may name one wrong
 * field or one pattern in very many places, so the work on each is done one
 * time. It goes away when the binding ends.
 */
interface Memo {
	/** The suggestion for each name, by the place where it was looked for. */
	readonly suggestions: MutableHashMap.MutableHashMap<string, string>
	/** If a pattern matches a field of a kind, by the kind and the pattern. */
	readonly fits: MutableHashMap.MutableHashMap<string, boolean>
}

const makeMemo = (): Memo => ({
	suggestions: MutableHashMap.empty(),
	fits: MutableHashMap.empty(),
})

/**
 * The most names that one binding makes a suggestion for. A suggestion
 * compares the name with every name of a catalog, so a policy with very many
 * wrong names would take a long time.
 */
const maxSuggestions = 32

/** Adds a suggestion to a message, with the memo of the binding. */
const suggestIn = (
	memo: Memo,
	message: string,
	name: string,
	scope: string,
	names: () => ReadonlyArray<string>,
): string => {
	const key = `${scope}\u0000${name}`
	const known = MutableHashMap.get(memo.suggestions, key)
	if (Option.isSome(known)) {
		return known.value
	}
	if (MutableHashMap.size(memo.suggestions) >= maxSuggestions) {
		return message
	}
	const made = withSuggestion(message, name, names())
	MutableHashMap.set(memo.suggestions, key, made)
	return made
}

/** The kinds that a rule may run on, from the view of its checks. */
interface Context {
	readonly domain: Domain.Any
	readonly memo: Memo
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

type Operand = Nodes.Operand

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
					issue: suggestIn(context.memo, message, field, without[0]!.kind, () =>
						namesOf(without[0]!.catalog),
					),
				},
			]
}

/**
 * The issues of a field pattern: a pattern that does not parse, or that
 * matches no field of the resources of the rule, as a pattern with a mistake
 * in a name does.
 */
const patternIssues = (
	memo: Memo,
	known: ReadonlyArray<Resource.Descriptor>,
	pattern: string,
	at: ReadonlyArray<PropertyKey>,
): ReadonlyArray<Issue> =>
	Result.match(Patterns.parse(pattern), {
		onFailure: (issue) => [{ path: at, issue }],
		onSuccess: (parsed) =>
			// A rule with no known resource has an issue for that already.
			known.length === 0 ||
			Arr.some(known, (descriptor) => {
				const key = `${descriptor.kind}\u0000${pattern}`
				return Option.getOrElse(MutableHashMap.get(memo.fits, key), () => {
					const fits = Patterns.fitsCatalog(parsed, descriptor.catalog)
					MutableHashMap.set(memo.fits, key, fits)
					return fits
				})
			})
				? []
				: [
						{
							path: at,
							issue: `The field pattern "${pattern}" matches no field of the resources of the rule`,
						},
					],
	})

/** The fields of the resources that a test of the rule may read. */
const fieldsAt = (
	context: Context,
	field: string,
): ReadonlyArray<Catalog.Field> =>
	Arr.flatMap(context.applicable, (descriptor) => {
		const found = Catalog.lookup(descriptor.catalog, field)
		return found === undefined ? [] : [found]
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
				issue: suggestIn(
					context.memo,
					`The principal has no field "${ref}"`,
					ref,
					"~principal",
					() => namesOf(context.domain.principalCatalog),
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
 * The issues of a condition. The constructors of the nodes checked the shape
 * of each node, so this checks the names and the types against the domain. A
 * node that the condition uses in many places is checked one time. The nodes
 * it has seen are in a native `Set`, because it must find a node by the node
 * itself: `Equal` compares nodes by structure.
 */
const conditionIssues = (
	context: Context,
	node: Nodes.Node,
	at: ReadonlyArray<PropertyKey>,
	seen: Set<Nodes.Node>,
): ReadonlyArray<Issue> => {
	if (seen.has(node)) {
		return []
	}
	seen.add(node)
	switch (node._tag) {
		case "Compare": {
			const exists = fieldIssue(context, node.field, [...at, "field"])
			return exists.length > 0
				? exists
				: operandIssues(
						context,
						node.field,
						node.op !== "eq" && node.op !== "ne",
						node.value,
						[...at, "value"],
					)
		}
		case "In": {
			const exists = fieldIssue(context, node.field, [...at, "field"])
			return exists.length > 0
				? exists
				: Arr.flatMap(node.values, (operand, index) =>
						operandIssues(context, node.field, false, operand, [
							...at,
							"values",
							index,
						]),
					)
		}
		case "Exists":
			return fieldIssue(context, node.field, [...at, "field"])
		case "Under":
			return underIssues(context, node.prefix, at)
		case "And":
		case "Or":
			return Arr.flatMap(node.conditions, (child, index) =>
				conditionIssues(context, child, [...at, "conditions", index], seen),
			)
		case "Not":
			return conditionIssues(
				context,
				node.condition,
				[...at, "condition"],
				seen,
			)
		default:
			return []
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
	memo: Memo = makeMemo(),
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
		memo,
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
				issue: suggestIn(
					memo,
					`There is no resource with the kind "${kind}"`,
					kind,
					"~kinds",
					() => kinds,
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
				issue: suggestIn(
					memo,
					`The action "${action}" is not an action of these resources`,
					action,
					`~actions\u0000${names.join(",")}`,
					() => actions,
				),
			}),
		),
		...Arr.flatMap(rule.fields ?? [], (field, index) =>
			field.includes("*")
				? patternIssues(memo, known, field, [...at, "fields", index])
				: fieldIssue(context, field, [...at, "fields", index]),
		),
		...(rule.when === undefined
			? []
			: Nodes.isNode(rule.when)
				? conditionIssues(context, rule.when, [...at, "when"], new Set())
				: [notWhole([...at, "when"])]),
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
