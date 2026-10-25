/**
 * Walks that do not fill the stack.
 *
 * A walk is written one time, with the steps of a {@link Runner}, and a
 * runner runs it:
 * - {@link direct} runs each step at once, as a plain call does. It is fast,
 *   and it is for an input with few levels.
 * - {@link loop} puts each step into the run loop of an Effect. A step gives
 *   the next step in place of calling it, and the loop runs one step after
 *   the other, so the stack does not grow with the levels of the input. This
 *   is a trampoline.
 *
 * {@link run} takes `direct` for an input with at most `directDepth` levels,
 * and `loop` for a deeper one. A walk makes each call for a child through
 * `suspend`, so the loop makes the step of the child only when it runs it.
 */
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"

/**
 * A step of a walk that gives an `A`. A runner of steps knows what a step
 * is: the value itself for `direct`, and an Effect for `loop`. The type is
 * only in the types.
 */
export interface Step<A> {
	readonly "~Step": (_: never) => A
}

/** The steps that a walk may take. */
export interface Runner {
	readonly succeed: <A>(value: A) => Step<A>
	/** The step that `step` makes, when the runner runs it. */
	readonly suspend: <A>(step: () => Step<A>) => Step<A>
	readonly map: <A, B>(step: Step<A>, f: (value: A) => B) => Step<B>
	readonly flatMap: <A, B>(step: Step<A>, f: (value: A) => Step<B>) => Step<B>
	/** Runs a step for each item, in order, and gives their values. */
	readonly forEach: <A, B>(
		items: ReadonlyArray<A>,
		f: (item: A, index: number) => Step<B>,
	) => Step<ReadonlyArray<B>>
	/**
	 * Runs a step for each item, in order, with the value of the step before.
	 * It does not grow the stack with the number of items.
	 */
	readonly reduce: <A, B>(
		items: ReadonlyArray<A>,
		initial: B,
		f: (before: B, item: A) => Step<B>,
	) => Step<B>
	/** Runs a step for each item, in order, up to the first `true`. */
	readonly some: <A>(
		items: ReadonlyArray<A>,
		f: (item: A) => Step<boolean>,
	) => Step<boolean>
	/** Runs a step for each item, in order, up to the first `false`. */
	readonly every: <A>(
		items: ReadonlyArray<A>,
		f: (item: A) => Step<boolean>,
	) => Step<boolean>
}

// A step of `direct` is its value. The casts below only change the type.
const value = <A>(step: Step<A>): A => step as unknown as A
const step = <A>(value: A): Step<A> => value as unknown as Step<A>

/** Runs each step at once, on the stack. */
// A step of `direct` is its value, so a function that gives a step gives a
// value too. The runner passes such a function on with no wrap: a wrap for
// each item would be a call more for each node of a walk.
export const direct: Runner = {
	succeed: step,
	suspend: (make) => make(),
	map: (from, f) => step(f(value(from))),
	flatMap: (from, f) => f(value(from)),
	forEach: (items, f) => step(Arr.map(items, f as never)),
	reduce: (items, initial, f) => step(Arr.reduce(items, initial, f as never)),
	some: (items, f) => step(Arr.some(items, f as never)),
	every: (items, f) => step(Arr.every(items, f as never)),
}

// A step of `loop` is an Effect with no error and no services. A failure of a
// walk is a thrown error, which `run` gives back as it was.
type Loop<A> = Effect.Effect<A>
const effect = <A>(step: Step<A>): Loop<A> => step as unknown as Loop<A>
const fromEffect = <A>(effect: Loop<A>): Step<A> => effect as unknown as Step<A>

/** Runs each step in the run loop of an Effect, so a deep walk does not fill the stack. */
export const loop: Runner = {
	succeed: (value) => fromEffect(Effect.succeed(value)),
	suspend: (make) => fromEffect(Effect.suspend(() => effect(make()))),
	map: (from, f) => fromEffect(Effect.map(effect(from), f)),
	flatMap: (from, f) =>
		fromEffect(Effect.flatMap(effect(from), (value) => effect(f(value)))),
	forEach: (items, f) =>
		fromEffect(Effect.forEach(items, (item, index) => effect(f(item, index)))),
	reduce: (items, initial, f) =>
		fromEffect(
			Effect.reduce(
				items,
				() => initial,
				(before, item) => effect(f(before, item)),
			),
		),
	some: (items, f) =>
		fromEffect(
			Effect.map(
				Effect.findFirst(items, (item) => effect(f(item))),
				Option.isSome,
			),
		),
	every: (items, f) =>
		fromEffect(
			Effect.map(
				Effect.findFirst(items, (item) =>
					Effect.map(effect(f(item)), (value) => !value),
				),
				Option.isNone,
			),
		),
}

/**
 * The most levels of an input that `run` walks with `direct`. A level takes
 * a few calls of the walk and of the runner on the stack, so this keeps the
 * stack far from full, and most inputs take the fast way.
 */
export const directDepth = 200

/**
 * Gives the runner for an input with `depth` levels. The walks of a condition
 * or a policy tree know the depth of the input from its node. A walk of an
 * input with an unknown depth, as a decoder, takes `loop`.
 */
export const runnerFor = (depth: number): Runner =>
	depth <= directDepth ? direct : loop

/**
 * Runs a walk at once, with the runner for `depth` levels, and gives its
 * value. An error that a step throws comes out as it was, also from `loop`.
 */
export const run = <A>(depth: number, walk: (runner: Runner) => Step<A>): A =>
	runWith(runnerFor(depth), walk)

/** Runs a walk at once with a runner, as {@link run} does. */
export const runWith = <A>(
	runner: Runner,
	walk: (runner: Runner) => Step<A>,
): A => {
	if (runner === direct) {
		return value(walk(direct))
	}
	return Exit.match(Effect.runSyncExit(effect(walk(loop))), {
		onSuccess: (result) => result,
		onFailure: (cause) => {
			throw Cause.squash(cause)
		},
	})
}

/**
 * Makes a walk of an input with an unknown depth, as the input of a decoder.
 * It runs with `direct` while the input is low. A part more than
 * `directDepth` levels down runs with `loop`, and the walk stays in the loop
 * below it, so it goes into the loop one time on each path. `walk` gets the
 * runner, and the call for a child at the next level: `child(item, depth)`.
 */
export const adaptive = <I, A>(
	walk: (
		R: Runner,
		child: (item: I, depth: number) => Step<A>,
	) => (item: I, depth: number) => Step<A>,
): ((item: I) => A) => {
	const inLoop: (item: I, depth: number) => Step<A> = walk(
		loop,
		(item, depth) => loop.suspend(() => inLoop(item, depth)),
	)
	const onStack: (item: I, depth: number) => Step<A> = walk(
		direct,
		(item, depth) =>
			depth > directDepth
				? step(runWith(loop, () => inLoop(item, depth)))
				: onStack(item, depth),
	)
	return (item) => value(onStack(item, 1))
}

/**
 * Gives the Effect of a step of `loop`, so a walk can go on in an Effect
 * that runs a predicate.
 */
export const toEffect = <A>(step: Step<A>): Effect.Effect<A> => effect(step)
