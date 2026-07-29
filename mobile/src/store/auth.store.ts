import { create } from 'zustand'
import { setToken, clearToken, saveUser } from '../api/client'

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
  },

  clearAuth: () => {
    clearToken()
    set({ user: null, isAuthenticated: false })
  },
}))
