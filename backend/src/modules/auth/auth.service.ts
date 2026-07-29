import * as admin from 'firebase-admin'
import type { FastifyInstance } from 'fastify'

let firebaseApp: admin.app.App

export function initFirebase(): void {
  if (admin.apps.length > 0) return

  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')

  if (!projectId || !clientEmail || !privateKey) {
    console.warn(
      '⚠️  Firebase credentials not configured — auth endpoints will return 401.\n' +
      '   Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY to enable auth.'
    )
    return
  }

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  })
}

export interface FirebaseUserRecord {
  uid: string
  phone_number: string | undefined
  email: string | undefined
}

export async function verifyFirebaseToken(
  idToken: string
): Promise<FirebaseUserRecord | null> {
  if (!admin.apps.length) return null
  try {
    const decoded = await admin.auth().verifyIdToken(idToken)
    return {
      uid: decoded.uid,
      phone_number: decoded.phone_number,
      email: decoded.email,
    }
  } catch {
    return null
  }
}

export function issueJwt(app: FastifyInstance, userId: string): string {
  return app.jwt.sign(
    { sub: userId },
    { expiresIn: process.env.JWT_EXPIRES_IN ?? '7d' }
  )
}
