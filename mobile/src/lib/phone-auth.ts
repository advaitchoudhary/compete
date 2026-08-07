/**
 * Phone sign-in — the only module in the app that knows Firebase exists.
 *
 * The screen asks for a confirmation object and later a code; how the OTP is
 * actually obtained stays behind this boundary. That matters because the two
 * runtimes need genuinely different implementations:
 *
 *   web        — the Firebase JS SDK with a reCAPTCHA verifier, which needs a DOM
 *                node to mount into.
 *   native     — no DOM, so RecaptchaVerifier cannot exist. A real build wants
 *                @react-native-firebase/auth, which requires a custom dev client
 *                (it cannot run in Expo Go).
 *
 * Keeping that split here means swapping in the native SDK later touches this
 * file and nothing else — the auth screen, the store and /auth/verify are all
 * unaffected.
 *
 * The config values are deliberately public: a Firebase web apiKey ships inside
 * every client bundle and identifies the project rather than authorising anything.
 * Access is controlled by the provider being enabled and by backend verification
 * of the resulting ID token, which is what /auth/verify does.
 */
import { Platform } from 'react-native'
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import {
  getAuth,
  signInWithPhoneNumber,
  RecaptchaVerifier,
  type Auth,
  type ConfirmationResult,
} from 'firebase/auth'

const config = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
}

export const isPhoneAuthConfigured = Boolean(config.apiKey && config.projectId)

/** Native needs a custom dev client; Expo Go cannot do phone auth at all. */
export const isPhoneAuthSupported = Platform.OS === 'web' && isPhoneAuthConfigured

let app: FirebaseApp | undefined
let verifier: RecaptchaVerifier | undefined

function auth(): Auth {
  app ??= getApps().length ? getApps()[0] : initializeApp(config as Required<typeof config>)
  const instance = getAuth(app)

  // Skip app verification when driving the flow from a test harness.
  //
  // reCAPTCHA cannot complete in headless Chrome, which makes the sign-in
  // untestable end to end. Firebase provides this switch for exactly that, and it
  // only has any effect for phone numbers registered as test numbers in the
  // console — a real number still goes through full verification. Double-gated on
  // __DEV__ so it cannot survive into a production bundle.
  if (__DEV__ && process.env.EXPO_PUBLIC_FIREBASE_DISABLE_APP_VERIFICATION === 'true') {
    instance.settings.appVerificationDisabledForTesting = true
  }
  return instance
}

/**
 * An invisible reCAPTCHA, mounted once and reused.
 *
 * Firebase requires a verifier even for test numbers — it resolves without any
 * user interaction for those, but refuses to start the flow if it is absent. The
 * container is created here rather than rendered by the screen so that a React
 * re-render can never unmount the node Firebase is holding a reference to.
 */
function recaptcha(): RecaptchaVerifier {
  if (verifier) return verifier
  const id = 'firebase-recaptcha-container'
  if (typeof document !== 'undefined' && !document.getElementById(id)) {
    const el = document.createElement('div')
    el.id = id
    document.body.appendChild(el)
  }
  verifier = new RecaptchaVerifier(auth(), id, { size: 'invisible' })
  return verifier
}

export interface PendingVerification {
  /** Exchange the code the user typed for a Firebase ID token. */
  confirm(code: string): Promise<string>
}

/** How many digits a local subscriber number has. India: 10. */
export const LOCAL_PHONE_DIGITS = 10

/**
 * Reduce anything a person might type or paste to the bare local digits.
 *
 * People paste `+91 98765 43210`, type a leading 0 out of habit, or copy a number
 * with spaces in it. A plain `maxLength={10}` on the raw string counts characters
 * rather than digits, so `+919876543210` was being truncated to `+919876543` and
 * sent as a real number — the field looked full, the button went live, and
 * Firebase rejected a number the person never entered.
 */
export function normalisePhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  // Pasted with the country code.
  if (digits.length > LOCAL_PHONE_DIGITS && digits.startsWith('91')) digits = digits.slice(2)
  // A leading 0 is a domestic trunk prefix, not part of the number.
  digits = digits.replace(/^0+/, '')
  return digits.slice(0, LOCAL_PHONE_DIGITS)
}

export const isCompletePhone = (raw: string) =>
  normalisePhoneInput(raw).length === LOCAL_PHONE_DIGITS

/** Normalise what someone types into the E.164 form Firebase requires. */
export function toE164(raw: string, defaultCountry = '+91'): string {
  const trimmed = raw.replace(/[\s\-()]/g, '')
  if (trimmed.startsWith('+')) return trimmed
  return defaultCountry + normalisePhoneInput(trimmed)
}

/**
 * Send an OTP. Resolves once the code is on its way — or immediately, for a test
 * number, which Firebase answers without sending anything.
 */
export async function sendOtp(phone: string): Promise<PendingVerification> {
  if (!isPhoneAuthConfigured) {
    throw new Error('Phone sign-in is not configured — EXPO_PUBLIC_FIREBASE_* is missing.')
  }
  if (Platform.OS !== 'web') {
    throw new Error(
      'Phone sign-in needs a custom dev build on this platform. Use the web build for now.'
    )
  }

  const confirmation: ConfirmationResult = await signInWithPhoneNumber(
    auth(),
    toE164(phone),
    recaptcha()
  )

  return {
    async confirm(code: string) {
      const credential = await confirmation.confirm(code)
      const token = await credential.user.getIdToken()
      if (!token) throw new Error('Signed in but no ID token was returned.')
      return token
    },
  }
}

/**
 * Firebase error codes are machine-readable and useless on screen. Map the ones a
 * person can actually act on; pass anything else through rather than swallowing
 * a diagnostic we have not seen yet.
 */
export function phoneAuthMessage(e: unknown): string {
  const code = (e as { code?: string })?.code ?? ''
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'That does not look like a valid phone number.'
    case 'auth/invalid-verification-code':
      return 'That code is not right. Check it and try again.'
    case 'auth/code-expired':
      return 'That code has expired. Request a new one.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.'
    case 'auth/quota-exceeded':
      return 'The daily SMS limit for this project has been reached.'
    case 'auth/operation-not-allowed':
      return 'Phone sign-in is not enabled on this Firebase project.'
    default:
      return (e as Error)?.message ?? 'Could not sign in. Try again.'
  }
}
