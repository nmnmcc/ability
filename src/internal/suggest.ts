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
			const next = Arr.reduce(
				to,
				[index + 1] as ReadonlyArray<number>,
				(cells, other, place) => {
					const change = Math.min(
						cells[place]! + 1,
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
					return [...cells, Math.min(change, swap)]
				},
			)
			return [row, next] as const
		},
	)
	return last[to.length]!
}

/**
 * Gives the name in `names` that is nearest to `name`, when it is near
 * enough: at most one change for a short name, and two for a longer one.
 */
export const suggest = (
	name: string,
	names: ReadonlyArray<string>,
): string | undefined => {
	const most = Math.min(2, Math.max(1, Math.floor(name.length / 2)))
	const scored = Arr.map(
		names,
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
