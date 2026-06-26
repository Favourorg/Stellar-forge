import React, { createContext, useCallback, useContext, useEffect } from 'react'
import { useLocalStorage } from '../hooks/useLocalStorage'

interface DarkModeContextValue {
  isDarkMode: boolean
  toggleDarkMode: () => void
  setDarkMode: (isDark: boolean) => void
}

const DarkModeContext = createContext<DarkModeContextValue | null>(null)

const DARK_MODE_KEY = 'darkMode'

export const DarkModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isDarkMode, setIsDarkMode] = useLocalStorage<boolean>(
    DARK_MODE_KEY,
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  // Apply dark mode class to document
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }, [isDarkMode])

  // Listen for OS preference changes — only apply when there is no stored preference
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = (e: MediaQueryListEvent) => {
      const stored = window.localStorage.getItem(DARK_MODE_KEY)
      if (stored === null) {
        setIsDarkMode(e.matches)
      }
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [setIsDarkMode])

  const toggleDarkMode = useCallback(() => {
    setIsDarkMode((prev) => !prev)
  }, [setIsDarkMode])

  const setDarkMode = useCallback(
    (isDark: boolean) => {
      setIsDarkMode(isDark)
    },
    [setIsDarkMode],
  )

  return (
    <DarkModeContext.Provider value={{ isDarkMode, toggleDarkMode, setDarkMode }}>
      {children}
    </DarkModeContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useDarkMode = (): DarkModeContextValue => {
  const ctx = useContext(DarkModeContext)
  if (!ctx) throw new Error('useDarkMode must be used within a DarkModeProvider')
  return ctx
}
