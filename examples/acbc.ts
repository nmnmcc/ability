import { Context, Effect } from "effect"
import { Ability } from "../src/index"

interface Document {
  readonly id: string
  readonly tenantId: string
  readonly ownerId: string
  readonly state: "draft" | "published"
  readonly classification: "public" | "internal" | "restricted"
  readonly title: string
  readonly body: string
}

interface User {
  readonly id: string
  readonly tenantId: string
  readonly role: "admin" | "editor" | "auditor"
  readonly clearance: "low" | "high"
}

interface AuthorizationContext {
  readonly actor: User
  readonly tenantId: string
  readonly trustedNetwork: boolean
  readonly businessHours: boolean
}

type Subjects = {
  readonly Document: Document
  readonly User: User
}

class CurrentAuthorizationContext extends Context.Service<CurrentAuthorizationContext, AuthorizationContext>()(
  "CurrentAuthorizationContext"
) {}

const sameTenant = (context: AuthorizationContext, document: Document): boolean =>
  context.tenantId === document.tenantId && context.actor.tenantId === document.tenantId

const canReadClassification = (actor: User, document: Document): boolean =>
  document.classification !== "restricted" || actor.clearance === "high"

const documentAbility = Ability.define<Subjects>()(function* (ability) {
  yield* ability.allow("read", "Document", {
    when: (document) =>
      Effect.gen(function* () {
        const context = yield* CurrentAuthorizationContext
        return sameTenant(context, document)
          && canReadClassification(context.actor, document)
          && (
            document.classification === "public"
            || document.ownerId === context.actor.id
            || context.actor.role === "admin"
            || context.actor.role === "auditor"
          )
      })
  })

  yield* ability.allow("update", "Document", {
    fields: ["title", "body"],
    when: (document) =>
      Effect.gen(function* () {
        const context = yield* CurrentAuthorizationContext
        return sameTenant(context, document)
          && context.trustedNetwork
          && (context.actor.role === "admin" || document.ownerId === context.actor.id)
      })
  })

  yield* ability.allow("publish", "Document", {
    when: (document) =>
      Effect.gen(function* () {
        const context = yield* CurrentAuthorizationContext
        return sameTenant(context, document)
          && context.actor.role === "admin"
          && context.actor.clearance === "high"
      })
  })

  yield* ability.deny("publish", "Document", {
    when: () =>
      Effect.gen(function* () {
        const context = yield* CurrentAuthorizationContext
        return !context.trustedNetwork || !context.businessHours
      }),
    reason: "Publishing requires a trusted network during business hours"
  })
})

type DocumentAbilityRule = (typeof documentAbility)["rules"][number]

class CurrentAbility extends Context.Service<CurrentAbility, typeof documentAbility>()("CurrentAbility") {}

const authorize = <const Request extends Ability.CheckRequest<Subjects, DocumentAbilityRule>>(
  request: Request
) =>
  Effect.gen(function* () {
    const ability = yield* CurrentAbility
    yield* Ability.check(ability, request)
  })

const explainFailure = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tagged = error as { readonly _tag: string; readonly reason?: string }
    return tagged.reason === undefined ? tagged._tag : `${tagged._tag}: ${tagged.reason}`
  }
  return "UnknownError"
}

const decision = <const Request extends Ability.CheckRequest<Subjects, DocumentAbilityRule>>(
  context: AuthorizationContext,
  request: Request
) =>
  authorize(request).pipe(
    Effect.provideService(CurrentAbility, documentAbility),
    Effect.provideService(CurrentAuthorizationContext, context),
    Effect.match({
      onFailure: (error) => ({
        allowed: false,
        reason: explainFailure(error)
      }),
      onSuccess: () => ({
        allowed: true
      })
    })
  )

const document: Document = {
  id: "doc-1",
  tenantId: "tenant-a",
  ownerId: "user-1",
  state: "draft",
  classification: "restricted",
  title: "Quarterly plan",
  body: "Internal launch notes"
}

const editor: User = {
  id: "user-1",
  tenantId: "tenant-a",
  role: "editor",
  clearance: "high"
}

const admin: User = {
  id: "user-2",
  tenantId: "tenant-a",
  role: "admin",
  clearance: "high"
}

const outsider: User = {
  id: "user-3",
  tenantId: "tenant-b",
  role: "auditor",
  clearance: "high"
}

const businessContext: AuthorizationContext = {
  actor: editor,
  tenantId: "tenant-a",
  trustedNetwork: true,
  businessHours: true
}

const afterHoursAdminContext: AuthorizationContext = {
  actor: admin,
  tenantId: "tenant-a",
  trustedNetwork: true,
  businessHours: false
}

const outsiderContext: AuthorizationContext = {
  actor: outsider,
  tenantId: "tenant-b",
  trustedNetwork: true,
  businessHours: true
}

const program = Effect.gen(function* () {
  const readOwnRestricted = yield* decision(businessContext, {
    action: "read",
    subject: "Document",
    value: document
  })

  const updateBody = yield* decision(businessContext, {
    action: "update",
    subject: "Document",
    value: document,
    field: "body"
  })

  const publishAfterHours = yield* decision(afterHoursAdminContext, {
    action: "publish",
    subject: "Document",
    value: document
  })

  const crossTenantRead = yield* decision(outsiderContext, {
    action: "read",
    subject: "Document",
    value: document
  })

  return {
    readOwnRestricted,
    updateBody,
    publishAfterHours,
    crossTenantRead
  }
})

console.log(Effect.runSync(program))
