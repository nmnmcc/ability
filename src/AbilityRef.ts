/**
 * Mutable ability references for applications that need to swap immutable
 * abilities at runtime.
 *
 * @since 0.1.0
 * @module
 */
import * as Effect from "effect/Effect"
import * as Pipeable from "effect/Pipeable"
import * as Ability from "./Ability"

/**
 * @since 0.1.0
 * @category Type Ids
 */
export const TypeId: unique symbol = Symbol.for("@nmnmcc/ability/AbilityRef") as never

/**
 * @since 0.1.0
 * @category Type Ids
 */
export type TypeId = typeof TypeId

/**
 * @since 0.1.0
 * @category Models
 */
export type EventName = "update" | "updated"

/**
 * @since 0.1.0
 * @category Models
 */
export interface UpdateEvent<Subjects extends Ability.SubjectMap> {
  readonly previous: Ability.Ability<Subjects, Ability.AnyRule>
  readonly next: Ability.Ability<Subjects, Ability.AnyRule>
}

/**
 * @since 0.1.0
 * @category Models
 */
export interface UpdatedEvent<Subjects extends Ability.SubjectMap> {
  readonly previous: Ability.Ability<Subjects, Ability.AnyRule>
  readonly current: Ability.Ability<Subjects, Ability.AnyRule>
}

/**
 * @since 0.1.0
 * @category Models
 */
export type Event<Subjects extends Ability.SubjectMap, Name extends EventName> = Name extends "update" ? UpdateEvent<Subjects>
  : UpdatedEvent<Subjects>

/**
 * @since 0.1.0
 * @category Models
 */
export type EventHandler<Subjects extends Ability.SubjectMap, Name extends EventName> = (
  event: Event<Subjects, Name>
) => void | Effect.Effect<void>

/**
 * @since 0.1.0
 * @category Models
 */
export type Unsubscribe = () => void

/**
 * @since 0.1.0
 * @category Models
 */
export interface AbilityRef<Subjects extends Ability.SubjectMap> extends Pipeable.Pipeable {
  readonly [TypeId]: TypeId
  readonly current: Ability.Ability<Subjects, Ability.AnyRule>
  readonly handlers: {
    readonly update: Array<EventHandler<Subjects, "update">>
    readonly updated: Array<EventHandler<Subjects, "updated">>
  }
}

const AbilityRefProto = {
  ...Pipeable.Prototype,
  [TypeId]: TypeId,
  toJSON(this: AbilityRef<Ability.SubjectMap>) {
    return {
      _id: "AbilityRef",
      current: this.current
    }
  }
}

/**
 * @since 0.1.0
 * @category Constructors
 */
export const make = <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
  ability: Ability.Ability<Subjects, Rules>
): AbilityRef<Subjects> => {
  const ref = Object.create(AbilityRefProto) as {
    current: Ability.Ability<Subjects, Ability.AnyRule>
    handlers: {
      update: Array<EventHandler<Subjects, "update">>
      updated: Array<EventHandler<Subjects, "updated">>
    }
  }
  ref.current = ability as Ability.Ability<Subjects, Ability.AnyRule>
  ref.handlers = {
    update: [],
    updated: []
  }
  return ref as AbilityRef<Subjects>
}

/**
 * @since 0.1.0
 * @category Accessors
 */
export const get = <Subjects extends Ability.SubjectMap>(self: AbilityRef<Subjects>): Ability.Ability<Subjects, Ability.AnyRule> => self.current

const toEffect = (
  evaluate: () => void | Effect.Effect<void>
): Effect.Effect<void> =>
  Effect.flatMap(
    Effect.sync(evaluate),
    (result) => Effect.isEffect(result) ? result : Effect.void
  )

const emit = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Name extends EventName>(
  self: AbilityRef<Subjects>,
  name: Name,
  event: Event<Subjects, Name>
): Effect.fn.Return<void> {
  const handlers = Array.from(self.handlers[name] as unknown as Array<EventHandler<Subjects, Name>>)
  for (const handler of handlers) {
    yield* toEffect(() => handler(event))
  }
})

/**
 * @since 0.1.0
 * @category Combinators
 */
export const set = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
  self: AbilityRef<Subjects>,
  ability: Ability.Ability<Subjects, Rules>
): Effect.fn.Return<void> {
  const previous = self.current
  const next = ability as Ability.Ability<Subjects, Ability.AnyRule>
  yield* emit(self, "update", { previous, next })
  ;(self as { current: Ability.Ability<Subjects, Ability.AnyRule> }).current = next
  yield* emit(self, "updated", { previous, current: next })
})

/**
 * @since 0.1.0
 * @category Combinators
 */
export const update = Effect.fnUntraced(function*<
  Subjects extends Ability.SubjectMap,
  Rules extends Ability.AnyRule
>(
  self: AbilityRef<Subjects>,
  next: Ability.Ability<Subjects, Rules> | Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>
): Effect.fn.Return<void, Ability.RawRuleError> {
  if (Symbol.iterator in Object(next) && !(Ability.TypeId in Object(next))) {
    const ability = yield* Ability.fromRawRules<Subjects>(
      next as Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>,
      self.current.options
    )
    return yield* set(self, ability)
  }

  return yield* set(self, next as Ability.Ability<Subjects, Rules>)
})

/**
 * @since 0.1.0
 * @category Combinators
 */
export const on = <Subjects extends Ability.SubjectMap, Name extends EventName>(
  self: AbilityRef<Subjects>,
  name: Name,
  handler: EventHandler<Subjects, Name>
): Effect.Effect<Unsubscribe> =>
  Effect.sync(() => {
    const handlers = self.handlers[name] as unknown as Array<EventHandler<Subjects, Name>>
    handlers.push(handler)
    let active = true
    return () => {
      if (!active) {
        return
      }
      active = false
      const index = handlers.indexOf(handler)
      if (index >= 0) {
        handlers.splice(index, 1)
      }
    }
  })
