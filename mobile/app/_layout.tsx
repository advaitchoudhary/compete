import { useEffect, useState } from 'react'
import { View, ActivityIndicator } from 'react-native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import {
  useFonts,
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans'
import { useAuthStore } from '../src/store/auth.store'
import { loadToken, loadUser, getToken } from '../src/api/client'
import { C } from '../src/theme'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
})

function AuthGuard() {
  const { isAuthenticated, setAuth } = useAuthStore()
  const segments = useSegments()
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    Promise.all([loadToken(), loadUser()]).then(([, savedUser]) => {
      const token = getToken()
      // Restore full session: if we have both a token and a saved user object,
      // re-hydrate the auth store so every screen has access to user.name etc.
      if (token && savedUser && !isAuthenticated) {
        setAuth(token, savedUser)
      }
      setReady(true)
    })
  }, [])

  useEffect(() => {
    if (!ready) return
    const inAuthGroup = segments[0] === 'auth'
    const hasToken = !!getToken()

    // The public tournament page is the acquisition surface — a spectator with no
    // account must be able to open the link. Bouncing it to /auth would defeat
    // the entire point, so it is exempt from the guard.
    // Both public entry points: the tournament page a spectator opens, and the
    // claim link a guest opens. Neither has a session yet, so bouncing them to
    // /auth would defeat the entire acquisition loop.
    if (segments[0] === 'e' || segments[0] === 'claim') return

    // The dev-only component preview signs itself in, so the guard must not
    // bounce it to /auth first. Never reachable in a production build.
    if (__DEV__ && segments[0] === 'dev-preview') return

    if (!hasToken && !isAuthenticated && !inAuthGroup) {
      router.replace('/auth')
    } else if ((hasToken || isAuthenticated) && inAuthGroup) {
      router.replace('/(tabs)')
    }
  }, [ready, isAuthenticated, segments])

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={C.lime} size="large" />
      </View>
    )
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="create-tournament" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="create-match"      options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="referee-apply"     options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="admin"             options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="tournament/[id]"   options={{ animation: 'slide_from_right' }} />
      {/* Organizer control room — create → referees → grade → sign-ups → bracket. */}
      <Stack.Screen name="organizer/index"          options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="organizer/[id]"           options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="organizer/referees/[id]"  options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="match/[id]"        options={{ animation: 'slide_from_right' }} />
      {/* Public, unauthenticated tournament page — shared with spectators. */}
      <Stack.Screen name="e/[id]"            options={{ animation: 'fade' }} />
      {/* Public guest-claim link, opened from WhatsApp. */}
      <Stack.Screen name="claim"             options={{ animation: 'fade' }} />
      <Stack.Screen name="form-tracker"      options={{ animation: 'slide_from_right' }} />
    </Stack>
  )
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  })

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={C.lime} size="large" />
      </View>
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <AuthGuard />
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </QueryClientProvider>
  )
}
