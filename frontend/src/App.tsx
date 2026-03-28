<<<<<<< Updated upstream
import React from 'react'
=======
import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
>>>>>>> Stashed changes
import { ToastContainer, Button, Spinner } from './components/UI'
import './App.css'
import { useTranslation } from 'react-i18next'
import { useDarkMode } from './hooks/useDarkMode'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider, useToast } from './context/ToastContext'
<<<<<<< Updated upstream
import { NetworkProvider } from './context/NetworkContext'
=======
import { NetworkProvider, useNetwork } from './context/NetworkContext'
>>>>>>> Stashed changes
import { StellarProvider } from './context/StellarContext'
import { NetworkSwitcher } from './components/NetworkSwitcher'
import { LanguageSwitcher } from './components/LanguageSwitcher'
import { FundbotButton } from './components/FundbotButton'
import { useWallet } from './hooks/useWallet'
import { truncateAddress, formatXLM } from './utils/formatting'
import { NavBar } from './components/NavBar'
import { Home } from './components/Home'
import { CreateToken } from './components/CreateToken'
import { MintForm } from './components/MintForm'
import { BurnForm } from './components/BurnForm'
import { Dashboard } from './components/Dashboard'
import { TokenDetail } from './components/TokenDetail'
import { FAQ } from './components/FAQ'
import { isFactoryConfigured } from './config/env'
import ErrorBoundary from './components/ErrorBoundary'
import { TosProvider } from './context/TosContext'
<<<<<<< Updated upstream
import { useState } from 'react'
=======
import { useFactoryState } from './hooks/useFactoryState'

// Minimum XLM (in stroops) required to cover the base transaction fee.
// We warn when the wallet balance drops below the factory's baseFee.
const STROOPS_PER_XLM = 10_000_000
>>>>>>> Stashed changes

const ProtectedRoute: React.FC<{ children: React.ReactElement }> = ({ children }) => {
  const { wallet } = useWallet()
  if (!wallet.isConnected) return <Navigate to="/" replace />
  return children
}

function AppContent() {
  const { wallet, connect, disconnect, isConnecting, error, isInstalled } = useWallet()
  const { addToast } = useToast()
  const { t } = useTranslation()
<<<<<<< Updated upstream
  const [showOnboarding, setShowOnboarding] = useState(false)
=======
  const { network } = useNetwork()
  const { state: factoryState } = useFactoryState()
  const [showBanner, setShowBanner] = useState(true)
>>>>>>> Stashed changes

  // Show low-balance warning when connected balance is below the factory baseFee.
  // Falls back to 1 XLM (10_000_000 stroops) if factory state hasn't loaded yet.
  const baseFeeStroops = factoryState ? BigInt(factoryState.baseFee) : BigInt(STROOPS_PER_XLM)
  const balanceStroops = wallet.balance
    ? BigInt(Math.floor(parseFloat(wallet.balance) * STROOPS_PER_XLM))
    : null

  const isBalanceLow =
    wallet.isConnected &&
    balanceStroops !== null &&
    balanceStroops < baseFeeStroops

  const showFriendbotBanner = isBalanceLow && showBanner && network === 'testnet'
  const showLowBalanceWarning = isBalanceLow && network === 'mainnet'

  const handleConnect = async () => {
    try {
      await connect()
      if (!error) addToast(t('wallet.connected'), 'success')
    } catch {
      addToast(t('wallet.connectFailed'), 'error')
    }
  }

  const handleDisconnect = () => {
    disconnect()
    addToast(t('wallet.disconnected'), 'info')
  }

  const handleGetStarted = () => addToast(t('home.welcomeToast'), 'info')

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded"
      >
        {t('app.skipToMain')}
      </a>

<div className="min-h-screen bg-gray-100 dark:bg-slate-900">
  <header className="bg-white/80 shadow-lg backdrop-blur-sm dark:bg-slate-800/95 dark:shadow-slate-900/50 dark:border-b dark:border-slate-700" role="banner">
          <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('app.title')}</h1>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{t('app.subtitle')}</p>
              </div>

              <div className="flex items-center gap-4">
                <LanguageSwitcher />
                <NetworkSwitcher />
                <Button 
                  onClick={() => setDark(!dark)} 
                  variant="secondary" 
                  size="sm" 
                  className="shrink-0 p-2 rounded-full"
                  aria-label="Toggle dark mode"
                >
                  {dark ? '☀️' : '🌙'}
                </Button>

                {!isInstalled && (
                  <a
                    href="https://www.freighter.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:text-blue-800 underline"
                  >
                    {t('wallet.installFreighter')}
                  </a>
                )}

                {wallet.isConnected ? (
                  <div className="flex items-center gap-3">
                    <FundbotButton />
                    <div className="text-right">
                      <div
                        className="text-sm font-medium text-gray-900"
                        title={wallet.address ?? undefined}
                      >
                        {wallet.address && truncateAddress(wallet.address)}
                      </div>
<<<<<<< Updated upstream
                      <Button onClick={handleDisconnect} variant="secondary" size="sm">
                        {t('wallet.disconnect')}
                      </Button>
=======
                      {wallet.balance !== undefined ? (
                        <div
                          className={`text-xs font-medium ${
                            isBalanceLow ? 'text-amber-600' : 'text-gray-500'
                          }`}
                          aria-label={`XLM balance: ${formatXLM(wallet.balance ?? '0')}`}
                        >
                          {formatXLM(wallet.balance ?? '0')}
                          {isBalanceLow && (
                            <span
                              className="ml-1"
                              role="img"
                              aria-label="Low balance warning"
                              title={t('wallet.lowBalance')}
                            >
                              ⚠️
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-400">{t('wallet.loadingBalance')}</div>
                      )}
>>>>>>> Stashed changes
                    </div>
                  </div>
                ) : (
                  <Button onClick={handleConnect} disabled={isConnecting} size="sm">
                    {isConnecting ? (
                      <span className="flex items-center gap-2">
                        <Spinner size="sm" />
                        <span className="hidden sm:inline">{t('wallet.connecting')}</span>
                      </span>
                    ) : (
                      t('wallet.connect')
                    )}
                  </Button>
                )}
              </div>
            </div>

            {wallet.isConnected && wallet.address && (
              <div className="sm:hidden text-xs text-gray-600 truncate" title={wallet.address}>
                {truncateAddress(wallet.address)}
                {wallet.balance && <span className="ml-2">{formatXLM(wallet.balance)}</span>}
              </div>
            )}

            {!isInstalled && (
              <a
                href="https://www.freighter.app/"
                target="_blank"
                rel="noopener noreferrer"
                className="sm:hidden text-xs text-blue-600 hover:text-blue-800 underline"
              >
                {t('wallet.installFreighter')}
              </a>
            )}

            <NavBar onHelpClick={() => setShowOnboarding(true)} />
          </div>
        </header>
<<<<<<< Updated upstream
        {showOnboarding && null /* OnboardingModal placeholder */}
=======

        {/* Testnet: low balance — offer Friendbot */}
        {showFriendbotBanner && (
          <div className="bg-amber-50 border-b border-amber-200 p-4" role="alert">
            <div className="max-w-7xl mx-auto flex items-center justify-between">
              <div className="text-amber-800 text-sm">
                ⚠️ {t('wallet.lowBalanceTestnet')}{' '}
                <a
                  href={`https://friendbot.stellar.org/?addr=${wallet.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold underline"
                >
                  Friendbot
                </a>
                .
              </div>
              <button
                onClick={() => setShowBanner(false)}
                className="text-amber-600 hover:text-amber-800 focus:outline-none ml-4"
                aria-label="Dismiss banner"
              >
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </div>
        )}
>>>>>>> Stashed changes

        {/* Mainnet: low balance — just warn */}
        {showLowBalanceWarning && (
          <div className="bg-amber-50 border-b border-amber-200 p-4" role="alert">
            <div className="max-w-7xl mx-auto text-amber-800 text-sm">
              ⚠️ {t('wallet.lowBalanceMainnet')}
            </div>
          </div>
        )}

        {!isFactoryConfigured() && (
          <div className="bg-yellow-50 border-b border-yellow-300 p-4" role="alert">
            <div className="max-w-7xl mx-auto text-yellow-800 text-sm font-medium">
              ⚠️ Factory contract not configured. Please set{' '}
              <code className="font-mono bg-yellow-100 px-1 rounded">VITE_FACTORY_CONTRACT_ID</code>{' '}
              in your <code className="font-mono bg-yellow-100 px-1 rounded">.env</code> file.
            </div>
          </div>
        )}

        <main id="main-content" className="max-w-7xl mx-auto py-4 sm:py-6 px-4 sm:px-6 lg:px-8">
          <div className="py-2 sm:py-4">
            {error && (
              <div
                className="mb-4 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg"
                role="alert"
              >
                <p className="font-medium">{t('errors.title')}</p>
                <p className="text-sm">{error}</p>
              </div>
            )}

            <div className="bg-white p-4 sm:p-6 rounded-lg shadow-sm">
              <Routes>
                <Route
                  path="/"
                  element={
                    <ErrorBoundary>
                      <Home onGetStarted={handleGetStarted} />
                    </ErrorBoundary>
                  }
                />
                <Route
                  path="/create"
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <CreateToken />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/mint"
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <MintForm />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/burn"
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <BurnForm />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/tokens"
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <Dashboard />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route
                  path="/tokens/:address"
                  element={
                    <ProtectedRoute>
                      <ErrorBoundary>
                        <TokenDetail />
                      </ErrorBoundary>
                    </ProtectedRoute>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </div>
          </div>
        </main>

        <ToastContainer />
      </div>
    </>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <NetworkProvider>
          <StellarProvider>
            <WalletProvider>
              <ToastProvider>
                <TosProvider>
                  <AppContent />
                </TosProvider>
              </ToastProvider>
            </WalletProvider>
          </StellarProvider>
        </NetworkProvider>
      </BrowserRouter>
    </ErrorBoundary>
  )
}

export default App
