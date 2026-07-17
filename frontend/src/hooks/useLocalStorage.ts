import { useState, useCallback, useEffect } from 'react'

/**
 * A reusable hook for persisting state in localStorage.
 * Handles JSON serialization/deserialization, localStorage unavailability,
 * and cross-tab synchronization.
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Pass initial state function to useState so logic is only executed once
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key)
      return item ? (JSON.parse(item) as T) : defaultValue
    } catch {
      // localStorage read failure — fall back to defaultValue silently
      return defaultValue
    }
  })

  // Return a wrapped version of useState's setter function that
  // persists the new value to localStorage.
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prevValue: T) => {
        const valueToStore = value instanceof Function ? value(prevValue) : value
        try {
          window.localStorage.setItem(key, JSON.stringify(valueToStore))
        } catch (error) {
          // localStorage write failure (quota exceeded, unavailable, etc.) —
          // keep the in-memory value but don't let it crash the render.
          console.warn(`[useLocalStorage] Error setting key "${key}":`, error)
        }
        return valueToStore
      })
    },
    [key],
  )

  // Listen for changes from other tabs to keep sync
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          setStoredValue(JSON.parse(e.newValue) as T)
        } catch {
          /* ignore parse errors */
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [key])

  return [storedValue, setValue]
}
