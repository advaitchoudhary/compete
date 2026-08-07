#!/usr/bin/env node
/**
 * Firebase MCP server — provision and configure Firebase projects as tools.
 *
 * Exists because AllSports needs the same auth setup applied to more than one
 * project (dev today, prod next, staging eventually) and the console path is a
 * dozen clicks that nobody remembers correctly the second time. The steps encoded
 * here are exactly the ones the backend depends on:
 *
 *   create project → add Firebase → enable phone sign-in → register test numbers
 *   → mint a service-account key → hand back the three env vars the API reads.
 *
 * Authentication is the caller's own Google login (ADC), never a stored secret —
 * see google.ts. Nothing here can run against a project the person driving it is
 * not already entitled to administer.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { api, awaitOperation, whoami, GoogleApiError } from './google.js'

const server = new McpServer({ name: 'firebase-admin', version: '0.1.0' })

/** Tools return text; wrap consistently and let Google's own error text through. */
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

async function guard<T>(fn: () => Promise<T>): Promise<T | string> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof GoogleApiError) {
      return `Google API error${e.status ? ` (${e.status}${e.reason ? ` ${e.reason}` : ''})` : ''}:\n${e.message}`
    }
    return `Failed: ${(e as Error).message}`
  }
}

// ── Who am I ────────────────────────────────────────────────────────────────
server.registerTool(
  'firebase_whoami',
  {
    title: 'Check Google credentials',
    description:
      'Report which Google identity the server is acting as. Run this first — every ' +
      'other tool fails without an Application Default Credentials login.',
    inputSchema: {},
  },
  async () => {
    const who = await whoami()
    return text(who.ok ? `Authenticated as: ${who.detail}` : `Not authenticated.\n${who.detail}`)
  }
)

// ── List ────────────────────────────────────────────────────────────────────
server.registerTool(
  'firebase_list_projects',
  {
    title: 'List Firebase projects',
    description: 'Every project with Firebase enabled that this identity can see.',
    inputSchema: {},
  },
  async () =>
    text(
      String(
        await guard(async () => {
          const res = await api<{ results?: Array<{ projectId: string; displayName?: string; state?: string }> }>(
            'GET',
            'https://firebase.googleapis.com/v1beta1/projects?pageSize=100'
          )
          const rows = res.results ?? []
          if (rows.length === 0) return 'No Firebase projects visible to this identity.'
          return rows
            .map((p) => `${p.projectId}${p.displayName ? `  (${p.displayName})` : ''}${p.state ? `  [${p.state}]` : ''}`)
            .join('\n')
        })
      )
    )
)

// ── Create ──────────────────────────────────────────────────────────────────
server.registerTool(
  'firebase_create_project',
  {
    title: 'Create a project and add Firebase',
    description:
      'Create a Google Cloud project and enable Firebase on it. Two long-running ' +
      'operations, both awaited. Fails if the id is taken, if org policy forbids ' +
      'project creation, or if the account is over its project quota — the error ' +
      'says which.',
    inputSchema: {
      project_id: z
        .string()
        .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, '6-30 chars, lowercase letters, digits and hyphens, starting with a letter')
        .describe('Globally unique project id, e.g. allsports-prod'),
      display_name: z.string().min(2).max(60).optional().describe('Human-readable name'),
    },
  },
  async ({ project_id, display_name }) =>
    text(
      String(
        await guard(async () => {
          const create = await api<{ name: string }>(
            'POST',
            'https://cloudresourcemanager.googleapis.com/v1/projects',
            { projectId: project_id, name: display_name ?? project_id }
          )
          // Resource Manager operations live on a different host to Firebase's.
          for (let i = 0; i < 30; i++) {
            const op = await api<{ done?: boolean; error?: { message?: string } }>(
              'GET',
              `https://cloudresourcemanager.googleapis.com/v1/${create.name}`
            )
            if (op.done) {
              if (op.error) throw new GoogleApiError(op.error.message ?? 'Project creation failed')
              break
            }
            await new Promise((r) => setTimeout(r, 2000))
          }

          const add = await api<{ name: string }>(
            'POST',
            `https://firebase.googleapis.com/v1beta1/projects/${project_id}:addFirebase`,
            {}
          )
          await awaitOperation(add.name)

          return (
            `Created ${project_id} and enabled Firebase.\n\n` +
            'Next: firebase_enable_phone_auth, then firebase_create_service_account_key.\n' +
            'Note that phone sign-in beyond the free testing quota needs billing (Blaze) ' +
            'attached to this project.'
          )
        })
      )
    )
)

// ── Read auth config ────────────────────────────────────────────────────────
server.registerTool(
  'firebase_get_auth_config',
  {
    title: 'Read auth configuration',
    description: 'Current sign-in configuration: whether phone auth is on, and any registered test numbers.',
    inputSchema: { project_id: z.string().describe('Project id') },
  },
  async ({ project_id }) =>
    text(
      String(
        await guard(async () => {
          const cfg = await api<{
            signIn?: {
              phoneNumber?: { enabled?: boolean; testPhoneNumbers?: Record<string, string> }
              email?: { enabled?: boolean }
              anonymous?: { enabled?: boolean }
            }
          }>('GET', `https://identitytoolkit.googleapis.com/admin/v2/projects/${project_id}/config`)

          const phone = cfg.signIn?.phoneNumber
          const tests = Object.entries(phone?.testPhoneNumbers ?? {})
          return [
            `phone sign-in: ${phone?.enabled ? 'ENABLED' : 'disabled'}`,
            `email sign-in: ${cfg.signIn?.email?.enabled ? 'enabled' : 'disabled'}`,
            `anonymous:     ${cfg.signIn?.anonymous?.enabled ? 'enabled' : 'disabled'}`,
            tests.length
              ? `test numbers:\n${tests.map(([n, c]) => `  ${n} → ${c}`).join('\n')}`
              : 'test numbers: none (add some before testing, so no real SMS is sent)',
          ].join('\n')
        })
      )
    )
)

// ── Enable phone auth ───────────────────────────────────────────────────────
server.registerTool(
  'firebase_enable_phone_auth',
  {
    title: 'Enable phone sign-in',
    description:
      'Turn on phone-number sign-in, and optionally register test numbers. Test ' +
      'numbers return a fixed code without sending an SMS, which is how you develop ' +
      'against this without paying per message or waiting for a real handset.',
    inputSchema: {
      project_id: z.string().describe('Project id'),
      test_numbers: z
        .record(z.string(), z.string())
        .optional()
        .describe('E.164 number → fixed 6-digit code, e.g. {"+919999900001":"123456"}'),
    },
  },
  async ({ project_id, test_numbers }) =>
    text(
      String(
        await guard(async () => {
          // Adding Firebase to a project does not provision Auth. Until something
          // creates the Identity Toolkit config, every admin/v2 config call 404s
          // with CONFIGURATION_NOT_FOUND — which reads like a missing project and
          // is really a missing feature.
          await api(
            'POST',
            `https://serviceusage.googleapis.com/v1/projects/${project_id}/services/identitytoolkit.googleapis.com:enable`,
            {}
          ).catch(() => undefined) // already enabled is fine

          try {
            await api('GET', `https://identitytoolkit.googleapis.com/admin/v2/projects/${project_id}/config`)
          } catch (e) {
            if ((e as GoogleApiError).status !== 404) throw e
            // The programmatic initialiser is an Identity Platform (paid) feature.
            // On the free Firebase Auth tier the only way to create the config is
            // the console's "Get started", which costs nothing but is a human step.
            try {
              await api(
                'POST',
                `https://identitytoolkit.googleapis.com/v2/projects/${project_id}/identityPlatform:initializeAuth`,
                {}
              )
            } catch (initErr) {
              const msg = (initErr as GoogleApiError).message
              if (/BILLING_NOT_ENABLED/i.test(msg)) {
                throw new GoogleApiError(
                  `Authentication is not initialised on ${project_id}, and initialising it through the API ` +
                    'needs billing (Identity Platform is a paid feature).\n\n' +
                    'The free path is one click, once:\n' +
                    `  https://console.firebase.google.com/project/${project_id}/authentication\n` +
                    '  → Get started → Phone → Enable\n\n' +
                    'After that every tool here works, including this one for test numbers.'
                )
              }
              throw initErr
            }
          }

          const mask = test_numbers
            ? 'signIn.phoneNumber.enabled,signIn.phoneNumber.testPhoneNumbers'
            : 'signIn.phoneNumber.enabled'

          await api(
            'PATCH',
            `https://identitytoolkit.googleapis.com/admin/v2/projects/${project_id}/config?updateMask=${mask}`,
            {
              signIn: {
                phoneNumber: {
                  enabled: true,
                  ...(test_numbers ? { testPhoneNumbers: test_numbers } : {}),
                },
              },
            }
          )
          const count = test_numbers ? Object.keys(test_numbers).length : 0
          return `Phone sign-in enabled on ${project_id}.${count ? ` ${count} test number(s) registered.` : ''}`
        })
      )
    )
)

// ── Service account key ─────────────────────────────────────────────────────
server.registerTool(
  'firebase_create_service_account_key',
  {
    title: 'Mint an admin service-account key',
    description:
      'Create a private key for the project’s Firebase Admin service account and ' +
      'return the three values the AllSports backend reads. SENSITIVE: this returns ' +
      'a live private key. It belongs in the gitignored .env and nowhere else.',
    inputSchema: { project_id: z.string().describe('Project id') },
  },
  async ({ project_id }) =>
    text(
      String(
        await guard(async () => {
          const list = await api<{ accounts?: Array<{ name: string; email: string }> }>(
            'GET',
            `https://iam.googleapis.com/v1/projects/${project_id}/serviceAccounts`
          )
          // Firebase provisions this account when Firebase is added to the project.
          const sa =
            list.accounts?.find((a) => a.email.startsWith('firebase-adminsdk')) ??
            list.accounts?.[0]
          if (!sa) {
            throw new GoogleApiError(
              `No service account found on ${project_id}. Has Firebase been added to it?`
            )
          }

          const key = await api<{ privateKeyData: string }>(
            'POST',
            `https://iam.googleapis.com/v1/${sa.name}/keys`,
            { privateKeyType: 'TYPE_GOOGLE_CREDENTIALS_FILE', keyAlgorithm: 'KEY_ALG_RSA_2048' }
          )
          const json = JSON.parse(Buffer.from(key.privateKeyData, 'base64').toString('utf8')) as {
            project_id: string
            client_email: string
            private_key: string
          }

          // The backend does .replace(/\\n/g,'\n'), so the key goes in escaped and quoted.
          const escaped = json.private_key.replace(/\n/g, '\\n')
          return [
            `Key created for ${json.client_email}.`,
            '',
            'Add to the gitignored .env (do not commit, do not paste in chat logs):',
            '',
            `FIREBASE_PROJECT_ID=${json.project_id}`,
            `FIREBASE_CLIENT_EMAIL=${json.client_email}`,
            `FIREBASE_PRIVATE_KEY="${escaped}"`,
          ].join('\n')
        })
      )
    )
)

await server.connect(new StdioServerTransport())
