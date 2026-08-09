# Firebase MCP server

Provisions and configures the Firebase projects AllSports authenticates against,
so the same setup can be applied to dev, prod and staging without anyone
remembering a dozen console clicks correctly.

## Setup

```bash
npm install && npm run build
```

Registered in the repo's `.mcp.json`. Two environment variables decide how it
authenticates:

| Variable | Why |
|---|---|
| `GCLOUD_ACCOUNT` | Borrow a token from an existing `gcloud` session instead of Application Default Credentials. ADC is the tidy path but a corporate Google account with enforced reauth leaves it returning `invalid_rapt`, curable only by an interactive browser login. |
| `GOOGLE_CLOUD_QUOTA_PROJECT` | User credentials are billed to a quota project and `firebase.googleapis.com` refuses the call without one. Any project you own will do. |

## Tools

| Tool | Does |
|---|---|
| `firebase_whoami` | Which identity is in play, and how. Run this first. |
| `firebase_list_projects` | Firebase projects visible to that identity. |
| `firebase_create_project` | Create a GCP project and add Firebase. Both long-running operations are awaited. |
| `firebase_get_auth_config` | Sign-in providers and registered test numbers. |
| `firebase_enable_phone_auth` | Enable phone sign-in, optionally with test numbers. |
| `firebase_create_service_account_key` | Mint an admin key and return the three `FIREBASE_*` env vars the backend reads. **Returns a live private key.** |

## The one manual step

Adding Firebase to a project does **not** provision Authentication. Until
something creates the Identity Toolkit config, every config call returns
`CONFIGURATION_NOT_FOUND`, which reads like a missing project and is really a
missing feature.

Initialising it through the API is an Identity Platform feature and needs billing.
The free path is one click, once, per project:

```
https://console.firebase.google.com/project/<id>/authentication
  → Get started → Phone → Enable
```

After that every tool here works against that project.

## Test numbers

Register test numbers before touching a real handset. They return a fixed code
without sending an SMS, so development costs nothing and does not wait on a
carrier:

```json
{ "project_id": "allsports-prod", "test_numbers": { "+919999900001": "123456" } }
```
