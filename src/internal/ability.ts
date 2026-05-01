/**
 * @since 0.1.0
 */
import { guard } from "@ucast/mongo2js"
import type { MongoQuery } from "@ucast/mongo2js"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Equal from "effect/Equal"
import * as Formatter from "effect/Formatter"
import { dual } from "effect/Function"
import * as Hash from "effect/Hash"
import * as Inspectable from "effect/Inspectable"
import * as Pipeable from "effect/Pipeable"
import * as Predicate from "effect/Predicate"
import type * as Ability from "../Ability.js"
import { cloneSerializable } from "./serializable.js"

/**
 * @internal
 */
export const TypeId: unique symbol = Symbol.for("@nmnmcc/ability/Ability") as never

/**
 * @internal
 */
export const SubjectTypeId: unique symbol = Symbol.for("@nmnmcc/ability/Subject") as never

/**
 * @internal
 */
export const RuleTypeId: unique symbol = Symbol.for("@nmnmcc/ability/Rule") as never

const anyAction = "manage"
const anySubject = "all"
const RuleIndexTypeId: unique symbol = Symbol.for("@nmnmcc/ability/Ability/ruleIndex") as never

interface RuntimeRequest {
  readonly action: string
  readonly subject: string
  readonly value?: object
  readonly field?: string
}

type RuntimePredicate = (subject: object) => boolean | Effect.Effect<boolean, unknown, unknown>

interface RuntimeRule {
  readonly [RuleTypeId]: typeof RuleTypeId
  readonly _tag: Ability.RuleKind
  readonly action: Ability.SingleOrReadonlyArray<string>
  readonly subject: Ability.SingleOrReadonlyArray<string>
  readonly fields?: ReadonlyArray<string>
  readonly conditions?: Ability.MongoCondition<object>
  readonly when?: RuntimePredicate
  readonly reason?: string
}

interface RuntimeSubjectRequest {
  readonly subject: string
  readonly value?: object
}

interface IndexedRule {
  readonly rule: RuntimeRule
  readonly index: number
}

interface RuleIndex {
  readonly rulesBySubject: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<IndexedRule>>>
}

type RuntimeAbility = Ability.Ability<Ability.SubjectMap, Ability.AnyRule, Ability.ActionAliases> & {
  readonly options: Ability.AbilityOptions<Ability.SubjectMap, Ability.ActionAliases>
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
export class PredicateEvaluationError extends Data.TaggedError("PredicateEvaluationError")<{
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

/**
 * @since 0.1.0
 * @category Errors
 */
export class AliasError extends Data.TaggedError("AliasError")<{
  readonly reason: string
  readonly action?: string
}> {}

/**
 * @since 0.1.0
 * @category Errors
 */
export class QueryGenerationError extends Data.TaggedError("QueryGenerationError")<{
  readonly reason: string
  readonly ruleIndex?: number
  readonly cause?: unknown
}> {}

const copyArray = <A>(value: ReadonlyArray<A>): ReadonlyArray<A> => Object.freeze(Array.from(value))

const wrapArray = <A>(value: Ability.SingleOrReadonlyArray<A>): ReadonlyArray<A> =>
  Array.isArray(value) ? value as ReadonlyArray<A> : [value as A]

const normalizeArray = <A>(value: Ability.SingleOrReadonlyArray<A>): Ability.SingleOrReadonlyArray<A> =>
  Array.isArray(value) ? copyArray(value as ReadonlyArray<A>) : value

const unique = <A>(values: Iterable<A>): ReadonlyArray<A> =>
  Object.freeze(Array.from(new Set(values)))

const aliasError = (reason: string, action?: string): AliasError => {
  const error: {
    reason: string
    action?: string
  } = {
    reason
  }
  if (action !== undefined) {
    error.action = action
  }
  return new AliasError(error)
}

const normalizeActionAliases = (
  aliases: Ability.ActionAliases | undefined
): Readonly<Record<string, ReadonlyArray<string>>> => {
  if (aliases === undefined) {
    return Object.freeze({})
  }

  const normalized: Record<string, ReadonlyArray<string>> = {}
  for (const action of Object.keys(aliases)) {
    if (action === anyAction) {
      throw aliasError(`Cannot use "${anyAction}" as an action alias`, action)
    }

    const targets = wrapArray(aliases[action] as Ability.SingleOrReadonlyArray<string>)
    if (targets.length === 0) {
      throw aliasError("Action alias cannot target an empty action list", action)
    }
    for (const target of targets) {
      if (target === anyAction) {
        throw aliasError(`Cannot create an alias to reserved action "${anyAction}"`, action)
      }
    }
    normalized[action] = copyArray(targets)
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (action: string, path: ReadonlyArray<string>): void => {
    if (visited.has(action)) {
      return
    }
    if (visiting.has(action)) {
      throw aliasError(`Detected cyclic action alias: ${[...path, action].join(" -> ")}`, action)
    }

    const targets = normalized[action]
    if (targets === undefined) {
      return
    }

    visiting.add(action)
    for (const target of targets) {
      if (target === action) {
        throw aliasError(`Action alias "${action}" cannot reference itself`, action)
      }
      visit(target, [...path, action])
    }
    visiting.delete(action)
    visited.add(action)
  }

  for (const action of Object.keys(normalized)) {
    visit(action, [])
  }

  return Object.freeze(normalized)
}

const expandAction = (
  aliases: Readonly<Record<string, ReadonlyArray<string>>>,
  action: string,
  output: Set<string>
): void => {
  if (output.has(action)) {
    return
  }

  output.add(action)
  const targets = aliases[action]
  if (targets === undefined) {
    return
  }
  for (const target of targets) {
    expandAction(aliases, target, output)
  }
}

/**
 * @internal
 */
export const createAliasResolver = <const Aliases extends Ability.ActionAliases>(
  aliases: Aliases
): Ability.ActionResolver => {
  const normalized = normalizeActionAliases(aliases)
  return (action) => {
    const actions = new Set<string>()
    for (const value of wrapArray(action)) {
      expandAction(normalized, value, actions)
    }
    return unique(actions)
  }
}

function* ruleIterator<Rule extends Ability.AnyRule>(rule: Rule): Generator<Rule, Rule, Rule> {
  return yield rule
}

const inspectableToString = function(this: { toJSON(): unknown }): string {
  return Formatter.format(this.toJSON(), { ignoreToString: true, space: 2 })
}

const inspectableNode = function(this: { toJSON(): unknown }): unknown {
  return this.toJSON()
}

const ruleHashInput = (rule: RuntimeRule) => ({
  _tag: rule._tag,
  action: rule.action,
  subject: rule.subject,
  fields: rule.fields,
  conditions: rule.conditions,
  when: rule.when,
  reason: rule.reason
})

const RuleProto = {
  ...Pipeable.Prototype,
  [RuleTypeId]: RuleTypeId,
  [Symbol.iterator]<Rule extends Ability.AnyRule>(this: Rule): Generator<Rule, Rule, Rule> {
    return ruleIterator(this)
  },
  asEffect<Rule extends Ability.AnyRule>(this: Rule): Effect.Effect<Rule> {
    return Effect.succeed(this)
  },
  [Equal.symbol](this: RuntimeRule, that: Equal.Equal): boolean {
    return isRule(that) && Equal.equals(ruleHashInput(this), ruleHashInput(that as unknown as RuntimeRule))
  },
  [Hash.symbol](this: RuntimeRule): number {
    return Hash.structure(ruleHashInput(this))
  },
  toString: inspectableToString,
  toJSON(this: Ability.AnyRule) {
    const json: {
      _tag: Ability.RuleKind
      action: Ability.SingleOrReadonlyArray<string>
      subject: Ability.SingleOrReadonlyArray<string>
      fields?: ReadonlyArray<string>
      conditions?: Ability.MongoCondition<object>
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
  },
  [Inspectable.NodeInspectSymbol]: inspectableNode
}

const AbilityProto = {
  ...Pipeable.Prototype,
  [TypeId]: TypeId,
  [Equal.symbol](this: RuntimeAbility, that: Equal.Equal): boolean {
    return isAbility(that) &&
      Equal.equals(this.rules, (that as RuntimeAbility).rules) &&
      Equal.equals(this.options, (that as RuntimeAbility).options)
  },
  [Hash.symbol](this: RuntimeAbility): number {
    return Hash.structure({
      rules: this.rules,
      options: this.options
    })
  },
  toString: inspectableToString,
  toJSON(this: Ability.Ability<Ability.SubjectMap, Ability.AnyRule, Ability.ActionAliases>) {
    return {
      _id: "Ability",
      rules: this.rules,
      options: this.options
    }
  },
  [Inspectable.NodeInspectSymbol]: inspectableNode
}

const SubjectProto = {
  ...Pipeable.Prototype,
  [SubjectTypeId]: SubjectTypeId,
  [Equal.symbol](this: Ability.TypedSubject<string, object>, that: Equal.Equal): boolean {
    return isSubject(that) &&
      this.subject === that.subject &&
      Equal.equals(this.value, that.value)
  },
  [Hash.symbol](this: Ability.TypedSubject<string, object>): number {
    return Hash.structure({
      subject: this.subject,
      value: this.value
    })
  },
  toString: inspectableToString,
  toJSON(this: Ability.TypedSubject<string, object>) {
    return {
      _id: "Subject",
      subject: this.subject,
      value: this.value
    }
  },
  [Inspectable.NodeInspectSymbol]: inspectableNode
}

const freezeOptions = <Subjects extends Ability.SubjectMap>(
  options: Ability.AbilityOptions<Subjects, Ability.ActionAliases> | undefined
): Ability.AbilityOptions<Subjects, Ability.ActionAliases> => {
  const copy: {
    detectSubjectType?: Ability.DetectSubjectType<Subjects>
    actionAliases?: Ability.ActionAliases
  } = {}
  if (options?.detectSubjectType !== undefined) {
    copy.detectSubjectType = options.detectSubjectType
  }
  if (options?.actionAliases !== undefined) {
    copy.actionAliases = normalizeActionAliases(options.actionAliases)
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

const addIndexedRule = (
  index: Map<string, Map<string, Array<IndexedRule>>>,
  subjectName: string,
  action: string,
  indexedRule: IndexedRule
): void => {
  let subjectIndex = index.get(subjectName)
  if (subjectIndex === undefined) {
    subjectIndex = new Map()
    index.set(subjectName, subjectIndex)
  }

  let rules = subjectIndex.get(action)
  if (rules === undefined) {
    rules = []
    subjectIndex.set(action, rules)
  }
  rules.push(indexedRule)
}

const freezeRuleIndex = (
  index: Map<string, Map<string, Array<IndexedRule>>>
): RuleIndex => {
  const subjects = new Map<string, ReadonlyMap<string, ReadonlyArray<IndexedRule>>>()
  for (const [subjectName, actions] of index) {
    const actionIndex = new Map<string, ReadonlyArray<IndexedRule>>()
    for (const [action, rules] of actions) {
      actionIndex.set(action, Object.freeze(rules.slice().sort((a, b) => b.index - a.index)))
    }
    subjects.set(subjectName, actionIndex)
  }
  return Object.freeze({
    rulesBySubject: subjects
  })
}

const buildRuleIndex = (
  rules: ReadonlyArray<RuntimeRule>,
  aliases: Ability.ActionAliases | undefined
): RuleIndex => {
  const resolver = createAliasResolver(aliases ?? {})
  const index = new Map<string, Map<string, Array<IndexedRule>>>()
  let ruleIndex = 0

  for (const rule of rules) {
    const indexedRule: IndexedRule = {
      rule,
      index: ruleIndex
    }
    const actions = resolver(rule.action)
    const subjects = wrapArray(rule.subject)

    for (const subjectName of subjects) {
      for (const action of actions) {
        addIndexedRule(index, subjectName, action, indexedRule)
      }
    }
    ruleIndex = ruleIndex + 1
  }

  return freezeRuleIndex(index)
}

const getRuleIndex = (self: RuntimeAbility): RuleIndex =>
  (self as unknown as { readonly [RuleIndexTypeId]: RuleIndex })[RuleIndexTypeId]

/**
 * @internal
 */
export const make = <Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule, Aliases extends Ability.ActionAliases = {}>(
  rules: Iterable<Rules>,
  options?: Ability.AbilityOptions<Subjects, Aliases>
): Ability.Ability<Subjects, Rules, Aliases> => {
  const self = Object.create(AbilityProto) as {
    rules: ReadonlyArray<Rules>
    options: Ability.AbilityOptions<Subjects, Ability.ActionAliases>
    [RuleIndexTypeId]: RuleIndex
  }
  self.rules = Object.freeze(Array.from(rules, freezeRule))
  self.options = freezeOptions(options)
  self[RuleIndexTypeId] = buildRuleIndex(self.rules as unknown as ReadonlyArray<RuntimeRule>, self.options.actionAliases)
  return Object.freeze(self) as unknown as Ability.Ability<Subjects, Rules, Aliases>
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
  A,
  Aliases extends Ability.ActionAliases = {}
>(
  body: (builder: Ability.Builder<Subjects>) => Generator<Eff, A, unknown>,
  options?: Ability.AbilityOptions<Subjects, Aliases>
) => Ability.Ability<Subjects, Eff, Aliases>

/**
 * @internal
 */
export const define = (<Subjects extends Ability.SubjectMap>() =>
<
  Eff extends Ability.AnyRule,
  A,
  Aliases extends Ability.ActionAliases = {}
>(
  body: (builder: Ability.Builder<Subjects>) => Generator<Eff, A, unknown>,
  options?: Ability.AbilityOptions<Subjects, Aliases>
) => {
  const rules: Array<Eff> = []
  const iterator = body(builder<Subjects>())
  let state = iterator.next()

  while (!state.done) {
    rules.push(state.value)
    state = iterator.next(state.value)
  }

  return make<Subjects, Eff, Aliases>(rules, options)
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
  Predicate.hasProperty(value, SubjectTypeId)

/**
 * @internal
 */
export const isRule = (value: unknown): value is Ability.AnyRule =>
  Predicate.hasProperty(value, RuleTypeId)

/**
 * @internal
 */
export const isAbility = (value: unknown): value is Ability.Ability<Ability.SubjectMap, Ability.AnyRule, Ability.ActionAliases> =>
  Predicate.hasProperty(value, TypeId)

/**
 * @internal
 */
export const unwrapSubject = <Value>(value: Value): Value extends Ability.TypedSubject<infer _Name, infer Subject> ? Subject : Value =>
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
export const detectSubjectType = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule, Aliases extends Ability.ActionAliases>(
  self: Ability.Ability<Subjects, Rules, Aliases>,
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

  if (hasOwnValue(request)) {
    runtime.value = unwrapSubject(request.value)
  }
  if (request.field !== undefined) {
    runtime.field = request.field
  }

  return runtime
})

const toRuntimeSubjectRequest = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object> }
): Effect.fn.Return<RuntimeSubjectRequest, SubjectDetectionError> {
  const runtime: {
    subject: string
    value?: object
  } = {
    subject: ""
  }

  if (hasOwnSubject(request)) {
    runtime.subject = request.subject
  } else if (hasOwnValue(request)) {
    runtime.subject = yield* detectSubjectType(self, request.value)
  } else {
    return yield* Effect.fail(new SubjectDetectionError({
      reason: "A subject query request must include either a subject or a value"
    }))
  }

  if (hasOwnValue(request)) {
    runtime.value = unwrapSubject(request.value)
  }

  return runtime
})

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

const isEmptyCondition = (conditions: Ability.MongoCondition<object>): boolean =>
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

const makePredicateEvaluationError = (
  request: RuntimeRequest,
  cause: unknown
): PredicateEvaluationError => {
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
  return new PredicateEvaluationError(error)
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
    try: () => guard<Record<string, unknown>>(rule.conditions as MongoQuery<Record<string, unknown>>)(request.value as Record<string, unknown>),
    catch: (cause) => makeConditionError(request, cause)
  })
})

const matchesPredicate = Effect.fnUntraced(function*(
  rule: RuntimeRule,
  request: RuntimeRequest
): Effect.fn.Return<boolean, PredicateEvaluationError | unknown, unknown> {
  if (rule.when === undefined) {
    return true
  }
  if (request.value === undefined) {
    return false
  }

  const result = yield* Effect.try({
    try: () => rule.when?.(request.value as object) ?? true,
    catch: (cause) => makePredicateEvaluationError(request, cause)
  })
  return Effect.isEffect(result) ? yield* result : result
})

const matchesCandidateRule = Effect.fnUntraced(function*(
  rule: RuntimeRule,
  request: RuntimeRequest
): Effect.fn.Return<boolean, ConditionError | PredicateEvaluationError | unknown, unknown> {
  if (!matchesField(rule, request)) {
    return false
  }

  const conditionMatches = yield* matchesConditions(rule, request)
  if (!conditionMatches) {
    return false
  }

  return yield* matchesPredicate(rule, request)
})

const collectIndexedRules = (
  self: RuntimeAbility,
  request: RuntimeRequest,
  order: "ascending" | "descending"
): ReadonlyArray<RuntimeRule> => {
  const collected = new Map<RuntimeRule, IndexedRule>()
  const pairs: Array<readonly [string, string]> = [
    [request.subject, request.action]
  ]

  if (request.action !== anyAction) {
    pairs.push([request.subject, anyAction])
  }
  if (request.subject !== anySubject) {
    pairs.push([anySubject, request.action])
  }
  if (request.subject !== anySubject && request.action !== anyAction) {
    pairs.push([anySubject, anyAction])
  }

  for (const [subjectName, action] of pairs) {
    const subjectIndex = getRuleIndex(self).rulesBySubject.get(subjectName)
    const rules = subjectIndex?.get(action)
    if (rules !== undefined) {
      for (const indexedRule of rules) {
        collected.set(indexedRule.rule, indexedRule)
      }
    }
  }

  const sorted = Array.from(collected.values()).sort((a, b) =>
    order === "descending" ? b.index - a.index : a.index - b.index
  )
  return Object.freeze(sorted.map((indexedRule) => indexedRule.rule))
}

const possibleRulesForRequest = (
  self: RuntimeAbility,
  request: RuntimeRequest
): ReadonlyArray<RuntimeRule> =>
  collectIndexedRules(self, request, "descending")

const possibleRulesForDefinitionOrder = (
  self: RuntimeAbility,
  request: RuntimeRequest
): ReadonlyArray<RuntimeRule> =>
  collectIndexedRules(self, request, "ascending")

const relevantRuleForEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: RuntimeRequest
): Effect.fn.Return<RuntimeRule | undefined, ConditionError | PredicateEvaluationError | unknown, unknown> {
  const rules = possibleRulesForRequest(self, request)
  let index = 0
  while (index < rules.length) {
    const rule = rules[index]
    if (rule !== undefined) {
      const matches = yield* matchesCandidateRule(rule, request)
      if (matches) {
        return rule
      }
    }
    index = index + 1
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
): Effect.fn.Return<void, AuthorizationError | ConditionError | PredicateEvaluationError | SubjectDetectionError | unknown, unknown> {
  const runtimeRequest = yield* toRuntimeRequest(self, request)
  const rule = yield* relevantRuleForEffect(self, runtimeRequest)
  if (rule?._tag === "Allow") {
    return undefined
  }
  return yield* Effect.fail(makeAuthorizationError(runtimeRequest, rule))
})

/**
 * @internal
 */
export const check = dual(2, checkEffect)

const possibleRulesForEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly action: string; readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object>; readonly field?: string }
): Effect.fn.Return<ReadonlyArray<RuntimeRule>, SubjectDetectionError> {
  const runtimeRequest = yield* toRuntimeRequest(self, request)
  return possibleRulesForRequest(self, runtimeRequest)
})

/**
 * @internal
 */
export const possibleRulesFor = dual(2, possibleRulesForEffect)

const rulesForEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly action: string; readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object>; readonly field?: string }
): Effect.fn.Return<ReadonlyArray<RuntimeRule>, SubjectDetectionError> {
  const runtimeRequest = yield* toRuntimeRequest(self, request)
  return Object.freeze(possibleRulesForRequest(self, runtimeRequest).filter((rule) => matchesField(rule, runtimeRequest)))
})

/**
 * @internal
 */
export const rulesFor = dual(2, rulesForEffect)

const relevantRuleForAccessorEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly action: string; readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object>; readonly field?: string }
): Effect.fn.Return<RuntimeRule | undefined, ConditionError | PredicateEvaluationError | SubjectDetectionError | unknown, unknown> {
  const runtimeRequest = yield* toRuntimeRequest(self, request)
  return yield* relevantRuleForEffect(self, runtimeRequest)
})

/**
 * @internal
 */
export const relevantRuleFor = dual(2, relevantRuleForAccessorEffect)

const actionsForEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object> }
): Effect.fn.Return<ReadonlyArray<string>, SubjectDetectionError> {
  const runtimeRequest = yield* toRuntimeSubjectRequest(self, request)
  const actions = new Set<string>()
  const collect = (subjectName: string): void => {
    const subjectIndex = getRuleIndex(self).rulesBySubject.get(subjectName)
    if (subjectIndex !== undefined) {
      for (const action of subjectIndex.keys()) {
        actions.add(action)
      }
    }
  }

  collect(runtimeRequest.subject)
  if (runtimeRequest.subject !== anySubject) {
    collect(anySubject)
  }

  return unique(actions)
})

/**
 * @internal
 */
export const actionsFor = dual(2, actionsForEffect)

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

const validateRawConditions = <Subject extends object>(
  conditions: Ability.MongoCondition<Subject> | undefined,
  index: number
): Effect.Effect<void, RawRuleError> => {
  if (conditions === undefined) {
    return Effect.void
  }
  return Effect.asVoid(Effect.try({
    try: () => guard<Record<string, unknown>>(conditions as unknown as MongoQuery<Record<string, unknown>>),
    catch: (cause) => rawRuleError("rawRule.conditions cannot be compiled", index, cause)
  }))
}

/**
 * @internal
 */
export const fromRawRules = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Aliases extends Ability.ActionAliases = {}>(
  rules: Iterable<Ability.RawRule<string, Ability.RuleSubject<Subjects>, string, Ability.MongoCondition<Ability.SubjectUnion<Subjects>>>>,
  options?: Ability.AbilityOptions<Subjects, Aliases>
): Effect.fn.Return<Ability.Ability<Subjects, Ability.AnyRule, Aliases>, AliasError | RawRuleError> {
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

  return yield* Effect.try({
    try: () => make<Subjects, Ability.AnyRule, Aliases>(built, options),
    catch: (cause) => cause instanceof AliasError
      ? cause
      : rawRuleError("Unable to construct Ability from raw rules", index, cause)
  })
})

const ruleToRaw = (
  rule: RuntimeRule
): Ability.RawRule => {
  const raw: {
    action: Ability.SingleOrReadonlyArray<string>
    subject: Ability.SingleOrReadonlyArray<string>
    fields?: ReadonlyArray<string>
    conditions?: Ability.MongoCondition<object>
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
    raw.conditions = cloneSerializable(rule.conditions) as Ability.MongoCondition<object>
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
export const toRawRules = Effect.fnUntraced(function*<Subjects extends Ability.SubjectMap, Rules extends Ability.AnyRule, Aliases extends Ability.ActionAliases>(
  self: Ability.Ability<Subjects, Rules, Aliases>,
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
    rawRules.push(ruleToRaw(rule as unknown as RuntimeRule))
    index = index + 1
  }

  return Object.freeze(rawRules)
})

const fieldsForRule = (
  rule: RuntimeRule,
  options: Ability.PermittedFieldsOptions<Ability.AnyRule>
): ReadonlyArray<string> =>
  rule.fields ?? options.fieldsFrom(rule as unknown as Ability.AnyRule)

const permittedFieldsEffect = Effect.fnUntraced(function*(
  self: RuntimeAbility,
  request: { readonly action: string; readonly subject?: string; readonly value?: object | Ability.TypedSubject<string, object>; readonly field?: string },
  options: Ability.PermittedFieldsOptions<Ability.AnyRule>
): Effect.fn.Return<ReadonlyArray<string>, ConditionError | PredicateEvaluationError | SubjectDetectionError | unknown, unknown> {
  const runtimeRequest = yield* toRuntimeRequest(self, request)
  const rules = possibleRulesForDefinitionOrder(self, runtimeRequest)
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
