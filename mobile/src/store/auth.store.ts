import { create } from 'zustand'
import { setToken, clearToken, saveUser } from '../api/client'
import { registerForPush, unregisterPush } from '../lib/push'

interface User {
  id: string
  name: string
  username: string | null
  avatar_url: string | null
  city: string | null
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  setAuth: (token: string, user: User) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,

  setAuth: (token, user) => {
    setToken(token)
    saveUser(user)
    set({ user, isAuthenticated: true })
    // Fire-and-forget: push is a nice-to-have on top of signing in, and
    // registerForPush never throws. Awaiting it would make a permission prompt or
    // an unreachable Expo service delay getting into the app.
    void registerForPush()
  },

  clearAuth: () => {
    // Drop the device token BEFORE clearing the JWT — the DELETE needs to be
    // authenticated to prove the token belongs to this user.
    void unregisterPush().finally(() => {
      clearToken()
      set({ user: null, isAuthenticated: false })
    })
  },
}))
