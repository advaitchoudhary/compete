import { Alert, Platform } from 'react-native'

/**
 * Cross-platform confirm. React Native's Alert.alert is a no-op on
 * react-native-web, so we fall back to window.confirm there.
 */
export function confirm(
  title: string,
  message: string,
  onConfirm: () => void,
  confirmLabel = 'OK',
) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onConfirm()
  } else {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: confirmLabel, onPress: onConfirm },
    ])
  }
}

/** Cross-platform notify (web-safe alternative to Alert.alert with no buttons). */
export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(message ? `${title}\n\n${message}` : title)
  } else {
    Alert.alert(title, message)
  }
}
