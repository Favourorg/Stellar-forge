const isProd = import.meta.env.PROD

export const logger = {
  error(message: string, error?: unknown): void {
    if (!isProd) {
      console.error(message, error)
    }
    // Forward to Sentry or other monitoring when integrated
  },
}
