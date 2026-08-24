/**
 * Maps Soroban contract error codes to user-friendly messages.
 * Codes correspond to the Error enum in the token-factory contract.
 */
export const CONTRACT_ERROR_MESSAGES: Record<number, string> = {
  1: 'Insufficient fee payment. Please increase the fee amount.',
  2: 'Unauthorized. You do not have permission to perform this action.',
  3: 'Invalid parameters provided.',
  4: 'Token not found.',
  5: 'Metadata has already been set for this token.',
  6: 'Contract is already initialized.',
  7: 'Burn amount exceeds your token balance.',
  8: 'Burning is not enabled for this token.',
  9: 'Invalid burn amount. Must be greater than zero.',
  10: 'Contract is paused. Please try again later.',
  11: 'A concurrent operation is in progress. Please try again in a moment.',
  12: 'Arithmetic overflow. One of the amounts provided is too large.',
  13: 'Contract state not found. The factory may not be initialized.',
  // Fault classes below are normalized to one code each across both the
  // single (`create_token`) and batch (`create_tokens_batch`) creation paths.
  14: 'Invalid token name or symbol. Name must be 1–32 and symbol 1–12 characters.',
  15: 'Invalid decimals. Must be between 0 and 18.',
  16: 'Mint would exceed the token’s maximum supply.',
  17: 'Invalid fee split. The basis points must sum to 10,000.',
  18: 'Too many fee split recipients.',
  19: 'Supply back-fill has already been applied to this token.',
  20: 'Your address is not on the whitelist for token creation.',
  21: 'Invalid metadata URI. It must be a non-empty ipfs:// URI within the length limit.',
  22: 'Fee split contains a recipient with a zero share.',
  23: 'Metadata is frozen and can no longer be updated.',
}

/**
 * Look up a human-readable message for a contract error code.
 * Returns undefined for codes that are not in the known set.
 */
export function getContractErrorMessage(code: number): string | undefined {
  return CONTRACT_ERROR_MESSAGES[code]
}

/**
 * Extract the contract error code from a TransactionResult XDR by navigating
 * the typed accessors, instead of serialising the result to opaque base64.
 *
 * Returns the numeric error code, or undefined if the result does not
 * represent a contract error.
 */
export function extractContractErrorCode(
  result: unknown,
): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { xdr } = require('stellar-sdk') as {
      xdr: {
        TransactionResultCode: { txFailed(): { name: string } }
        OperationType: { invokeHostFunction(): { name: string } }
        InvokeHostFunctionResultCode: { invokeHostFunctionTrapped(): { name: string } }
        ScErrorType: { sceContract(): { name: string } }
      }
    }

    const txResult = result as {
      result(): { switch(): { name: string }; results(): unknown[] }
    }
    const resultResult = txResult.result()
    if (resultResult.switch() !== xdr.TransactionResultCode.txFailed()) return undefined

    const ops = resultResult.results() as {
      tr(): {
        switch(): { name: string }
        invokeHostFunctionResult(): {
          switch(): { name: string }
          value(): { switch(): { name: string }; contractCode(): number }
        }
      }
    }[]
    if (!ops || ops.length === 0) return undefined

    const opTr = ops[0].tr()
    if (opTr.switch() !== xdr.OperationType.invokeHostFunction()) return undefined

    const ihf = opTr.invokeHostFunctionResult()
    if (ihf.switch() !== xdr.InvokeHostFunctionResultCode.invokeHostFunctionTrapped()) return undefined

    const scError = ihf.value() as { switch(): { name: string }; contractCode(): number }
    if (scError.switch() !== xdr.ScErrorType.sceContract()) return undefined

    const code = scError.contractCode()
    return typeof code === 'number' ? code : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse a TransactionResult XDR and return the human-readable error message
 * for a known contract error, or a generic fallback if the error cannot be
 * decoded.
 *
 * Returns an object with both the plain message and the contract error code
 * (when available) so callers can decide whether the error is a deterministic
 * contract-logic rejection (not safe to blind-retry) vs a generic failure.
 */
export function parseTransactionResultError(
  result: unknown,
): { message: string; contractErrorCode: number | undefined } {
  try {
    const code = extractContractErrorCode(result)
    if (code !== undefined) {
      const msg = getContractErrorMessage(code)
      if (msg) {
        return { message: msg, contractErrorCode: code }
      }
      return { message: `An unexpected contract error occurred (code ${code}).`, contractErrorCode: code }
    }
  } catch {
    // Fall through to the generic message.
  }
  return { message: 'The network rejected the transaction.', contractErrorCode: undefined }
}

/**
 * Parses a raw contract error into a human-readable Error.
 * Soroban contract errors surface as "Error(Contract, X)" in result XDR.
 * Unknown codes fall back to a generic message.
 */
export function parseContractError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)

  // User rejected the transaction in Freighter
  if (
    msg.toLowerCase().includes('user declined') ||
    msg.toLowerCase().includes('user rejected') ||
    msg.toLowerCase().includes('rejected by user')
  ) {
    return new Error('Transaction rejected. You declined the signing request in your wallet.')
  }

  // Insufficient XLM to cover fees
  if (
    msg.toLowerCase().includes('insufficient') ||
    msg.toLowerCase().includes('op_underfunded') ||
    msg.toLowerCase().includes('balance')
  ) {
    return new Error('Insufficient funds. Your XLM balance is too low to cover this transaction.')
  }

  // Rate limiting / 429
  if (
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('too many requests') ||
    msg.toLowerCase().includes('http error 429') ||
    msg.toLowerCase().includes('status 429')
  ) {
    return new Error(
      'The server is currently rate-limiting requests. Please wait a moment and try again. ' +
        'If this persists, consider using a dedicated RPC provider.',
    )
  }

  // Network / RPC timeout
  if (
    msg.toLowerCase().includes('timeout') ||
    msg.toLowerCase().includes('timed out') ||
    msg.toLowerCase().includes('network')
  ) {
    return new Error('Network timeout. The Stellar network did not respond in time. Please retry.')
  }

  const match = msg.match(/Error\(Contract,\s*(\d+)\)/)
  if (match?.[1]) {
    const code = parseInt(match[1], 10)
    return new Error(
      getContractErrorMessage(code) ?? `An unexpected contract error occurred (code ${code}).`,
    )
  }

  if (msg.includes('simulation')) return new Error(`Simulation failed: ${msg}`)

  return err instanceof Error ? err : new Error(msg)
}