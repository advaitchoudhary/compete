/**
 * Google API access for the Firebase MCP server.
 *
 * Uses Application Default Credentials — the same `gcloud auth login` session a
 * developer already has — rather than a service-account key file. Creating a
 * project, enabling a sign-in provider or minting a key are all things a *person*
 * is authorised to do; the AllSports service account is scoped to one project and
 * cannot do any of them. Tying this to ADC also means the server holds no secret
 * of its own.
 *
 * Every call surfaces Google's own error text. These operations fail for reasons
 * that are specific and actionable — billing not enabled, org policy blocking
 * project creation, quota exhausted — and paraphrasing them into "request failed"
 * would throw away the only useful part.
 */
import { GoogleAuth } from 'google-auth-library'

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/firebase',
]

let auth: GoogleAuth | undefined

function client(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: SCOPES })
  return auth
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly reason?: string
  ) {
    super(message)
  }
}

/** Whether a usable credential is present, and who it belongs to. */
export async function whoami(): Promise<{ ok: boolean; detail: string }> {
  try {
    const c = await client().getClient()
    const token = await c.getAccessToken()
    if (!token?.token) {
      return { ok: false, detail: 'No access token — run `gcloud auth application-default login`.' }
    }
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token.token)}`
    )
    if (!res.ok) return { ok: true, detail: 'Credential present (identity not readable).' }
    const info = (await res.json()) as { email?: string; scope?: string }
    return { ok: true, detail: info.email ?? 'service credential' }
  } catch (e) {
    return {
      ok: false,
      detail:
        `${(e as Error).message}\n\n` +
        'Run `gcloud auth application-default login` and try again.',
    }
  }
}

/** Authenticated JSON call against a Google API. */
export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown
): Promise<T> {
  const c = await client().getClient()
  const token = await c.getAccessToken()
  if (!token?.token) {
    throw new GoogleApiError(
      'Not authenticated. Run `gcloud auth application-default login`.'
    )
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const text = await res.text()
  const parsed = text ? safeJson(text) : undefined

  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; status?: string } })?.error
    throw new GoogleApiError(
      err?.message ?? text ?? `HTTP ${res.status}`,
      res.status,
      err?.status
    )
  }
  return parsed as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Long-running operations (project creation, adding Firebase) return an
 * Operation. Poll until it settles rather than returning a name the caller can do
 * nothing with.
 */
export async function awaitOperation<T = unknown>(
  operationName: string,
  { attempts = 30, delayMs = 2000 } = {}
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const op = await api<{
      done?: boolean
      response?: T
      error?: { message?: string }
    }>('GET', `https://firebase.googleapis.com/v1beta1/${operationName}`)

    if (op.done) {
      if (op.error) throw new GoogleApiError(op.error.message ?? 'Operation failed')
      return op.response as T
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  throw new GoogleApiError(
    `Operation ${operationName} did not finish in time. It may still be running — re-check with firebase_list_projects.`
  )
}
