/**
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Pipeable from "effect/Pipeable"
import type * as Ability from "../Ability"

/**
 * @internal
 */
export const TypeId: unique symbol = Symbol.for("@nmnmcc/ability/Ability") as never

interface RuntimeRequest {
  readonly action: string
  readonly subject: string
  readonly value?: object
  readonly field?: string
}

type RuntimePredicate = (subject: object) => boolean | Effect.Effect<boolean, unknown, unknown>

interface RuntimeRule {
  readonly _tag: Ability.RuleKind
  readonly action: string
  readonly subject: string
  readonly fields?: ReadonlyArray<string>
  readonly when?: RuntimePredicate
  readonly reason?: string
}

interface RuleSink {
  readonly add: (rule: RuntimeRule) => void
}

const RuleSink = Context.Service<RuleSink>("@nmnmcc/ability/RuleSink")

/**
 * @since 0.1.0
 * @category Errors
 */
export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly action: string
  readonly subject: string
  readonly field?: string
  readonly reason?: string
}> {}

const AbilityProto = {
  ...Pipeable.Prototype,
  [TypeId]: TypeId,
  toJSON(this: Ability.Ability<Ability.SubjectMap, Ability.AnyRule>) {
    return {
      _id: "Ability",
      rules: this.rules
    }
  }
}

const freezeRule = <Rules extends Ability.AnyRule>(rule: Rules): Rules => {
  const copy: {
    _tag: Rules["_tag"]
    action: Rules["action"]
    subject: Rules["subject"]
    fields?: Rules["fields"]
    when?: Rules["when"]
    reason?: Rules["reason"]
  } = {
    _tag: rule._tag,
    action: rule.action,
    subject: rule.subject
  }

  if (rule.fields !== undefined) {
    copy.fields = Object.freeze(Array.from(rule.fields)) as Rules["fields"]
  }
  if (rule.when !== undefined) {
    copy.when = rule.when
  }
  if (rule.reason !== undefined) {
    copy.reason = rule.reason
  }

  return Object.freeze(copy) as Rules
}

/**
 * @internal
 */
export const make = <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
  rules: Iterable<Rules>
): Ability.Ability<Subjects, Rules> => {
  const self = Object.create(AbilityProto) as {
    rules: ReadonlyArray<Rules>
  }
  self.rules = Object.freeze(Array.from(rules, freezeRule))
  return self as Ability.Ability<Subjects, Rules>
}

const makeRule = <
  Kind extends Ability.RuleKind,
  Action extends string,
  Name extends string,
  Subject extends object,
  Fields extends string,
  E,
  R
>(
  kind: Kind,
  action: Action,
  subject: Name,
  options: Ability.RuleOptions<Subject, Fields, E, R> | undefined
): Ability.Rule<Kind, Action, Name, Subject, Fields, E, R> => {
  const rule: {
    _tag: Kind
    action: Action
    subject: Name
    fields?: ReadonlyArray<Fields>
    when?: Ability.Predicate<Subject, E, R>
    reason?: string
  } = {
    _tag: kind,
    action,
    subject
  }

  if (options?.fields !== undefined) {
    rule.fields = options.fields
  }
  if (options?.when !== undefined) {
    rule.when = options.when
  }
  if (options?.reason !== undefined) {
    rule.reason = options.reason
  }

  return rule
}

const addRule = <Rules extends Ability.AnyRule>(rule: Rules): Effect.Effect<Rules> =>
  Effect.flatMap(Effect.service(RuleSink), (sink) =>
    Effect.sync(() => {
      sink.add(rule as RuntimeRule)
      return rule
    })) as Effect.Effect<Rules>

const builder = <Subjects extends Ability.SubjectMap>(): Ability.Builder<Subjects> => ({
  allow: (action, subject, options) => addRule(makeRule("Allow", action, subject, options)),
  deny: (action, subject, options) => addRule(makeRule("Deny", action, subject, options))
})

type YieldableError<Eff> = Eff extends Effect.Yieldable<any, any, infer E, any> ? E : never
type YieldableServices<Eff> = Eff extends Effect.Yieldable<any, any, any, infer R> ? R : never
type YieldableRule<Eff> = Extract<Effect.Yieldable.Success<Eff>, Ability.AnyRule>

type Define = <Subjects extends Ability.SubjectMap>() => <
  Eff extends Effect.Yieldable<any, any, any, any>,
  A
>(
  body: (builder: Ability.Builder<Subjects>) => Generator<Eff, A, never>
) => Effect.Effect<Ability.Ability<Subjects, YieldableRule<Eff>>, YieldableError<Eff>, YieldableServices<Eff>>

/**
 * @internal
 */
export const define = (<Subjects extends Ability.SubjectMap>() =>
<
  Eff extends Effect.Yieldable<any, any, any, any>,
  A
>(
  body: (builder: Ability.Builder<Subjects>) => Generator<Eff, A, never>
) =>
  Effect.flatMap(
    Effect.sync(() => {
      const rules: Array<RuntimeRule> = []
      const sink: RuleSink = {
        add: (rule) => {
          rules.push(rule)
        }
      }
      return { rules, sink }
    }),
    ({ rules, sink }) =>
      Effect.map(
        Effect.provideService(Effect.gen(() => body(builder<Subjects>())), RuleSink, sink),
        () => make<Subjects, Extract<Effect.Yieldable.Success<Eff>, Ability.AnyRule>>(rules as Array<
          Extract<Effect.Yieldable.Success<Eff>, Ability.AnyRule>
        >)
      )
  )
) as Define

const matchesField = (rule: RuntimeRule, request: RuntimeRequest): boolean => {
  if (rule.fields === undefined) {
    return true
  }
  if (request.field === undefined) {
    return false
  }
  return rule.fields.includes(request.field)
}

const matchesCondition = (
  rule: RuntimeRule,
  request: RuntimeRequest
): Effect.Effect<boolean, unknown, unknown> => {
  if (rule.when === undefined) {
    return Effect.succeed(true)
  }
  if (request.value === undefined) {
    return Effect.succeed(false)
  }

  const result = rule.when(request.value)
  return Effect.isEffect(result) ? result : Effect.succeed(result)
}

const matchesRule = (
  rule: RuntimeRule,
  request: RuntimeRequest
): Effect.Effect<boolean, unknown, unknown> => {
  if (rule.action !== request.action || rule.subject !== request.subject || !matchesField(rule, request)) {
    return Effect.succeed(false)
  }
  return matchesCondition(rule, request)
}

const findRule = (
  rules: ReadonlyArray<RuntimeRule>,
  request: RuntimeRequest,
  index: number
): Effect.Effect<RuntimeRule | undefined, unknown, unknown> => {
  if (index < 0) {
    return Effect.succeed(undefined)
  }

  const rule = rules[index]
  if (rule === undefined) {
    return Effect.succeed(undefined)
  }

  return Effect.flatMap(matchesRule(rule, request), (matches) =>
    matches ? Effect.succeed(rule) : findRule(rules, request, index - 1))
}

const toRuntimeRequest = (request: RuntimeRequest): RuntimeRequest => {
  const runtimeRequest: {
    action: string
    subject: string
    value?: object
    field?: string
  } = {
    action: request.action,
    subject: request.subject
  }

  if (request.value !== undefined) {
    runtimeRequest.value = request.value
  }
  if (request.field !== undefined) {
    runtimeRequest.field = request.field
  }

  return runtimeRequest
}

const makeAuthorizationError = (
  request: RuntimeRequest,
  rule: RuntimeRule | undefined
): AuthorizationError => {
  const error: {
    action: string
    subject: string
    field?: string
    reason?: string
  } = {
    action: request.action,
    subject: request.subject
  }

  if (request.field !== undefined) {
    error.field = request.field
  }
  if (rule?.reason !== undefined) {
    error.reason = rule.reason
  }

  return new AuthorizationError(error)
}

/**
 * @internal
 */
export const allows = dual(2, (
  self: Ability.Ability<Ability.SubjectMap, Ability.AnyRule>,
  request: RuntimeRequest
): Effect.Effect<boolean, unknown, unknown> => {
  const runtimeRequest = toRuntimeRequest(request)
  return Effect.map(
    findRule(self.rules as ReadonlyArray<RuntimeRule>, runtimeRequest, self.rules.length - 1),
    (rule) => rule?._tag === "Allow"
  )
})

/**
 * @internal
 */
export const check = dual(2, (
  self: Ability.Ability<Ability.SubjectMap, Ability.AnyRule>,
  request: RuntimeRequest
): Effect.Effect<void, AuthorizationError | unknown, unknown> => {
  const runtimeRequest = toRuntimeRequest(request)
  return Effect.flatMap(
    findRule(self.rules as ReadonlyArray<RuntimeRule>, runtimeRequest, self.rules.length - 1),
    (rule) => rule?._tag === "Allow"
      ? Effect.void
      : Effect.fail(makeAuthorizationError(runtimeRequest, rule))
  )
})
