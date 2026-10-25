/**
 * Suggestions for a name with a mistake, as in "There is no field "titel".
 * Did you mean "title"?".
 */
import * as Arr from "effect/Array"
import * as Option from "effect/Option"
import * as Order from "effect/Order"

/**
 * The fewest changes that make one text into the other. A change adds, takes
 * away or changes one character, or swaps two characters next to each other.
 */
const distance = (left: string, right: string): number => {
	const from = Array.from(left)
	const to = Array.from(right)
	// Each step keeps the row before the last one too, for a swap.
	const [, last] = Arr.reduce(
		from,
		[[], Arr.range(0, to.length)] as readonly [
			ReadonlyArray<number>,
			ReadonlyArray<number>,
		],
		([before, row], char, index) => {
			// The cells of the row go into one list: a new list for each cell
			// would copy the row at each step. The list belongs to this row.
			const next: Array<number> = [index + 1]
			Arr.forEach(to, (other, place) => {
				const change = Math.min(
					next[place]! + 1,
					row[place + 1]! + 1,
					row[place]! + (char === other ? 0 : 1),
				)
				const swap =
					index > 0 &&
					place > 0 &&
					char === to[place - 1] &&
					from[index - 1] === other
						? before[place - 1]! + 1
						: Number.POSITIVE_INFINITY
				next.push(Math.min(change, swap))
			})
			return [row, next] as const
		},
	)
	return last[to.length]!
}

/** The longest name that gets a suggestion. */
const maxNameLength = 64

/**
 * Gives the name in `names` that is nearest to `name`, when it is near
 * enough: at most one change for a short name, and two for a longer one.
 */
/** The most changes for a name to be near: see {@link suggest}. */
const mostChanges = (name: string): number =>
	Math.min(2, Math.max(1, Math.floor(name.length / 2)))

/**
 * The names that need a distance. Two names whose lengths differ by more
 * than the most changes are not near. A very long name gets no suggestion,
 * since the work of one distance grows with the length of both names.
 */
const closeTo = (
	name: string,
	names: ReadonlyArray<string>,
): ReadonlyArray<string> =>
	name.length > maxNameLength
		? []
		: Arr.filter(
				names,
				(other) => Math.abs(other.length - name.length) <= mostChanges(name),
			)

/**
 * The work of {@link suggest}: one step for each name, and one for each cell
 * of each distance.
 */
export const work = (name: string, names: ReadonlyArray<string>): number =>
	Arr.reduce(
		closeTo(name, names),
		names.length,
		(total, other) => total + (name.length + 1) * (other.length + 1),
	)

export const suggest = (
	name: string,
	names: ReadonlyArray<string>,
): string | undefined => {
	const most = mostChanges(name)
	const close = closeTo(name, names)
	const scored = Arr.map(
		close,
		(other) => [other, distance(name, other)] as const,
	)
	const near = Arr.filter(
		scored,
		([other, score]) => other !== name && score <= most,
	)
	return Option.getOrUndefined(
		Option.map(
			Arr.head(
				Arr.sort(
					near,
					Order.mapInput(
						Order.Number,
						([, score]: readonly [string, number]) => score,
					),
				),
			),
			([other]) => other,
		),
	)
}

/** Adds a suggestion to a message, when there is one. */
export const withSuggestion = (
	message: string,
	name: string,
	names: ReadonlyArray<string>,
): string => {
	const near = suggest(name, names)
	return near === undefined ? message : `${message}. Did you mean "${near}"?`
}
