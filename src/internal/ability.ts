/**
 * @since 0.1.0
 */
import { guard } from "@ucast/mongo2js"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import * as Pipeable from "effect/Pipeable"
import type * as Ability from "../Ability"

/**
 * @internal
 */
export const TypeId: unique symbol = Symbol.for("@nmnmcc/ability/Ability") as never

/**
 * @internal
 */
export const SubjectTypeId: unique symbol = Symbol.for("@nmnmcc/ability/Subject") as never

const anyAction = "manage"
const anySubject = "all"

interface RuntimeRequest {
  readonly action: string
  readonly subject: string
  readonly value?: object
  readonly field?: string
}

type RuntimePredicate = (subject: object) => boolean | Effect.Effect<boolean, unknown, unknown>

interface RuntimeRule {
  readonly _tag: Ability.RuleKind
  readonly action: Ability.SingleOrReadonlyArray<string>
  readonly subject: Ability.SingleOrReadonlyArray<string>
  readonly fields?: ReadonlyArray<string>
  readonly conditions?: Ability.MongoCondition<any>
  readonly when?: RuntimePredicate
  readonly reason?: string
}

interface RuntimeAbility extends Ability.Ability<Ability.SubjectMap, Ability.AnyRule> {
  readonly options: Ability.AbilityOptions<Ability.SubjectMap>
}

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

/**
 * @since 0.1.0
 * @category Errors
 */
export class ConditionError extends Data.TaggedError("ConditionError")<{
  readonly action: string
  readonly subject: string
  readonly field?: string
  readonly cause: unknown
}> {}

/**
 * @since 0.1.0
 * @category Errors
 */
export class SerializationError extends Data.TaggedError("SerializationError")<{
  readonly reason: string
  readonly ruleIndex?: number
}> {}

/**
 * @since 0.1.0
 * @category Errors
 */
export class RawRuleError extends Data.TaggedError("RawRuleError")<{
  readonly reason: string
  readonly ruleIndex?: number
  readonly cause?: unknown
}> {}

/**
 * @since 0.1.0
 * @category Errors
 */
export class SubjectDetectionError extends Data.TaggedError("SubjectDetectionError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

const copyArray = <A>(value: ReadonlyArray<A>): ReadonlyArray<A> => Object.freeze(Array.from(value))

const wrapArray = <A>(value: Ability.SingleOrReadonlyArray<A>): ReadonlyArray<A> =>
  Array.isArray(value) ? value as ReadonlyArray<A> : [value as A]

const normalizeArray = <A>(value: Ability.SingleOrReadonlyArray<A>): Ability.SingleOrReadonlyArray<A> =>
  Array.isArray(value) ? copyArray(value as ReadonlyArray<A>) : value

function* ruleIterator<Rule extends Ability.AnyRule>(rule: Rule): Generator<Rule, Rule, Rule> {
  return yield rule
}

const cloneSerializable = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneSerializable))
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      output[key] = cloneSerializable((value as Record<string, unknown>)[key])
    }
    return Object.freeze(output)
  }
  return value
}

const RuleProto = {
  ...Pipeable.Prototype,
  [Symbol.iterator]<Rule extends Ability.AnyRule>(this: Rule): Generator<Rule, Rule, Rule> {
    return ruleIterator(this)
  },
  asEffect<Rule extends Ability.AnyRule>(this: Rule): Effect.Effect<Rule> {
    return Effect.succeed(this)
  },
  toJSON(this: Ability.AnyRule) {
    const json: {
      _tag: Ability.RuleKind
      action: Ability.SingleOrReadonlyArray<string>
      subject: Ability.SingleOrReadonlyArray<string>
      fields?: ReadonlyArray<string>
      conditions?: Ability.MongoCondition<any>
      reason?: string
    } = {
      _tag: this._tag,
      action: this.action,
      subject: this.subject
    }
    if (this.fields !== undefined) {
      json.fields = this.fields
    }
    if (this.conditions !== undefined) {
      json.conditions = this.conditions
    }
    if (this.reason !== undefined) {
      json.reason = this.reason
    }
    return json
  }
}

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

const SubjectProto = {
  ...Pipeable.Prototype,
  [SubjectTypeId]: SubjectTypeId,
  toJSON(this: Ability.TypedSubject<string, object>) {
    return {
      _id: "Subject",
      subject: this.subject,
      value: this.value
    }
  }
}

const freezeOptions = <Subjects extends Ability.SubjectMap>(
  options: Ability.AbilityOptions<Subjects> | undefined
): Ability.AbilityOptions<Subjects> => {
  const copy: {
    detectSubjectType?: Ability.DetectSubjectType<Subjects>
  } = {}
  if (options?.detectSubjectType !== undefined) {
    copy.detectSubjectType = options.detectSubjectType
  }
  return Object.freeze(copy)
}

const freezeRule = <Rules extends Ability.AnyRule>(rule: Rules): Rules => {
  const copy = Object.create(RuleProto) as {
    _tag: Rules["_tag"]
    action: Rules["action"]
    subject: Rules["subject"]
    fields?: Rules["fields"]
    conditions?: Rules["conditions"]
    when?: Rules["when"]
    reason?: Rules["reason"]
  }
  copy._tag = rule._tag
  copy.action = normalizeArray(rule.action) as Rules["action"]
  copy.subject = normalizeArray(rule.subject) as Rules["subject"]

  if (rule.fields !== undefined) {
    copy.fields = copyArray(rule.fields) as Rules["fields"]
  }
  if (rule.conditions !== undefined) {
    copy.conditions = cloneSerializable(rule.conditions) as Rules["conditions"]
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
  rules: Iterable<Rules>,
  options?: Ability.AbilityOptions<Subjects>
): Ability.Ability<Subjects, Rules> => {
  const self = Object.create(AbilityProto) as {
    rules: ReadonlyArray<Rules>
    options: Ability.AbilityOptions<Subjects>
  }
  self.rules = Object.freeze(Array.from(rules, freezeRule))
  self.options = freezeOptions(options)
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
  action: Ability.SingleOrReadonlyArray<Action>,
  subjectName: Ability.SingleOrReadonlyArray<Name>,
  options: Ability.RuleOptions<Subject, Fields, E, R> | undefined
): Ability.Rule<Kind, Action, Name, Subject, Fields, E, R> => {
  const rule = Object.create(RuleProto) as {
    _tag: Kind
    action: Ability.SingleOrReadonlyArray<Action>
    subject: Ability.SingleOrReadonlyArray<Name>
    fields?: ReadonlyArray<Fields>
    conditions?: Ability.MongoCondition<Subject>
    when?: Ability.Predicate<Subject, E, R>
    reason?: string
  }
  rule._tag = kind
  rule.action = normalizeArray(action) as Ability.SingleOrReadonlyArray<Action>
  rule.subject = normalizeArray(subjectName) as Ability.SingleOrReadonlyArray<Name>

  if (options?.fields !== undefined) {
    rule.fields = copyArray(wrapArray(options.fields)) as ReadonlyArray<Fields>
  }
  if (options?.conditions !== undefined) {
    rule.conditions = cloneSerializable(options.conditions) as Ability.MongoCondition<Subject>
  }
  if (options?.when !== undefined) {
    rule.when = options.when
  }
  if (options?.reason !== undefined) {
    rule.reason = options.reason
  }

  return Object.freeze(rule) as Ability.Rule<Kind, Action, Name, Subject, Fields, E, R>
}

const builder = <Subjects extends Ability.SubjectMap>(): Ability.Builder<Subjects> => ({
  allow: (action, subjectName, options) => makeRule("Allow", action, subjectName, options),
  deny: (action, subjectName, options) => makeRule("Deny", action, subjectName, options)
}) as Ability.Builder<Subjects>

type Define = <Subjects extends Ability.SubjectMap>() => <
  Eff extends Ability.AnyRule,
  A
>(
  body: (builder: Ability.Builder<Subjects>) => Generator<Eff, A, any>,
  options?: Ability.AbilityOptions<Subjects>
) => Ability.Ability<Subjects, Eff>

/**
 * @internal
 */
export const define = (<Subjects extends Ability.SubjectMap>() =>
<
  Eff extends Ability.AnyRule,
  A
>(
  body: (builder: Ability.Builder<Subjects>) => Generator<Eff, A, any>,
  options?: Ability.AbilityOptions<Subjects>
) => {
  const rules: Array<Eff> = []
  const iterator = body(builder<Subjects>())
  let state = iterator.next()

  while (!state.done) {
    rules.push(state.value)
    state = iterator.next(state.value)
  }

  return make<Subjects, Eff>(rules, options)
}
) as Define

/**
 * @internal
 */
export const subject = <const Name extends string, Value extends object>(
  subjectName: Name,
  value: Value
): Ability.TypedSubject<Name, Value> => {
  const wrapped = Object.create(SubjectProto) as {
    readonly [SubjectTypeId]: typeof SubjectTypeId
    _tag: "Subject"
    subject: Name
    value: Value
  }
  wrapped._tag = "Subject"
  wrapped.subject = subjectName
  wrapped.value = value
  return Object.freeze(wrapped) as unknown as Ability.TypedSubject<Name, Value>
}

/**
 * @internal
 */
export const isSubject = (value: unknown): value is Ability.TypedSubject<string, object> =>
  typeof value === "object" && value !== null && (value as { readonly [SubjectTypeId]?: unknown })[SubjectTypeId] === SubjectTypeId

/**
 * @internal
 */
export const unwrapSubject = <Value>(value: Value): Value extends Ability.TypedSubject<any, infer Subject> ? Subject : Value =>
  (isSubject(value) ? value.value : value) as never

const detectFromConstructor = (value: object): string | undefined => {
  const constructor = value.constructor as { readonly modelName?: unknown; readonly name?: unknown } | undefined
  if (typeof constructor?.modelName === "string" && constructor.modelName.length > 0) {
    return constructor.modelName
  }
  if (typeof constructor?.name === "string" && constructor.name.length > 0) {
    return constructor.name
  }
  return undefined
}

/**
 * @internal
 */
export const detectSubjectType = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
  self: Ability.Ability<Subjects, Rules>,
  value: object | Ability.TypedSubject<Ability.SubjectName<Subjects>, Ability.SubjectUnion<Subjects>>
): Effect.fn.Return<Ability.SubjectName<Subjects>, SubjectDetectionError> {
  if (isSubject(value)) {
    return value.subject as Ability.SubjectName<Subjects>
  }

  if (self.options.detectSubjectType !== undefined) {
    return yield* Effect.try({
      try: () => self.options.detectSubjectType?.(value) as Ability.SubjectName<Subjects>,
      catch: (cause) => new SubjectDetectionError({
        reason: "Failed to detect subject type with the configured detector",
        cause
      })
    })
  }

  const detected = detectFromConstructor(value)
  if (detected !== undefined) {
    return detected as Ability.SubjectName<Subjects>
  }

  return yield* Effect.fail(new SubjectDetectionError({
    reason: "Unable to detect subject type"
  }))
})

const hasOwnSubject = (request: object): request is { readonly subject: string } =>
  "subject" in request && typeof (request as { readonly subject?: unknown }).subject === "string"

const hasOwnValue = (request: object): request is { readonly value: object | Ability.TypedSubject<string, object> } =>
  "value" in request && typeof (request as { readonly value?: unknown }).value === "object" && (request as { readonly value?: unknown }).value !== null

const toRuntimeRequest = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly action: string; readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object>; readonly field?: string }
): Effect.fn.Return<RuntimeRequest, SubjectDetectionError> {
  const runtime: {
    action: string
    subject: string
    value?: object
    field?: string
  } = {
    action: request.action,
    subject: ""
  }

  if (hasOwnSubject(request)) {
    runtime.subject = request.subject
  } else if (hasOwnValue(request)) {
    runtime.subject = yield* detectSubjectType(self, request.value)
  } else {
    return yield* Effect.fail(new SubjectDetectionError({
      reason: "A check request must include either a subject or a value"
    }))
  }

  if (request.value !== undefined) {
    runtime.value = unwrapSubject(request.value)
  }
  if (request.field !== undefined) {
    runtime.field = request.field
  }

  return runtime
})

const hasAny = (values: ReadonlyArray<string>, value: string): boolean =>
  values.includes(value)

const matchesAction = (rule: RuntimeRule, action: string): boolean => {
  const actions = wrapArray(rule.action)
  return hasAny(actions, action) || hasAny(actions, anyAction)
}

const matchesSubject = (rule: RuntimeRule, subjectName: string): boolean => {
  const subjects = wrapArray(rule.subject)
  return hasAny(subjects, subjectName) || hasAny(subjects, anySubject)
}

const regexpSpecialChars = /[-/\\^$+?.()|[\]{}]/g
const regexpAny = /\.?\*+\.?/g
const regexpStars = /\*+/
const regexpDot = /\./g

const detectRegexpPattern = (match: string, index: number, source: string): string => {
  const quantifier = source[0] === "*" || match[0] === "." && match[match.length - 1] === "." ? "+" : "*"
  const matcher = match.includes("**") ? "." : "[^.]"
  const pattern = match.replace(regexpDot, "\\$&").replace(regexpStars, matcher + quantifier)
  return index + match.length === source.length ? `(?:${pattern})?` : pattern
}

const escapeRegexp = (match: string, index: number, source: string): string => {
  if (match === "." && (source[index - 1] === "*" || source[index + 1] === "*")) {
    return match
  }
  return `\\${match}`
}

const createFieldPattern = (fields: ReadonlyArray<string>): RegExp => {
  const patterns = fields.map((field) =>
    field
      .replace(regexpSpecialChars, escapeRegexp)
      .replace(regexpAny, detectRegexpPattern)
  )
  const pattern = patterns.length > 1 ? `(?:${patterns.join("|")})` : patterns[0] ?? ""
  return new RegExp(`^${pattern}$`)
}

const createFieldMatcher = (fields: ReadonlyArray<string>): (field: string) => boolean => {
  const pattern = fields.some((field) => field.includes("*")) ? createFieldPattern(fields) : undefined
  return pattern === undefined ? (field) => fields.includes(field) : (field) => pattern.test(field)
}

const matchesField = (rule: RuntimeRule, request: RuntimeRequest): boolean => {
  if (rule.fields === undefined) {
    return true
  }
  if (request.field === undefined) {
    return rule._tag === "Allow"
  }
  return createFieldMatcher(rule.fields)(request.field)
}

const isEmptyCondition = (conditions: Ability.MongoCondition<any>): boolean =>
  Object.keys(conditions as Record<string, unknown>).length === 0

const makeConditionError = (
  request: RuntimeRequest,
  cause: unknown
): ConditionError => {
  const error: {
    action: string
    subject: string
    field?: string
    cause: unknown
  } = {
    action: request.action,
    subject: request.subject,
    cause
  }
  if (request.field !== undefined) {
    error.field = request.field
  }
  return new ConditionError(error)
}

const matchesConditions = Effect.fnUntraced(function*(
  rule: RuntimeRule,
  request: RuntimeRequest
): Effect.fn.Return<boolean, ConditionError> {
  if (rule.conditions === undefined) {
    return true
  }
  if (request.value === undefined) {
    return rule._tag === "Allow" || isEmptyCondition(rule.conditions)
  }

  return yield* Effect.try({
    try: () => guard(rule.conditions as any)(request.value as Record<string, unknown>),
    catch: (cause) => makeConditionError(request, cause)
  })
})

const matchesPredicate = (
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

const matchesRule = Effect.fnUntraced(function*(
  rule: RuntimeRule,
  request: RuntimeRequest
): Effect.fn.Return<boolean, ConditionError | unknown, unknown> {
  if (!matchesAction(rule, request.action) || !matchesSubject(rule, request.subject) || !matchesField(rule, request)) {
    return false
  }

  const conditionMatches = yield* matchesConditions(rule, request)
  if (!conditionMatches) {
    return false
  }

  return yield* matchesPredicate(rule, request)
})

const possibleRulesFor = (
  rules: ReadonlyArray<RuntimeRule>,
  request: RuntimeRequest
): ReadonlyArray<RuntimeRule> =>
  rules.filter((rule) => matchesAction(rule, request.action) && matchesSubject(rule, request.subject))

const relevantRuleForEffect = Effect.fnUntraced(function*(
  rules: ReadonlyArray<RuntimeRule>,
  request: RuntimeRequest
): Effect.fn.Return<RuntimeRule | undefined, ConditionError | unknown, unknown> {
  let index = rules.length - 1
  while (index >= 0) {
    const rule = rules[index]
    if (rule !== undefined) {
      const matches = yield* matchesRule(rule, request)
      if (matches) {
        return rule
      }
    }
    index = index - 1
  }
  return undefined
})

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

const checkEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly action: string; readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object>; readonly field?: string }
): Effect.fn.Return<void, AuthorizationError | ConditionError | SubjectDetectionError | unknown, unknown> {
  const runtimeRequest = yield* toRuntimeRequest(self, request)
  const rule = yield* relevantRuleForEffect(self.rules as ReadonlyArray<RuntimeRule>, runtimeRequest)
  if (rule?._tag === "Allow") {
    return undefined
  }
  return yield* Effect.fail(makeAuthorizationError(runtimeRequest, rule))
})

/**
 * @internal
 */
export const check = dual(2, checkEffect)

const rawRuleError = (reason: string, ruleIndex: number, cause?: unknown): RawRuleError => {
  const error: {
    reason: string
    ruleIndex: number
    cause?: unknown
  } = {
    reason,
    ruleIndex
  }
  if (cause !== undefined) {
    error.cause = cause
  }
  return new RawRuleError(error)
}

const validateArrayValue = (
  value: Ability.SingleOrReadonlyArray<string>,
  name: string,
  index: number
): Effect.Effect<void, RawRuleError> => {
  if (Array.isArray(value) && value.length === 0) {
    return Effect.fail(rawRuleError(`rawRule.${name} cannot be an empty array`, index))
  }
  return Effect.void
}

const validateRawConditions = (
  conditions: Ability.MongoCondition<any> | undefined,
  index: number
): Effect.Effect<void, RawRuleError> => {
  if (conditions === undefined) {
    return Effect.void
  }
  return Effect.asVoid(Effect.try({
    try: () => guard(conditions as any),
    catch: (cause) => rawRuleError("rawRule.conditions cannot be compiled", index, cause)
  }))
}

/**
 * @internal
 */
export const fromRawRules = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap>(
  rules: Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>,
  options?: Ability.AbilityOptions<Subjects>
): Effect.fn.Return<Ability.Ability<Subjects, Ability.AnyRule>, RawRuleError> {
  const built: Array<Ability.AnyRule> = []
  let index = 0

  for (const rawRule of rules) {
    yield* validateArrayValue(rawRule.action, "action", index)
    yield* validateArrayValue(rawRule.subject, "subject", index)
    if (rawRule.fields !== undefined) {
      yield* validateArrayValue(rawRule.fields, "fields", index)
    }
    yield* validateRawConditions(rawRule.conditions, index)

    const ruleOptions: {
      fields?: Ability.SingleOrReadonlyArray<string>
      conditions?: Ability.MongoCondition<object>
      reason?: string
    } = {}
    if (rawRule.fields !== undefined) {
      ruleOptions.fields = rawRule.fields
    }
    if (rawRule.conditions !== undefined) {
      ruleOptions.conditions = rawRule.conditions as unknown as Ability.MongoCondition<object>
    }
    if (rawRule.reason !== undefined) {
      ruleOptions.reason = rawRule.reason
    }

    built.push(makeRule(rawRule.inverted === true ? "Deny" : "Allow", rawRule.action, rawRule.subject, ruleOptions))
    index = index + 1
  }

  return make<Subjects, Ability.AnyRule>(built, options)
})

const ruleToRaw = (
  rule: RuntimeRule
): Ability.RawRule => {
  const raw: {
    action: Ability.SingleOrReadonlyArray<string>
    subject: Ability.SingleOrReadonlyArray<string>
    fields?: ReadonlyArray<string>
    conditions?: Ability.MongoCondition<any>
    inverted?: boolean
    reason?: string
  } = {
    action: cloneSerializable(rule.action) as Ability.SingleOrReadonlyArray<string>,
    subject: cloneSerializable(rule.subject) as Ability.SingleOrReadonlyArray<string>
  }
  if (rule.fields !== undefined) {
    raw.fields = cloneSerializable(rule.fields) as ReadonlyArray<string>
  }
  if (rule.conditions !== undefined) {
    raw.conditions = cloneSerializable(rule.conditions) as Ability.MongoCondition<any>
  }
  if (rule._tag === "Deny") {
    raw.inverted = true
  }
  if (rule.reason !== undefined) {
    raw.reason = rule.reason
  }
  return Object.freeze(raw)
}

/**
 * @internal
 */
export const toRawRules = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule>(
  self: Ability.Ability<Subjects, Rules>,
  options?: Ability.ToRawRulesOptions
): Effect.fn.Return<ReadonlyArray<Ability.RawRule>, SerializationError> {
  const strict = options?.strict !== false
  const rawRules: Array<Ability.RawRule> = []
  let index = 0

  for (const rule of self.rules) {
    if (strict && rule.when !== undefined) {
      return yield* Effect.fail(new SerializationError({
        reason: "Cannot serialize rules with function predicates in strict mode",
        ruleIndex: index
      }))
    }
    rawRules.push(ruleToRaw(rule as RuntimeRule))
    index = index + 1
  }

  return Object.freeze(rawRules)
})

const fieldsForRule = (
  rule: RuntimeRule,
  options: Ability.PermittedFieldsOptions<Ability.AnyRule>
): ReadonlyArray<string> =>
  rule.fields ?? options.fieldsFrom(rule as Ability.AnyRule)

const permittedFieldsEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly action: string; readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object>; readonly field?: string },
  options: Ability.PermittedFieldsOptions<Ability.AnyRule>
): Effect.fn.Return<ReadonlyArray<string>, ConditionError | SubjectDetectionError | unknown, unknown> {
  const runtimeRequest = yield* toRuntimeRequest(self, request)
  const rules = possibleRulesFor(self.rules as ReadonlyArray<RuntimeRule>, runtimeRequest)
  const fields = new Set<string>()
  let index = 0

  while (index < rules.length) {
    const rule = rules[index]
    if (rule !== undefined) {
      const conditionMatches = yield* matchesConditions(rule, runtimeRequest)
      if (conditionMatches) {
        const predicateMatches = yield* matchesPredicate(rule, runtimeRequest)
        if (predicateMatches) {
          const ruleFields = fieldsForRule(rule, options)
          for (const field of ruleFields) {
            if (rule._tag === "Allow") {
              fields.add(field)
            } else {
              fields.delete(field)
            }
          }
        }
      }
    }
    index = index + 1
  }

  return Object.freeze(Array.from(fields))
})

/**
 * @internal
 */
export const permittedFields = dual(3, permittedFieldsEffect)
