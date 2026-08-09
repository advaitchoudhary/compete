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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GoogleAuth } from 'google-auth-library'

const execFileAsync = promisify(execFile)

const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/firebase',
]

/**
 * Which gcloud account to borrow a token from, when set.
 *
 * Application Default Credentials are the tidy path but frequently unusable in
 * practice: a corporate Google account with enforced reauth leaves ADC returning
 * `invalid_rapt` and the only cure is an interactive browser login. Meanwhile the
 * developer usually has a perfectly good `gcloud` session for a different
 * account. GCLOUD_ACCOUNT says "use that one instead".
 */
const GCLOUD_ACCOUNT = process.env.GCLOUD_ACCOUNT

/**
 * User credentials — as opposed to a service account — are billed against a
 * "quota project", and firebase.googleapis.com refuses the call outright without
 * one. Any project the caller owns will do.
 */
const QUOTA_PROJECT = process.env.GOOGLE_CLOUD_QUOTA_PROJECT

let auth: GoogleAuth | undefined

function client(): GoogleAuth {
  auth ??= new GoogleAuth({ scopes: SCOPES })
  return auth
}

/** A token from the gcloud CLI for the configured account. */
async function gcloudToken(): Promise<string> {
  const { stdout } = await execFileAsync('gcloud', [
    'auth',
    'print-access-token',
    `--account=${GCLOUD_ACCOUNT}`,
  ])
  const token = stdout.trim()
  if (!token) throw new GoogleApiError(`gcloud returned no token for ${GCLOUD_ACCOUNT}.`)
  return token
}

async function accessToken(): Promise<string> {
  if (GCLOUD_ACCOUNT) return gcloudToken()
  const c = await client().getClient()
  const token = await c.getAccessToken()
  if (!token?.token) {
    throw new GoogleApiError(
      'Not authenticated. Either run `gcloud auth application-default login`, ' +
        'or set GCLOUD_ACCOUNT to an account with an existing `gcloud` session.'
    )
  }
  return token.token
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
    const token = await accessToken()
    const via = GCLOUD_ACCOUNT ? `gcloud session for ${GCLOUD_ACCOUNT}` : 'application default credentials'
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`
    )
    const quota = QUOTA_PROJECT ? `, quota project ${QUOTA_PROJECT}` : ' (no GOOGLE_CLOUD_QUOTA_PROJECT set — firebase.googleapis.com will refuse user credentials)'
    if (!res.ok) return { ok: true, detail: `credential present via ${via}${quota}` }
    const info = (await res.json()) as { email?: string; scope?: string }
    return { ok: true, detail: `${info.email ?? 'service credential'} via ${via}${quota}` }
  } catch (e) {
    return {
      ok: false,
      detail:
        `${(e as Error).message}\n\n` +
        'Run `gcloud auth application-default login`, or set GCLOUD_ACCOUNT to an ' +
        'account that already has a `gcloud` session.',
    }
  }
}

/** Authenticated JSON call against a Google API. */
export async function api<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown
): Promise<T> {
  const token = await accessToken()

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(QUOTA_PROJECT ? { 'x-goog-user-project': QUOTA_PROJECT } : {}),
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
