/**
 * Push registration.
 *
 * A weekly-cadence product has no way to pull anyone back without push: a player
 * opens the app on match day and not otherwise. So this runs on every sign-in.
 *
 * Written to fail quietly. Notifications are a nice-to-have on top of signing in —
 * a denied permission, a simulator with no push support, or an unreachable Expo
 * service must never block someone getting into the app.
 */
import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { api } from '../api/client'

/** Show a banner even when the app is foregrounded — scores are time-sensitive. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
})

/**
 * Ask for permission, get the Expo token, hand it to the backend.
 * Returns the token when it worked, otherwise null. Never throws.
 */
export async function registerForPush(): Promise<string | null> {
  try {
    // A simulator cannot receive push, and asking there just produces noise.
    if (!Device.isDevice) return null

    const existing = await Notifications.getPermissionsAsync()
    let status = existing.status
    if (status !== 'granted') {
      // Only prompt if we have not been denied before — repeat prompts are a
      // no-op on iOS anyway and just annoy on Android.
      if (!existing.canAskAgain) return null
      status = (await Notifications.requestPermissionsAsync()).status
    }
    if (status !== 'granted') return null

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Match updates',
        importance: Notifications.AndroidImportance.DEFAULT,
      })
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync()
    if (!token) return null

    await api.post('/push/register', {
      token,
      platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web',
      device_id: Device.modelName ?? undefined,
    })

    return token
  } catch {
    // Deliberately silent — see the note above.
    return null
  }
}

/**
 * Drop this device's token on sign-out, so the next person to use the handset does
 * not receive the previous player's notifications.
 */
export async function unregisterPush(): Promise<void> {
  try {
    if (!Device.isDevice) return
    const { data: token } = await Notifications.getExpoPushTokenAsync()
    if (token) await api.delete('/push/register', { data: { token } })
  } catch {
    /* ignore */
  }
}
