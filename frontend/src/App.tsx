import './App.css'
import type { ReactElement } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useDarkMode } from './hooks/useDarkMode'
import { WalletProvider } from './context/WalletContext'
import { ToastProvider, useToast } from './context/ToastContext'
import { NetworkProvider } from './context/NetworkContext'
import { ToastContainer } from './components/UI/ToastContainer'
import { NetworkSwitcher } from './components/NetworkSwitcher'
import { useWallet } from './hooks/useWallet'
import { Button } from './components/UI/Button'
import { Spinner } from './components/UI/Spinner'
import { truncateAddress, formatXLM } from './utils/formatting'
import { NavBar } from './components/NavBar'
import { Home } from './components/Home'
import { CreateToken } from './components/CreateToken'
import { MintForm } from './components/MintForm'
import { BurnForm } from './components/BurnForm'
import { Dashboard } from './components/Dashboard'
import { TokenDetail } from './components/TokenDetail'
import { TokenExplorer } from './components/TokenExplorer'

const ProtectedRoute: React.FC<{ children: ReactElement }> = ({ children }) => {
  const { wallet } = useWallet()

  if (!wallet.isConnected) {
    return <Navigate to="/" replace />
  }

  return children
}

function AppContent() {
  const [dark, setDark] = useDarkMode()
  const { wallet, connect, disconnect, isConnecting, error, isInstalled } = useWallet()
  const { addToast } = useToast()

  const handleGetStarted = () => addToast("Welcome! Let's deploy your token.", 'info')

  const handleConnect = async () => {
    try {
      await connect()
      if (!error) addToast('Wallet connected', 'success')
    } catch {
      addToast('Failed to connect wallet', 'error')
    }
  }

  const handleDisconnect = () => {
    disconnect()
    addToast('Wallet disconnected', 'info')
  }

  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-blue-600 focus:text-white focus:rounded"
      >
        Skip to main content
      </a>

      <div className="min-h-screen bg-gray-100 dark:bg-gray-900">
        <header className="bg-white dark:bg-gray-800 shadow" role="banner">
          <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-white">StellarForge</h1>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Stellar Token Deployer</p>
              </div>

              <div className="flex items-center gap-4">
                <button
                  onClick={() => setDark(!dark)}
                  aria-label="Toggle dark mode"
                  className="p-2 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {dark ? (
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                    </svg>
                  )}
                </button>

                <NetworkSwitcher />

                {!isInstalled && (
                  <a
                    href="https://www.freighter.app/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-600 hover:text-blue-800 underline"
                  >
                    Install Freighter
                  </a>
                )}

                {wallet.isConnected ? (
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {wallet.address && truncateAddress(wallet.address)}
                      </div>
                      {wallet.balance && (
                        <div className="text-xs text-gray-600 dark:text-gray-400">{formatXLM(wallet.balance)}</div>
                      )}
                    </div>
                    <Button onClick={handleDisconnect} variant="secondary" size="sm">
                      Disconnect
                    </Button>
                  </div>
                ) : (
                  <Button onClick={handleConnect} disabled={isConnecting} size="sm">
                    {isConnecting ? (
                      <span className="flex items-center gap-2">
                        <Spinner size="sm" />
                        Connecting...
                      </span>
                    ) : (
                      'Connect Wallet'
                    )}
                  </Button>
                )}
              </div>
            </div>

            <NavBar />
          </div>
        </header>

        <main id="main-content" className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            {error && (
              <div
                className="mb-4 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 px-4 py-3 rounded-lg"
                role="alert"
              >
                <p className="font-medium">Error</p>
                <p className="text-sm">{error}</p>
              </div>
            )}

            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-sm">
              <Routes>
                <Route path="/" element={<Home onGetStarted={handleGetStarted} />} />
                <Route path="/create" element={<ProtectedRoute><CreateToken /></ProtectedRoute>} />
                <Route path="/mint" element={<ProtectedRoute><MintForm /></ProtectedRoute>} />
                <Route path="/burn" element={<ProtectedRoute><BurnForm /></ProtectedRoute>} />
                <Route path="/tokens" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                <Route path="/tokens/:address" element={<ProtectedRoute><TokenDetail /></ProtectedRoute>} />
                <Route path="/explorer" element={<TokenExplorer />} />
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
    <NetworkProvider>
      <WalletProvider>
        <ToastProvider>
          <BrowserRouter>
            <AppContent />
          </BrowserRouter>
        </ToastProvider>
      </WalletProvider>
    </NetworkProvider>
  )
}

export default App
