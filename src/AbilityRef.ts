/**
 * Mutable ability references for applications that need to swap immutable
 * abilities at runtime.
 *
 * Mental model:
 * - `AbilityRef` is the explicit mutable boundary for this package.
 * - The current ability can be replaced while subscribers observe update events.
 * - All policy evaluation still happens against immutable `Ability` values.
 *
 * Common tasks:
 * - Create a reference with {@link make}.
 * - Read the current ability with {@link get}.
 * - Replace the current ability with {@link set} or {@link update}.
 * - Subscribe to update events with {@link on}.
 *
 * Gotchas:
 * - Event handlers run in registration order.
 * - `update` accepts raw rules and reuses the current ability options.
 * - `AbilityRef` equality is referential because the current value is mutable.
 *
 * @since 0.1.0
 * @module
 */
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Formatter from "effect/Formatter"
import { dual } from "effect/Function"
import * as Hash from "effect/Hash"
import * as Inspectable from "effect/Inspectable"
import * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
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
export interface AbilityRef<Subjects extends Ability.SubjectMap> extends Equal.Equal, Inspectable.Inspectable, Pipeable.Pipeable {
  readonly [TypeId]: TypeId
  readonly current: Ability.Ability<Subjects, Ability.AnyRule>
  /** @internal */
  readonly handlers: {
    readonly update: Array<EventHandler<Subjects, "update">>
    readonly updated: Array<EventHandler<Subjects, "updated">>
  }
}

const RefIdentityTypeId: unique symbol = Symbol.for("@nmnmcc/ability/AbilityRef/identity") as never
let refIdentity = 0

type RuntimeAbilityRef = AbilityRef<Ability.SubjectMap> & {
  readonly [RefIdentityTypeId]: number
}

const inspectableToString = function(this: { toJSON(): unknown }): string {
  return Formatter.format(this.toJSON(), { ignoreToString: true, space: 2 })
}

const inspectableNode = function(this: { toJSON(): unknown }): unknown {
  return this.toJSON()
}

const AbilityRefProto = {
  ...Pipeable.Prototype,
  [TypeId]: TypeId,
  [Equal.symbol](this: RuntimeAbilityRef, that: Equal.Equal): boolean {
    return isAbilityRef(that) && this[RefIdentityTypeId] === (that as RuntimeAbilityRef)[RefIdentityTypeId]
  },
  [Hash.symbol](this: RuntimeAbilityRef): number {
    return Hash.number(this[RefIdentityTypeId])
  },
  toString: inspectableToString,
  toJSON(this: AbilityRef<Ability.SubjectMap>) {
    return {
      _id: "AbilityRef",
      current: this.current
    }
  },
  [Inspectable.NodeInspectSymbol]: inspectableNode
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
    [RefIdentityTypeId]: number
    handlers: {
      update: Array<EventHandler<Subjects, "update">>
      updated: Array<EventHandler<Subjects, "updated">>
    }
  }
  ref.current = ability as Ability.Ability<Subjects, Ability.AnyRule>
  ref[RefIdentityTypeId] = refIdentity
  refIdentity = refIdentity + 1
  ref.handlers = {
    update: [],
    updated: []
  }
  return ref as unknown as AbilityRef<Subjects>
}

/**
 * @since 0.1.0
 * @category Guards
 */
export const isAbilityRef = (value: unknown): value is AbilityRef<Ability.SubjectMap> =>
  Predicate.hasProperty(value, TypeId)

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
const setEffect = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
  self: AbilityRef<Subjects>,
  ability: Ability.Ability<Subjects, Rules>
): Effect.fn.Return<void> {
  const previous = self.current
  const next = ability as Ability.Ability<Subjects, Ability.AnyRule>
  const mutable = self as {
    current: Ability.Ability<Subjects, Ability.AnyRule>
  }
  yield* emit(self, "update", { previous, next })
  mutable.current = next
  yield* emit(self, "updated", { previous, current: next })
})

/**
 * @since 0.1.0
 * @category Combinators
 */
export const set: {
  <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
    ability: Ability.Ability<Subjects, Rules>
  ): (self: AbilityRef<Subjects>) => Effect.Effect<void>
  <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
    self: AbilityRef<Subjects>,
    ability: Ability.Ability<Subjects, Rules>
  ): Effect.Effect<void>
} = dual(2, setEffect)

/**
 * @since 0.1.0
 * @category Combinators
 */
const updateEffect = Effect.fnUntraced(function*<
  Subjects extends Ability.SubjectMap,
  Rules extends Ability.AnyRule
>(
  self: AbilityRef<Subjects>,
  next: Ability.Ability<Subjects, Rules> | Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>
): Effect.fn.Return<void, Ability.AliasError | Ability.RawRuleError> {
  if (Symbol.iterator in Object(next) && !Ability.isAbility(next)) {
    const ability = yield* Ability.fromRawRules<Subjects>(
      next as Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>,
      self.current.options
    )
    return yield* setEffect(self, ability)
  }

  return yield* setEffect(self, next as Ability.Ability<Subjects, Rules>)
})

/**
 * @since 0.1.0
 * @category Combinators
 */
export const update: {
  <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
    next: Ability.Ability<Subjects, Rules> | Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>
  ): (self: AbilityRef<Subjects>) => Effect.Effect<void, Ability.AliasError | Ability.RawRuleError>
  <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
    self: AbilityRef<Subjects>,
    next: Ability.Ability<Subjects, Rules> | Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>
  ): Effect.Effect<void, Ability.AliasError | Ability.RawRuleError>
} = dual(2, updateEffect)

/**
 * @since 0.1.0
 * @category Combinators
 */
const onEffect = <Subjects extends Ability.SubjectMap, Name extends EventName>(
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

/**
 * @since 0.1.0
 * @category Combinators
 */
export const on: {
  <Subjects extends Ability.SubjectMap, Name extends EventName>(
    name: Name,
    handler: EventHandler<Subjects, Name>
  ): (self: AbilityRef<Subjects>) => Effect.Effect<Unsubscribe>
  <Subjects extends Ability.SubjectMap, Name extends EventName>(
    self: AbilityRef<Subjects>,
    name: Name,
    handler: EventHandler<Subjects, Name>
  ): Effect.Effect<Unsubscribe>
} = dual(3, onEffect)
