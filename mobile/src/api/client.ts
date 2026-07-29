import axios from 'axios'
import AsyncStorage from '@react-native-async-storage/async-storage'

export const BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/v1'

// In-memory token — populated from AsyncStorage on app start via loadToken()
let _token: string | null = null

export async function loadToken(): Promise<void> {
  _token = await AsyncStorage.getItem('access_token')
}

export function setToken(token: string): void {
  _token = token
  AsyncStorage.setItem('access_token', token)
}

export function clearToken(): void {
  _token = null
  AsyncStorage.removeItem('access_token')
  AsyncStorage.removeItem('auth_user')
}

// Persist / restore the user object across reloads
export function saveUser(user: object): void {
  AsyncStorage.setItem('auth_user', JSON.stringify(user))
}

export async function loadUser(): Promise<any | null> {
  const raw = await AsyncStorage.getItem('auth_user')
  return raw ? JSON.parse(raw) : null
}

export function getToken(): string | null {
  return _token
}

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT on every request
api.interceptors.request.use((config) => {
  if (_token) {
    config.headers.Authorization = `Bearer ${_token}`
  }
  return config
})

// Handle 401 → clear token
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      clearToken()
    }
    return Promise.reject(error)
  }
)
