/**
 * The place of a part of an input, as a path that shares the path of its
 * parent. A deep tree with very many rules would need very much memory for a
 * full copy of the path of each rule, so a place keeps only its own parts and
 * its parent. The full path is made only for a problem, in one walk up.
 */
import * as Arr from "effect/Array"
import * as Option from "effect/Option"

/** A place: its own parts of the path, after the path of its parent. */
export interface Place {
	readonly parent: Place | undefined
	readonly parts: ReadonlyArray<PropertyKey>
}

/** The place below `parent` with more parts. */
export const at = (
	parent: Place | undefined,
	...parts: ReadonlyArray<PropertyKey>
): Place => ({ parent, parts })

/** The full path of a place. The root, with no place, has the empty path. */
export const pathOf = (place: Place | undefined): ReadonlyArray<PropertyKey> =>
	Arr.flatten(
		Arr.reverse(
			Arr.unfold(place, (current) =>
				current === undefined
					? Option.none()
					: Option.some([current.parts, current.parent] as const),
			),
		),
	)
