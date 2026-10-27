/** Checks the names and types of a rule against its domain. */
import * as Arr from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import type * as Domain from "../Domain.ts"
import type * as Resource from "../Resource.ts"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"
import * as Nodes from "./nodes.ts"

/** One problem, with its place in the input. */
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

type At = ReadonlyArray<PropertyKey>
type Issues = ReadonlyArray<Issue>

const issue = (path: At, message: string): Issues => [{ path, issue: message }]

/** Checks in order and stops checking after the first issue. */
const first = <A>(
	items: ReadonlyArray<A>,
	check: (item: A, index: number) => Issues,
): Issues =>
	Arr.reduce(items, [] as Issues, (found, item, index) =>
		found.length > 0 ? found : check(item, index),
	)

interface Context {
	readonly domain: Domain.Any
	readonly named: ReadonlyArray<Resource.Descriptor>
	readonly paths: ReadonlyArray<Resource.Descriptor>
	readonly all: boolean
}

const hasAction = (
	descriptor: Resource.Descriptor,
	actions: ReadonlyArray<string>,
): boolean =>
	actions.includes("*") ||
	Arr.some(actions, (action) => descriptor.actions.includes(action))

const fieldIssues = (context: Context, field: string, at: At): Issues => {
	const parts = field.split(".")
	if (
		parts.length > Limits.fieldPathParts ||
		Arr.some(parts, (part) => part.length === 0 || part.includes("*"))
	) {
		return issue(
			at,
			`The field "${field}" must be a real path with at most ${String(Limits.fieldPathParts)} parts`,
		)
	}
	if (
		context.all ||
		context.named.length === 0 ||
		Arr.some(
			context.named,
			(descriptor) => Catalog.lookup(descriptor.catalog, field) === undefined,
		)
	) {
		return issue(
			at,
			`The field "${field}" is not a field of every resource of the rule`,
		)
	}
	return []
}

const readIssues = (
	context: Context,
	field: string,
	at: At,
	scalar: boolean,
): Issues => {
	const found = fieldIssues(context, field, at)
	if (found.length > 0) {
		return found
	}
	return Arr.some(
		context.named,
		(descriptor) =>
			!Catalog.lookup(descriptor.catalog, field)!.plain ||
			(scalar && !Catalog.lookup(descriptor.catalog, field)!.scalar),
	)
		? issue(
				at,
				`A condition may not read the field "${field}". Use a predicate for this field`,
			)
		: []
}

/** Null tests for a missing value. Other values must fit the field type. */
const fitsLiteral = (kinds: Catalog.Kinds, value: unknown): boolean =>
	value === null ||
	(typeof value === "number" && kinds.number !== "none") ||
	Catalog.accepts(kinds, value)

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

const orderedMeet = (left: Catalog.Kinds, right: Catalog.Kinds): boolean =>
	(hasStrings(left) && hasStrings(right)) ||
	(hasNumbers(left) && hasNumbers(right))

const principalField = (
	context: Context,
	path: string,
	at: At,
): Catalog.Field | Issue => {
	const field = Catalog.lookup(context.domain.principalCatalog, path)
	return field === undefined
		? { path: at, issue: `The principal has no field "${path}"` }
		: !field.plain || !field.scalar
			? {
					path: at,
					issue: `A condition may not read the principal field "${path}". Use a predicate for this field`,
				}
			: field
}

const operandIssues = (
	context: Context,
	field: string,
	ordered: boolean,
	operand: Nodes.Operand,
	at: At,
): Issues => {
	if (operand._tag === "Literal") {
		if (
			ordered &&
			typeof operand.value !== "string" &&
			typeof operand.value !== "number"
		) {
			return issue(
				at,
				`The field "${field}" has an ordered test with a value that has no order`,
			)
		}
		return first(context.paths, (descriptor) => {
			const kinds = Catalog.lookup(descriptor.catalog, field)!.kinds
			return !fitsLiteral(kinds, operand.value)
				? issue(at, `The field "${field}" can not hold the given value`)
				: ordered && !hasStrings(kinds) && !hasNumbers(kinds)
					? issue(
							at,
							`The field "${field}" has an ordered test with a value that has no order`,
						)
					: []
		})
	}
	const principal = principalField(context, operand.path, at)
	if ("issue" in principal) {
		return [principal]
	}
	return first(context.paths, (descriptor) => {
		const kinds = Catalog.lookup(descriptor.catalog, field)!.kinds
		return !meet(kinds, principal.kinds)
			? issue(
					at,
					`The field "${field}" can not hold a value of the principal field "${operand.path}"`,
				)
			: ordered && !orderedMeet(kinds, principal.kinds)
				? issue(
						at,
						`The field "${field}" has an ordered test with a value that has no order`,
					)
				: []
	})
}

/** A path test only reads resources whose fixed path parts fit its prefix. */
const underIssues = (
	context: Context,
	prefix: ReadonlyArray<Nodes.Operand>,
	at: At,
): Issues => {
	const candidates = Arr.filter(
		context.paths,
		(descriptor) =>
			(descriptor.path?.length ?? 0) >= prefix.length &&
			Arr.every(prefix, (operand, index) => {
				const part = descriptor.path?.[index]
				return (
					operand._tag !== "Literal" ||
					typeof operand.value !== "string" ||
					typeof part !== "string" ||
					operand.value === part
				)
			}),
	)
	return first(prefix, (operand, index) => {
		const place = [...at, "prefix", index]
		const principal =
			operand._tag === "Principal"
				? principalField(context, operand.path, place)
				: undefined
		if (principal !== undefined && "issue" in principal) {
			return [principal]
		}
		return first(candidates, (descriptor) => {
			const part = descriptor.path?.[index]
			if (typeof part === "string") {
				return principal !== undefined &&
					!Catalog.accepts(principal.kinds, part)
					? issue(
							place,
							"The principal field can not hold this part of the resource path",
						)
					: []
			}
			const kinds =
				part === undefined
					? undefined
					: Catalog.lookup(descriptor.catalog, part.field)?.kinds
			if (kinds === undefined) {
				return issue(place, "The resource path has no data field at this place")
			}
			return operand._tag === "Literal"
				? fitsLiteral(kinds, operand.value)
					? []
					: issue(place, "The resource path can not hold the given value")
				: principal !== undefined && meet(kinds, principal.kinds)
					? []
					: issue(
							place,
							"The principal field can not hold this part of the resource path",
						)
		})
	})
}

/** Node constructors have already checked the shape and fixed bounds. */
const checkCondition = (context: Context, node: Nodes.Node, at: At): Issues => {
	const origin = Nodes.originOf(node)
	if (origin !== undefined && origin.domain !== context.domain) {
		return issue(at, "The condition belongs to another domain")
	}
	if (
		node._tag === "Predicate" &&
		origin !== undefined &&
		origin.kind !== "*" &&
		(context.all ||
			Arr.some(context.named, (descriptor) => descriptor.kind !== origin.kind))
	) {
		return issue(at, "The predicate belongs to another resource kind")
	}
	switch (node._tag) {
		case "Compare": {
			const found = readIssues(context, node.field, [...at, "field"], true)
			return found.length > 0
				? found
				: operandIssues(
						context,
						node.field,
						node.op !== "eq" && node.op !== "ne",
						node.value,
						[...at, "value"],
					)
		}
		case "In": {
			const found = readIssues(context, node.field, [...at, "field"], true)
			return found.length > 0
				? found
				: first(node.values, (value, index) =>
						operandIssues(context, node.field, false, value, [
							...at,
							"values",
							index,
						]),
					)
		}
		case "Exists":
			return readIssues(context, node.field, [...at, "field"], false)
		case "Under":
			return underIssues(context, node.prefix, at)
		case "And":
		case "Or":
			return first(node.conditions, (child, index) =>
				checkCondition(context, child, [...at, "conditions", index]),
			)
		case "Not":
			return checkCondition(context, node.condition, [...at, "condition"])
		default:
			return []
	}
}

/** Binds a condition made for one resource kind. */
export const conditionIssues = (
	domain: Domain.Any,
	kind: string,
	node: Nodes.Node,
	at: At = [],
): Issues => {
	const descriptor = HashMap.get(domain.resources, kind)
	if (Option.isNone(descriptor)) {
		return issue(at, `There is no resource with the kind "${kind}"`)
	}
	return checkCondition(
		{
			domain,
			named: [descriptor.value],
			paths: [descriptor.value],
			all: false,
		},
		node,
		at,
	)
}

/** Checks a rule and gives only its first issue. */
export const ruleIssues = (
	domain: Domain.Any,
	rule: RuleData,
	at: At = [],
): Issues => {
	const missing = first(rule.resources, (kind, index) =>
		kind !== "*" && !HashMap.has(domain.resources, kind)
			? issue(
					[...at, "resources", index],
					`There is no resource with the kind "${kind}"`,
				)
			: [],
	)
	if (missing.length > 0) {
		return missing
	}
	const all = rule.resources.includes("*")
	const named = all
		? Array.from(HashMap.values(domain.resources))
		: Arr.flatMap(rule.resources, (kind) =>
				Option.toArray(HashMap.get(domain.resources, kind)),
			)
	const actions = first(rule.actions, (action, index) =>
		action === "*" ||
		Arr.some(named, (descriptor) => descriptor.actions.includes(action))
			? []
			: issue(
					[...at, "actions", index],
					`The action "${action}" is not an action of these resources`,
				),
	)
	if (actions.length > 0) {
		return actions
	}
	const context: Context = {
		domain,
		named,
		all,
		paths: Arr.filter(named, (descriptor) =>
			hasAction(descriptor, rule.actions),
		),
	}
	const fields = first(rule.fields ?? [], (field, index) =>
		field === "*" ? [] : fieldIssues(context, field, [...at, "fields", index]),
	)
	if (fields.length > 0 || rule.when === undefined) {
		return fields
	}
	return !Nodes.isNode(rule.when)
		? issue([...at, "when"], "The condition is not a whole condition tree")
		: checkCondition(context, rule.when, [...at, "when"])
}

/** A policy tree whose nodes have passed the fixed bounds. */
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

/** Checks the rules in tree order and gives only the first issue. */
export const treeIssues = (domain: Domain.Any, root: TreeNode): Issues => {
	const go = (node: TreeNode, at: At): Issues => {
		switch (node._tag) {
			case "Rules":
				return first(node.rules, (rule, index) =>
					ruleIssues(domain, rule, [...at, "rules", index]),
				)
			case "All":
			case "Any":
			case "FirstOf":
				return first(node.policies, (child, index) =>
					go(child, [...at, "policies", index]),
				)
			case "Ceiling": {
				const cap = go(node.cap, [...at, "cap"])
				return cap.length > 0 ? cap : go(node.policy, [...at, "policy"])
			}
		}
	}
	return go(root, [])
}
