/**
 * Field patterns, as in `settings.*`, `secret*` or `**.secret`. A pattern is
 * a list of parts with dots between them:
 * - A name with no star matches that name.
 * - A part with stars matches a name, and each star matches any text with no
 *   dot, as `secret*` matches `secretKey`.
 * - `**` matches any number of names, also none. It must be a whole part.
 *
 * A pattern that matches a field matches each field below it too. So `pay`
 * matches `pay.amount`, as `pay.**` does.
 *
 * The match goes one name at a time, and it keeps the set of places in the
 * pattern that it may be at. It does not go back, so the time is at most the
 * number of names times the number of parts.
 */
import * as Arr from "effect/Array"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Catalog from "./catalog.ts"
import * as Limits from "./limits.ts"

/** One part of a pattern. */
export type Part =
	| { readonly _tag: "Name"; readonly name: string }
	/** The texts between the stars of the part. */
	| { readonly _tag: "Glob"; readonly pieces: ReadonlyArray<string> }
	| { readonly _tag: "Globstar" }

/** A pattern, as a list of parts. Two `**` parts are never next to each other. */
export type Pattern = ReadonlyArray<Part>

const globstar: Part = { _tag: "Globstar" }

const partOf = (text: string): Part =>
	text === "**"
		? globstar
		: text.includes("*")
			? { _tag: "Glob", pieces: text.split("*") }
			: { _tag: "Name", name: text }

/**
 * Reads a pattern. It fails with the problem when the pattern has `**`
 * inside a part, or has more parts than `parts`, the `patternParts` of a
 * domain.
 */
export const parse = (
	text: string,
	parts: number = Limits.patternParts,
): Result.Result<Pattern, string> => {
	const texts = text.split(".", parts + 1)
	if (texts.length > parts) {
		return Result.fail(
			`The field pattern "${text}" has more than ${String(parts)} parts. The most is ${String(parts)}.`,
		)
	}
	if (Arr.some(texts, (part) => part !== "**" && part.includes("**"))) {
		return Result.fail(
			`The field pattern "${text}" has "**" inside a part. "**" must be a whole part`,
		)
	}
	// `a.**.**` matches what `a.**` matches.
	return Result.succeed(
		Arr.dedupeAdjacentWith(
			Arr.map(texts, partOf),
			(left, right) => left._tag === "Globstar" && right._tag === "Globstar",
		),
	)
}

/**
 * Reads a pattern of a bound rule. The binding of the rule took the pattern
 * with the limits of its domain, so this reads it up to the ceiling, and a
 * problem here is a defect.
 */
export const parseBound = (text: string): Pattern =>
	Result.getOrThrowWith(
		parse(text, Limits.ceilings.patternParts),
		(problem) => new Error(problem),
	)

/** Tests if a name matches the pieces of a part with stars. */
const globMatches = (pieces: ReadonlyArray<string>, name: string): boolean => {
	const first = pieces[0]!
	const last = pieces[pieces.length - 1]!
	const middle = pieces.slice(1, -1)
	if (
		name.length < first.length + last.length ||
		!name.startsWith(first) ||
		!name.endsWith(last)
	) {
		return false
	}
	// Each piece in the middle is found as early as it can be. An earlier
	// place never leaves less room for the pieces after it.
	const end = name.length - last.length
	const place = Arr.reduce(middle, first.length as number, (at, piece) => {
		if (at < 0) {
			return at
		}
		const found = name.indexOf(piece, at)
		return found < 0 || found + piece.length > end ? -1 : found + piece.length
	})
	return place >= 0
}

/**
 * Tests if a part matches one segment of a path. A part with stars matches
 * any key of a record. A name matches a key of a record when the Schema of
 * the keys takes it.
 */
const partFits = (part: Part, segment: Catalog.Segment): boolean => {
	switch (part._tag) {
		case "Globstar":
			return true
		case "Glob":
			return typeof segment !== "string" || globMatches(part.pieces, segment)
		case "Name":
			return typeof segment === "string"
				? part.name === segment
				: Catalog.keyFits(segment, part.name)
	}
}

/** The places of a match: the parts that it may take next. */
type States = ReadonlyArray<number>

/** Adds the place after each `**`, since a `**` may match no names. */
const close = (pattern: Pattern, states: States): States =>
	// A native `Set` keeps the first copy of each place, in order. It is
	// faster than `Arr.dedupe`, and this is on the path of each match.
	Array.from(
		new Set(
			Arr.flatMap(states, (state) =>
				pattern[state]?._tag === "Globstar" ? [state, state + 1] : [state],
			),
		),
	)

const start = (pattern: Pattern): States => close(pattern, [0])

/** Gives the places after one more segment. A `**` that takes it stays. */
const step = (
	pattern: Pattern,
	states: States,
	segment: Catalog.Segment,
): States =>
	close(
		pattern,
		Arr.flatMap(states, (state) => {
			const part = pattern[state]
			return part === undefined
				? []
				: part._tag === "Globstar"
					? [state]
					: partFits(part, segment)
						? [state + 1]
						: []
		}),
	)

const isDone = (pattern: Pattern, states: States): boolean =>
	states.includes(pattern.length)

/**
 * Tests if a pattern matches a field, or a field above it. The field is a
 * list of names.
 */
export const matches = (
	pattern: Pattern,
	names: ReadonlyArray<string>,
): boolean => {
	const found = Arr.reduce(
		names,
		{ states: start(pattern), done: isDone(pattern, start(pattern)) },
		(before, name) => {
			if (before.done || before.states.length === 0) {
				return before
			}
			const states = step(pattern, before.states, name)
			return { states, done: isDone(pattern, states) }
		},
	)
	return found.done
}

/**
 * Tests if a pattern may match a field below a field, with more names after
 * the names of the field.
 */
export const matchesBelow = (
	pattern: Pattern,
	names: ReadonlyArray<string>,
): boolean =>
	Arr.some(
		Arr.reduce(names, start(pattern), (states, name) =>
			step(pattern, states, name),
		),
		(state) => state < pattern.length,
	)

/**
 * Tests if a pattern matches some field of a catalog, with at most `parts`
 * parts. A recursive Schema has no end of fields, so the search goes over the
 * pairs of a place of the catalog and one place of the match. There are at
 * most the places of the catalog times the parts of the pattern of them, so
 * the work is the steps of the catalog times the parts of the pattern, as the
 * binding counts it. Each pair comes one time, a level after a level, so the
 * search finds the shortest field first, and it keeps a queue, so a deep
 * Schema does not fill the stack. The set of the pairs is native, and the set
 * and the queue belong to this call.
 */
export const fitsCatalog = (
	pattern: Pattern,
	catalog: Catalog.Catalog,
	parts: number = Limits.fieldPathParts,
): boolean => {
	interface Visit {
		readonly branch: Catalog.Branch
		readonly state: number
		readonly depth: number
	}
	const seen = new Set<string>()
	const visits = (
		id: number,
		states: States,
		depth: number,
	): ReadonlyArray<Visit> =>
		Arr.flatMap(states, (state) => {
			const key = `${String(id)}|${String(state)}`
			if (seen.has(key)) {
				return []
			}
			seen.add(key)
			return [{ branch: catalog.branches[id]!, state, depth }]
		})
	const next = (visit: Visit): ReadonlyArray<Visit> => {
		if (visit.depth === parts) {
			return []
		}
		const branch = visit.branch
		const steps: ReadonlyArray<readonly [Catalog.Segment, number]> =
			branch.key === undefined || branch.keyBranch === undefined
				? branch.children
				: [...branch.children, [branch.key, branch.keyBranch] as const]
		return Arr.flatMap(steps, ([segment, id]) =>
			visits(id, step(pattern, [visit.state], segment), visit.depth + 1),
		)
	}
	const queue: Array<Visit> = [...visits(catalog.root.id, start(pattern), 0)]
	// The walk stops at the first field that the pattern matches. The visits
	// go into the queue one at a time: a spread into a call would pass one
	// argument for each, past the most arguments of a call.
	return Arr.some(
		Arr.unfold(0, (index) => {
			const visit = queue[index]
			if (visit === undefined) {
				return Option.none()
			}
			if (visit.depth > 0 && visit.state === pattern.length) {
				return Option.some([true, queue.length] as const)
			}
			Arr.forEach(next(visit), (found) => {
				queue.push(found)
			})
			return Option.some([false, index + 1] as const)
		}),
		(match) => match,
	)
}
